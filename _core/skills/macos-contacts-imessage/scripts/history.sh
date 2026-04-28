#!/usr/bin/env bash
# history.sh -- read ~/Library/Messages/chat.db via sqlite3 (read-only)
# Usage:
#   history.sh chats   [--limit N]                                [--json]
#   history.sh history --handle <phone-or-email> [--limit N] [--since-rowid N] [--json]
#   history.sh watch   --handle <phone-or-email>  --since-rowid N                [--json]
#
# Handle matching: substring on handle.id OR chat.chat_identifier OR chat.display_name.
# This lets callers pass a raw phone, an email, or a chat name.
#
# Dates are Apple-epoch nanoseconds. Converted to local ISO-8601 via SQLite datetime().
# Requires Full Disk Access for the calling terminal (see references/macos-permissions.md).

set -euo pipefail

die() { echo "history.sh: $*" >&2; exit 2; }

DB="$HOME/Library/Messages/chat.db"
[[ -f "$DB" ]] || die "chat.db not found at $DB"

cmd="${1:-}"; shift || true
[[ -z "$cmd" ]] && die "missing subcommand (chats|history|watch)"

HANDLE=""; LIMIT=""; SINCE_ROWID=""; JSON=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --handle)      HANDLE="$2"; shift 2 ;;
    --limit)       LIMIT="$2"; shift 2 ;;
    --since-rowid) SINCE_ROWID="$2"; shift 2 ;;
    --json)        JSON=1; shift ;;
    *) die "unknown flag: $1" ;;
  esac
done

# Build sqlite3 flags. Mode is -json when requested, else -header -separator $'\t'.
SQL_FLAGS=(-readonly)
if [[ $JSON -eq 1 ]]; then
  SQL_FLAGS+=(-json)
else
  SQL_FLAGS+=(-header -separator $'\t')
fi

run_sql() {
  local sql="$1"; shift
  # Remaining args become bound parameters via .param command.
  # sqlite3 parameter binding uses ? in the SQL and .param set.
  local param_cmds=""
  local i=1
  for v in "$@"; do
    # Escape single quotes for sqlite .param set
    local esc_v="${v//\'/\'\'}"
    param_cmds+=".param set :p$i '$esc_v'"$'\n'
    i=$((i+1))
  done
  printf '%s%s\n' "$param_cmds" "$sql" | sqlite3 "${SQL_FLAGS[@]}" "$DB"
}

# Apple epoch conversion: (date / 1000000000) + 978307200 seconds.
# Many chat.db dates are already nanoseconds; some legacy rows are seconds.
# The divisor expression below handles both (if value < 1e12 treat as seconds).
DATE_EXPR="CASE WHEN m.date > 1000000000000 THEN datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') ELSE datetime(m.date + 978307200, 'unixepoch', 'localtime') END"

case "$cmd" in
  chats)
    LIMIT="${LIMIT:-25}"
    SQL="
SELECT
  c.ROWID                                      AS chat_id,
  c.guid                                       AS guid,
  c.chat_identifier                            AS identifier,
  COALESCE(c.display_name,'')                  AS display_name,
  CASE c.style WHEN 43 THEN 'group' ELSE 'direct' END AS style,
  (SELECT COUNT(*) FROM chat_message_join cmj2 WHERE cmj2.chat_id = c.ROWID) AS message_count,
  (SELECT $DATE_EXPR
     FROM message m
     JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
     WHERE cmj.chat_id = c.ROWID
     ORDER BY m.date DESC LIMIT 1)              AS last_ts
FROM chat c
WHERE EXISTS (SELECT 1 FROM chat_message_join cmj WHERE cmj.chat_id = c.ROWID)
ORDER BY last_ts DESC
LIMIT :p1;
"
    run_sql "$SQL" "$LIMIT"
    ;;

  history)
    [[ -z "$HANDLE" ]] && die "history requires --handle"
    LIMIT="${LIMIT:-100}"
    SINCE_ROWID="${SINCE_ROWID:-0}"
    SQL="
SELECT
  m.ROWID                                      AS rowid,
  $DATE_EXPR                                   AS ts,
  m.is_from_me                                 AS is_from_me,
  COALESCE(h.id,'')                            AS handle,
  m.service                                    AS service,
  COALESCE(m.text,'')                          AS text,
  CASE WHEN m.cache_has_attachments = 1 THEN 1 ELSE 0 END AS has_attachments
FROM message m
LEFT JOIN handle h              ON m.handle_id = h.ROWID
LEFT JOIN chat_message_join cmj ON m.ROWID     = cmj.message_id
LEFT JOIN chat c                ON cmj.chat_id = c.ROWID
WHERE m.ROWID > :p3
  AND (h.id               LIKE '%' || :p1 || '%'
       OR c.chat_identifier LIKE '%' || :p1 || '%'
       OR c.display_name    LIKE '%' || :p1 || '%')
ORDER BY m.date DESC
LIMIT :p2;
"
    run_sql "$SQL" "$HANDLE" "$LIMIT" "$SINCE_ROWID"
    ;;

  watch)
    [[ -z "$HANDLE" ]] && die "watch requires --handle"
    [[ -z "$SINCE_ROWID" ]] && die "watch requires --since-rowid (pass 0 for first run)"
    SQL="
SELECT
  m.ROWID                                      AS rowid,
  $DATE_EXPR                                   AS ts,
  m.is_from_me                                 AS is_from_me,
  COALESCE(h.id,'')                            AS handle,
  m.service                                    AS service,
  COALESCE(m.text,'')                          AS text,
  CASE WHEN m.cache_has_attachments = 1 THEN 1 ELSE 0 END AS has_attachments
FROM message m
LEFT JOIN handle h              ON m.handle_id = h.ROWID
LEFT JOIN chat_message_join cmj ON m.ROWID     = cmj.message_id
LEFT JOIN chat c                ON cmj.chat_id = c.ROWID
WHERE m.ROWID > :p2
  AND (h.id               LIKE '%' || :p1 || '%'
       OR c.chat_identifier LIKE '%' || :p1 || '%'
       OR c.display_name    LIKE '%' || :p1 || '%')
ORDER BY m.ROWID ASC;
"
    run_sql "$SQL" "$HANDLE" "$SINCE_ROWID"
    ;;

  *) die "unknown subcommand: $cmd" ;;
esac
