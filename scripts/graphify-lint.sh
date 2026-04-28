#!/usr/bin/env bash
# quantum-graphify — periodic graphify refresh + conditional Claude lint
# Runs via launchd every 2h.
#
# Architecture note: `graphify` is BOTH a CLI (free ops: cluster-only, check-update,
# update, query, path, explain) AND a Claude skill (`/graphify`) that drives the
# full LLM-backed semantic build. The full build is NOT a CLI command — it must
# be invoked through Claude. So:
#   - Free CLI ops (cluster-only, check-update, update) run directly.
#   - Full builds (bootstrap + semantic re-extract) shell out to `claude -p "/graphify ..."`.
set -uo pipefail

REPO="/Users/shakstzy/QUANTUM"
LOG="${HOME}/Library/Logs/quantum-graphify.log"
LOCK_DIR="/tmp/quantum-graphify.lock.d"
OBSIDIAN_DIR="graphify-out/obsidian"
CLAUDE_TOOLS="Read,Edit,Write,Glob,Grep,Bash"

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
log "tick"

# single-instance lock (mkdir is atomic)
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "another instance running, skip"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

cd "$REPO" 2>/dev/null || { log "repo missing: $REPO"; exit 1; }

# bail if raw/ has no real content (only .gitkeeps and operational logs under raw/.ingest-log)
if [[ -z "$(find raw -type f ! -name '.gitkeep' ! -path 'raw/.ingest-log/*' 2>/dev/null | head -1)" ]]; then
  log "raw/ empty (ignoring .ingest-log), nothing to graph"
  exit 0
fi

# --- Bootstrap path: graphify-out/graph.json doesn't exist yet ---
# Drive the /graphify skill via headless Claude so it runs the full LLM pipeline
# and emits wiki/ + obsidian/ vault.
if [[ ! -f graphify-out/graph.json ]]; then
  log "no existing graph.json — bootstrapping via 'claude -p /graphify . --wiki --obsidian'"
  if claude -p \
       --add-dir "$REPO" \
       --allowedTools "$CLAUDE_TOOLS" \
       "/graphify . --wiki --obsidian --obsidian-dir $OBSIDIAN_DIR" \
       >> "$LOG" 2>&1; then
    log "bootstrap build OK"
  else
    log "bootstrap build FAILED — see log; will retry next tick"
    exit 5
  fi
  log "done (bootstrap)"
  exit 0
fi

# --- Steady-state path ---

# Free re-cluster on the existing graph.
graphify cluster-only . >> "$LOG" 2>&1 || log "graphify cluster-only failed (non-fatal)"

# Free AST refresh for any code changes since last tick (idempotent).
graphify update . >> "$LOG" 2>&1 || log "graphify update failed (non-fatal)"

# Decide whether semantic re-extract is needed.
PENDING="$(graphify check-update . 2>&1 || true)"
log "check-update: $PENDING"

if echo "$PENDING" | grep -qiE "pending|needs.?update|stale|out.?of.?date"; then
  log "semantic re-extract flagged — invoking '/graphify . --wiki --obsidian' via claude -p"
  claude -p \
    --add-dir "$REPO" \
    --allowedTools "$CLAUDE_TOOLS" \
    "/graphify . --wiki --obsidian --obsidian-dir $OBSIDIAN_DIR" \
    >> "$LOG" 2>&1 || log "full graphify (via claude) failed (non-fatal)"

  log "running claude lint"
  claude -p \
    --add-dir "$REPO" \
    --allowedTools "Read,Edit,Write,Glob,Grep" \
    "Audit the graphify output in /Users/shakstzy/QUANTUM/graphify-out/. If wiki/ exists, find orphan pages (no inbound wiki-links), missing cross-links between pages that mention each other, low-confidence claims (frontmatter confidence: low) that have new corroborating sources, and contradictions between pages. Also scan GRAPH_REPORT.md for AMBIGUOUS edges. Overwrite graphify-out/lint-log.md with a terse markdown report: one section per issue type, bullet list under each, full file paths. Do NOT modify raw/. Do NOT touch files outside graphify-out/." \
    >> "$LOG" 2>&1 || log "claude lint failed (non-fatal)"
else
  log "no pending semantic work; skipped full build + lint"
fi

log "done"
