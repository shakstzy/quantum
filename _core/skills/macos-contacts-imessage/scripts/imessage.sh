#!/usr/bin/env bash
# imessage.sh -- Messages.app send with authoritative service detection.
#
# Service detection (--service auto, the default):
#   1. Run ids-query (private IDS.framework) against the handle.
#      - Reliable for Apple-ID emails (returns iMessage when registered).
#      - For phone numbers without an authenticated fromID, IDS returns SMS as
#        a cache-miss fallback. We do NOT trust that alone.
#   2. If IDS did not return iMessage, consult Messages.app directly via
#      AppleScript: find any existing chat with this handle and read the chat's
#      service type. This is the same signal Messages.app uses to route a new
#      message and covers iMessage, SMS, and RCS.
#   3. If neither resolved, refuse. Do not guess. Caller must pass --service
#      explicitly.
#
# Verification: osascript exit 0 means Messages.app accepted the handoff.
# We DO NOT read chat.db and DO NOT require Full Disk Access. Delivery beyond
# handoff is verifiable in Messages.app UI, not from this script.
#
# Usage:
#   imessage.sh send      --to <phone-or-email> --text "<body>"
#                         [--service auto|iMessage|SMS|RCS]   (default: auto)
#   imessage.sh send-file --to <phone-or-email> --file <abs-path>
#                         [--service auto|iMessage|SMS|RCS]   (default: auto)
#
# Emits final JSON on the last line of stdout:
#   {"handoff":"ok","service_used":"iMessage|SMS|RCS","detection":"ids|messages-chat|explicit"}
#
# Exit codes: 0 handoff ok; 2 arg error; 3 osascript error; 4 service-detection refused.

set -euo pipefail

die()  { echo "imessage.sh: $*" >&2; exit 2; }
warn() { echo "imessage.sh: $*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDS_QUERY_BIN="$SCRIPT_DIR/ids-query"
IDS_QUERY_SRC="$SCRIPT_DIR/ids-query.m"

# Auto-build the IDS query helper if missing or stale.
if [[ ! -x "$IDS_QUERY_BIN" || "$IDS_QUERY_SRC" -nt "$IDS_QUERY_BIN" ]]; then
  clang -fobjc-arc -framework Foundation -O2 -o "$IDS_QUERY_BIN" "$IDS_QUERY_SRC" >&2 \
    || die "failed to compile ids-query"
fi

cmd="${1:-}"; shift || true
[[ -z "$cmd" ]] && die "missing subcommand (send|send-file)"

TO=""; TEXT=""; FILE=""; SERVICE="auto"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)      TO="$2"; shift 2 ;;
    --text)    TEXT="$2"; shift 2 ;;
    --file)    FILE="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    *) die "unknown flag: $1" ;;
  esac
done

[[ -z "$TO" ]] && die "--to required"
case "$SERVICE" in auto|iMessage|SMS|RCS) ;; *) die "--service must be auto, iMessage, SMS, or RCS" ;; esac

# Digit-only tail of the phone for LIKE-style matching in AppleScript.
digits_tail() { printf '%s' "$1" | tr -d -c '0-9' | tail -c 10; }

# AppleScript escapes.
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# Ask IDS.framework via ids-query. Stdout JSON includes "service" = iMessage|SMS|unknown.
ids_service() {
  "$IDS_QUERY_BIN" "$TO" 2>/dev/null | sed -n 's/.*"service":"\([^"]*\)".*/\1/p'
}

# Consult Messages.app chat history for the handle's actual service binding.
# Returns iMessage, SMS, RCS, or empty string if no existing chat matches.
messages_chat_service() {
  local digits
  digits=$(digits_tail "$TO")
  local match="$TO"
  # For emails, match on the full string. For phones, match on the digit tail
  # to tolerate +1 / no-plus / punctuation variants.
  if [[ "$TO" != *"@"* && -n "$digits" ]]; then
    match="$digits"
  fi
  local esc_match
  esc_match=$(esc "$match")
  osascript 2>/dev/null <<OSA || true
tell application "Messages"
  set needle to "$esc_match"
  repeat with c in chats
    try
      set pList to participants of c
      repeat with p in pList
        set h to handle of p as string
        if h contains needle then
          return (service type of service of c) as string
        end if
      end repeat
    end try
  end repeat
  return ""
end tell
OSA
}

pick_service() {
  if [[ "$SERVICE" != "auto" ]]; then
    echo "$SERVICE|explicit"; return
  fi

  local ids msg
  ids=$(ids_service)
  if [[ "$ids" == "iMessage" ]]; then
    echo "iMessage|ids"; return
  fi

  msg=$(messages_chat_service)
  case "$msg" in
    iMessage|SMS|RCS) echo "$msg|messages-chat"; return ;;
  esac

  return 4  # not resolvable
}

