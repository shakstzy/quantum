#!/usr/bin/env bash
# quantum-sync — periodic git auto-sync daemon
# Runs via launchd every 60s. Stages, commits (with secret-scan), pulls --rebase, pushes.
set -uo pipefail

REPO="/Users/shakstzy/QUANTUM"
LOG="${HOME}/Library/Logs/quantum-sync.log"
LOCK_DIR="/tmp/quantum-sync.lock.d"
COORD_LOCK="/tmp/quantum-heal-coord.lock"
BRANCH="main"

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
heartbeat() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] tick" >> "$LOG"; }
heartbeat

# single-instance lock (mkdir is atomic on macOS)
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# coord lock with heal-loop. Wait up to 30s; if heal-loop holds it, skip this tick.
exec 9>"$COORD_LOCK"
if ! flock -w 30 9; then
  log "heal-loop coord lock held >30s -- skipping tick"
  exit 0
fi

cd "$REPO" 2>/dev/null || { log "repo missing: $REPO"; exit 1; }

# bail if a git op is in flight
if [[ -f .git/index.lock ]]; then exit 0; fi
if [[ -d .git/rebase-merge || -d .git/rebase-apply || -f .git/MERGE_HEAD || -f .git/CHERRY_PICK_HEAD ]]; then
  log "rebase/merge in progress — skip"
  exit 0
fi

# stage everything tracked + new
git add -A

# secret scan against staged diff before committing
if ! git diff --cached --quiet; then
  STAGED_DIFF="$(git diff --cached -U0)"
  SECRET_RE='AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
  if echo "$STAGED_DIFF" | grep -E -q "$SECRET_RE"; then
    log "POSSIBLE SECRET in staged diff — aborting auto-commit (run unstaged)"
    git reset >/dev/null
    exit 2
  fi
  MSG="chore(auto-sync): $(date '+%Y-%m-%d %H:%M:%S')"
  if git -c user.name="Adithya Kumar" -c user.email="adithya.shak.kumar@gmail.com" commit -m "$MSG" >> "$LOG" 2>&1; then
    log "committed: $MSG"
  fi
fi

# pull (rebase, autostash any leftover unstaged work)
if ! git pull --rebase --autostash origin "$BRANCH" >> "$LOG" 2>&1; then
  log "pull --rebase FAILED — likely conflict, manual fix needed"
  exit 3
fi

# push only if local is ahead
LOCAL=$(git rev-parse @ 2>/dev/null || echo "")
REMOTE=$(git rev-parse "@{u}" 2>/dev/null || echo "")
if [[ -n "$LOCAL" && -n "$REMOTE" && "$LOCAL" != "$REMOTE" ]]; then
  if git push origin "$BRANCH" >> "$LOG" 2>&1; then
    log "pushed $LOCAL"
  else
    log "push failed"
    exit 4
  fi
fi
