#!/usr/bin/env bash
# quantum-graphify — periodic graphify refresh + conditional Claude lint
# Runs via launchd every 2h.
# - First run (no graph yet): full bootstrap build with --wiki --obsidian.
# - Subsequent runs: free cluster-only + check-update; full rebuild + lint only if check-update flags pending work.
set -uo pipefail

REPO="/Users/shakstzy/QUANTUM"
LOG="${HOME}/Library/Logs/quantum-graphify.log"
LOCK_DIR="/tmp/quantum-graphify.lock.d"
OBSIDIAN_DIR="graphify-out/obsidian"

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

# Note: `graphify update` (AST refresh) is handled by the post-commit hook
# and the auto-sync committer (~60s cadence), so we skip it here to avoid duplication.
# This timer's job is the things git hooks DON'T cover: re-clustering, semantic re-extract, lint, and the first build.

# --- Bootstrap path: graphify-out/graph.json doesn't exist yet ---
if [[ ! -f graphify-out/graph.json ]]; then
  log "no existing graph.json — running first full build with --wiki --obsidian"
  if graphify . --wiki --obsidian --obsidian-dir "$OBSIDIAN_DIR" >> "$LOG" 2>&1; then
    log "bootstrap build OK"
  else
    log "bootstrap build FAILED — see log; will retry next tick"
    exit 5
  fi
  log "done (bootstrap)"
  exit 0
fi

# --- Steady-state path ---
graphify cluster-only . >> "$LOG" 2>&1 || log "graphify cluster-only failed (non-fatal)"

PENDING="$(graphify check-update . 2>&1 || true)"
log "check-update: $PENDING"

if echo "$PENDING" | grep -qiE "pending|needs.?update|stale|out.?of.?date"; then
  log "semantic re-extract flagged — running full graphify . --wiki --obsidian (Max-bundled)"
  graphify . --wiki --obsidian --obsidian-dir "$OBSIDIAN_DIR" >> "$LOG" 2>&1 || log "full graphify failed (non-fatal)"

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