# Send via an existing 1:1 chat. Works for iMessage, SMS, and RCS because
# Messages.app reuses the chat's existing service binding. The chat must
# already exist (this path is selected when detection=messages-chat).
send_via_chat() {
  local body_or_file="$1" kind="$2"  # kind: text|file
  local needle
  if [[ "$TO" == *"@"* ]]; then needle="$TO"
  else needle=$(digits_tail "$TO"); fi
  local esc_needle esc_val
  esc_needle=$(esc "$needle")
  esc_val=$(esc "$body_or_file")
  if [[ "$kind" == "file" ]]; then
    osascript <<OSA 2>&1
tell application "Messages"
  set needle to "$esc_needle"
  repeat with c in chats
    try
      if (count of participants of c) is 1 then
        set p to 1st participant of c
        if (handle of p as string) contains needle then
          send (POSIX file "$esc_val") to c
          return "ok"
        end if
      end if
    end try
  end repeat
  return "no-chat"
end tell
OSA
  else
    osascript <<OSA 2>&1
tell application "Messages"
  set needle to "$esc_needle"
  repeat with c in chats
    try
      if (count of participants of c) is 1 then
        set p to 1st participant of c
        if (handle of p as string) contains needle then
          send "$esc_val" to c
          return "ok"
        end if
      end if
    end try
  end repeat
  return "no-chat"
end tell
OSA
  fi
}

# Send via a fresh buddy-of-service binding. Required for first-time recipients
# (no existing chat) and works for iMessage and SMS. RCS sends require an
# existing chat; AppleScript does not permit "1st service whose service type = RCS".
send_via_buddy() {
  local svc="$1" body_or_file="$2" kind="$3"
  if [[ "$svc" == "RCS" ]]; then
    echo "RCS requires an existing chat; AppleScript cannot address the RCS service directly." >&2
    return 1
  fi
  local esc_to esc_val
  esc_to=$(esc "$TO")
  esc_val=$(esc "$body_or_file")
  if [[ "$kind" == "file" ]]; then
    osascript <<OSA 2>&1
tell application "Messages"
  set targetService to 1st service whose service type = $svc
  set targetBuddy to buddy "$esc_to" of targetService
  send (POSIX file "$esc_val") to targetBuddy
end tell
OSA
  else
    osascript <<OSA 2>&1
tell application "Messages"
  set targetService to 1st service whose service type = $svc
  set targetBuddy to buddy "$esc_to" of targetService
  send "$esc_val" to targetBuddy
end tell
OSA
  fi
}

# Dispatch based on detection source. chat-based send when we have history
# (handles iMessage/SMS/RCS uniformly); buddy-based send otherwise.
do_send() {
  local svc="$1" detection="$2" body_or_file="$3" kind="$4"
  if [[ "$detection" == "messages-chat" ]]; then
    send_via_chat "$body_or_file" "$kind"
  else
    send_via_buddy "$svc" "$body_or_file" "$kind"
  fi
}

case "$cmd" in
  send)
    [[ -z "$TEXT" ]] && die "--text required"

    if ! PICK=$(pick_service); then
      IDS=$(ids_service || true)
      MSG=$(messages_chat_service || true)
      cat >&2 <<EOF
imessage.sh: cannot resolve service for $TO.
  IDS result:            ${IDS:-(empty)}
  Messages chat history: ${MSG:-(no match)}
Pass --service iMessage|SMS|RCS explicitly if you know the right one.
EOF
      exit 4
    fi
    CHOSEN="${PICK%|*}"
    DETECTION="${PICK#*|}"

    cat <<EOF
Sending message:
  To:        $TO
  Service:   $CHOSEN ($DETECTION)
  Body:      $TEXT
EOF

    if ! ERR=$(do_send "$CHOSEN" "$DETECTION" "$TEXT" text 2>&1); then
      echo "osascript error: $ERR" >&2
      printf '{"handoff":"error","service_used":"%s","detection":"%s","error":"%s"}\n' \
        "$CHOSEN" "$DETECTION" "$(esc "$ERR")"
      exit 3
    fi

    printf '{"handoff":"ok","service_used":"%s","detection":"%s"}\n' "$CHOSEN" "$DETECTION"
    exit 0
    ;;

  send-file)
    [[ -z "$FILE" ]] && die "--file required"
    [[ -f "$FILE" ]] || die "file not found: $FILE"
    ABS_FILE=$(cd "$(dirname "$FILE")" && printf '%s/%s' "$(pwd)" "$(basename "$FILE")")

    if ! PICK=$(pick_service); then
      die "cannot resolve service for $TO (see 'send' error for details); pass --service explicitly"
    fi
    CHOSEN="${PICK%|*}"
    DETECTION="${PICK#*|}"

    cat <<EOF
Sending file:
  To:        $TO
  Service:   $CHOSEN ($DETECTION)
  File:      $ABS_FILE
EOF

    if ! ERR=$(do_send "$CHOSEN" "$DETECTION" "$ABS_FILE" file 2>&1); then
      echo "osascript error: $ERR" >&2
      printf '{"handoff":"error","service_used":"%s","detection":"%s","error":"%s"}\n' \
        "$CHOSEN" "$DETECTION" "$(esc "$ERR")"
      exit 3
    fi
    printf '{"handoff":"ok","service_used":"%s","detection":"%s","kind":"file"}\n' "$CHOSEN" "$DETECTION"
    ;;

  *) die "unknown subcommand: $cmd" ;;
esac
