#!/usr/bin/env bash
# quantum-graphify — periodic graphify refresh + conditional Claude lint
# Runs via launchd every 2h. Free ops always. Semantic re-extract + Claude lint only when check-update flags pending work.
set -uo pipefail

REPO="/Users/shakstzy/QUANTUM"
LOG="${HOME}/Library/Logs/quantum-graphify.log"
LOCK_DIR="/tmp/quantum-graphify.lock.d"

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

# bail if raw/ has no real content (only .gitkeeps)
if [[ -z "$(find raw -type f ! -name '.gitkeep' 2>/dev/null | head -1)" ]]; then
  log "raw/ empty, nothing to graph"
  exit 0
fi

# free pass: AST refresh
if [[ -f graphify-out/graph.json ]]; then
  graphify update . >> "$LOG" 2>&1 || log "graphify update failed (non-fatal)"
  graphify cluster-only . >> "$LOG" 2>&1 || log "graphify cluster-only failed (non-fatal)"
else
  log "no existing graph.json; skipping update/cluster-only (run a full build first)"
fi

# check if semantic re-extract is needed
PENDING="$(graphify check-update . 2>&1 || true)"
log "check-update: $PENDING"

if echo "$PENDING" | grep -qiE "pending|needs.?update|stale|out.?of.?date"; then
  log "semantic re-extract flagged — running full graphify . (Max-bundled)"
  graphify . >> "$LOG" 2>&1 || log "full graphify failed (non-fatal)"

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
