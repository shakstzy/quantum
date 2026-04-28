#!/usr/bin/env bash
# quantum-graphify — periodic graphify refresh + conditional Claude lint
# Runs via launchd every 2h.
#
# IMPORTANT: this cron does NOT auto-bootstrap the graph. The /graphify skill
# stops to ask for a subfolder when total_files > 200 or total_words > 2M, and
# QUANTUM's raw/ corpus is far over both. The first full build is therefore a
# manual operation Adithya runs in an interactive Claude window:
#
#     cd /Users/shakstzy/QUANTUM
#     # in Claude:
#     /graphify <chosen-subfolder> --wiki --obsidian --obsidian-dir graphify-out/obsidian
#
# Once graphify-out/graph.json exists, this cron handles the cheap parts:
# AST refreshes, re-clustering, and (only when check-update flags it) a
# semantic re-extract via headless `claude -p` against the same scope the user
# originally bootstrapped.
set -uo pipefail

REPO="/Users/shakstzy/QUANTUM"
LOG="${HOME}/Library/Logs/quantum-graphify.log"
LOCK_DIR="/tmp/quantum-graphify.lock.d"
OBSIDIAN_DIR="graphify-out/obsidian"
SCOPE_FILE="graphify-out/.scope"          # path the user bootstrapped against
MAX_LOCK_AGE_SECONDS=7200                  # reap locks older than the launchd interval
CLAUDE_TOOLS="Read,Edit,Write,Glob,Grep,Bash,Agent,TodoWrite,WebFetch,WebSearch"
# macOS has no GNU `timeout` by default; we rely on --max-budget-usd as the ceiling
# and the lock-age reaper to break wedged runs.

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
log "tick"

# --- Lock with PID + age reaping -------------------------------------------
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_DIR/pid"
    return 0
  fi
  # Existing lock — check age + PID liveness.
  local pid age now
  pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo 0)"
  if [[ "$pid" -gt 0 ]] && kill -0 "$pid" 2>/dev/null; then
    log "lock held by live pid $pid, skip"
    return 1
  fi
  now=$(date +%s)
  age=$(( now - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo "$now") ))
  if (( age > MAX_LOCK_AGE_SECONDS )); then
    log "stale lock ($age s, pid $pid), reaping"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || { log "lock reap raced, skip"; return 1; }
    echo $$ > "$LOCK_DIR/pid"
    return 0
  fi
  log "fresh lock with dead pid $pid (age $age s), waiting"
  return 1
}

if ! acquire_lock; then
  exit 0
fi
trap 'rm -rf "$LOCK_DIR" 2>/dev/null || true' EXIT

cd "$REPO" 2>/dev/null || { log "repo missing: $REPO"; exit 1; }

# --- Bail if raw/ is empty (ignoring operational logs) ---------------------
if [[ -z "$(find raw -type f ! -name '.gitkeep' ! -path 'raw/.ingest-log/*' 2>/dev/null | head -1)" ]]; then
  log "raw/ empty (ignoring .ingest-log), nothing to graph"
  exit 0
fi

# --- No-graph-yet path: log a warning, exit. NO auto-bootstrap. ------------
if [[ ! -f graphify-out/graph.json ]]; then
  log "no existing graph.json — manual /graphify bootstrap required (see graphify-lint.sh header)"
  exit 0
fi

# Determine the scope the graph was bootstrapped against. Default to '.' if unset.
SCOPE="."
if [[ -f "$SCOPE_FILE" ]]; then
  SCOPE="$(cat "$SCOPE_FILE" | tr -d '[:space:]')"
fi
log "scope: $SCOPE"

# --- Free CLI ops on the existing graph ------------------------------------
graphify cluster-only "$SCOPE" >> "$LOG" 2>&1 || log "graphify cluster-only failed (non-fatal)"
graphify update      "$SCOPE" >> "$LOG" 2>&1 || log "graphify update failed (non-fatal)"

# --- Semantic re-extract gate ---------------------------------------------
PENDING="$(graphify check-update "$SCOPE" 2>&1 || true)"
log "check-update: $PENDING"

if echo "$PENDING" | grep -qiE "pending|needs.?update|stale|out.?of.?date"; then
  log "semantic re-extract flagged — invoking '/graphify $SCOPE --wiki --obsidian' via claude -p (timeout ${CLAUDE_TIMEOUT}s)"
  # stdin-pipe avoids the variadic-flag ambiguity with --add-dir/--allowedTools.
  if printf '%s\n' "/graphify $SCOPE --wiki --obsidian --obsidian-dir $OBSIDIAN_DIR" \
      | claude -p \
          --add-dir "$REPO" \
          --allowed-tools "$CLAUDE_TOOLS" \
          --max-budget-usd 5 \
          >> "$LOG" 2>&1; then
    if [[ ! -f graphify-out/graph.json ]]; then
      log "post-build assertion FAILED: graph.json missing after claude -p exit 0"
    else
      log "semantic re-extract OK"
    fi
  else
    log "semantic re-extract FAILED or timed out (non-fatal; will retry next tick)"
  fi

  log "running claude lint"
  printf '%s\n' "Audit the graphify output in /Users/shakstzy/QUANTUM/graphify-out/. If wiki/ exists, find orphan pages (no inbound wiki-links), missing cross-links between pages that mention each other, low-confidence claims (frontmatter confidence: low) that have new corroborating sources, and contradictions between pages. Also scan GRAPH_REPORT.md for AMBIGUOUS edges. Overwrite graphify-out/lint-log.md with a terse markdown report: one section per issue type, bullet list under each, full file paths. Do NOT modify raw/. Do NOT touch files outside graphify-out/." \
    | claude -p \
        --add-dir "$REPO" \
        --allowed-tools "Read,Edit,Write,Glob,Grep" \
        --max-budget-usd 1 \
        >> "$LOG" 2>&1 || log "claude lint failed (non-fatal)"
else
  log "no pending semantic work; skipped full build + lint"
fi

log "done"
