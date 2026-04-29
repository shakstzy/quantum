#!/usr/bin/env bash
# QUANTUM ICM heal-loop orchestrator.
#
# Single launchd-driven entrypoint. Replaces the audit.py-only invocation.
#
# Phase 1: audit (writes report.json; diff-only)
# Phase 2: triage (classify findings)
# Phase 3: autofix-safe (em-dash only, worktree-isolated, finding-set gate)
# Phase 4: external-review (RECOMMENDATION-ONLY in v1; codex+gemini in parallel)
# Phase 5: human-digest (always written)
#
# Coordinates with scripts/sync.sh via flock on /tmp/quantum-heal-coord.lock.
# scripts/sync.sh acquires the same lock before any git mutation; if held
# by heal-loop, sync skips the tick.

set -uo pipefail

REPO="/Users/shakstzy/QUANTUM"
SKILL_DIR="$REPO/_core/skills/icm-audit/scripts"
LOG="${HOME}/Library/Logs/quantum-heal-loop.log"
COORD_LOCK="/tmp/quantum-heal-coord.lock"
TRIAGE_OUT="/tmp/icm-heal-triage.$$.json"

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
trap 'rm -f "$TRIAGE_OUT"' EXIT

cleanup_worktrees() {
    # remove any lingering icm-heal-wt-* worktrees
    git -C "$REPO" worktree list --porcelain 2>/dev/null \
        | awk '/^worktree / && $2 ~ /icm-heal-wt-/ {print $2}' \
        | while read -r wt; do
            git -C "$REPO" worktree remove --force "$wt" 2>/dev/null || true
        done
    # remove orphan branches
    git -C "$REPO" branch --list 'icm-heal/*' 2>/dev/null \
        | sed 's/^[* ] *//' \
        | while read -r br; do
            git -C "$REPO" branch -D "$br" 2>/dev/null || true
        done
}

# Acquire shared coord lock (non-blocking).
# fd 9 is closed when shell exits, releasing the lock.
exec 9>"$COORD_LOCK"
if ! flock -n 9; then
    log "coord lock held; sync mid-commit or another heal-loop running -- skipping tick"
    exit 0
fi

log "heal-loop tick starting (lock acquired)"

# Phase 0: pre-flight
cleanup_worktrees

if [ ! -d "$REPO/.git" ]; then
    log "ERROR: $REPO is not a git repo"
    exit 10
fi

# Phase 1: audit. Capture exact run dir.
RUN_DIR=$(python3 "$SKILL_DIR/audit.py" --print-run-dir 2>>"$LOG" | tail -1)
if [ -z "$RUN_DIR" ] || [ ! -d "$RUN_DIR" ]; then
    log "audit produced no run dir or directory missing: '$RUN_DIR'"
    exit 0
fi
log "audit run dir: $RUN_DIR"

if [ ! -f "$RUN_DIR/report.json" ]; then
    log "ERROR: report.json missing in $RUN_DIR"
    exit 10
fi

# Phase 2: triage.
python3 "$SKILL_DIR/triage.py" \
    --report "$RUN_DIR/report.json" \
    --out "$TRIAGE_OUT" 2>>"$LOG"
if [ ! -f "$TRIAGE_OUT" ]; then
    log "ERROR: triage produced no output"
    exit 10
fi

SUMMARY=$(python3 -c "import json; d=json.load(open('$TRIAGE_OUT')); print(d['summary'])")
log "triage: $SUMMARY"

# Phase 3: autofix-safe (em-dash only).
python3 "$SKILL_DIR/autofix_safe.py" --triage "$TRIAGE_OUT" 2>&1 | tee -a "$LOG"
AUTOFIX_RC=${PIPESTATUS[0]}
log "autofix-safe rc=$AUTOFIX_RC"

# Phase 4: external review (recommendation-only).
# Skip on dry-run repos or if no cli auth -- catch errors but don't fail tick.
python3 "$SKILL_DIR/external_review.py" --triage "$TRIAGE_OUT" 2>&1 | tee -a "$LOG"
EXT_RC=${PIPESTATUS[0]}
log "external-review rc=$EXT_RC"

# Phase 5: human digest (always).
python3 "$SKILL_DIR/human_digest.py" --triage "$TRIAGE_OUT" 2>&1 | tee -a "$LOG"

log "heal-loop tick complete"
exit 0
