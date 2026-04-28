#!/usr/bin/env bash
# One-time bulk ingest: Gmail + Calendar + Drive across all 4 accounts.
# Sequential per service per account. Resumable; safe to re-run.
# Read-only operations only; no CONFIRM gate needed.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/raw/.ingest-log"
mkdir -p "$LOG"

ACCOUNTS=(
  "adithya.shak.kumar@gmail.com"
  "adithya@eclipse.builders"
  "adithya@outerscope.xyz"
  "adithya@synps.xyz"
)

start_ts="$(date +%s)"
echo "=== ingest-all start: $(date -Iseconds) ==="

run_step() {
  local label="$1"; shift
  local logfile="$LOG/${label}.log"
  echo
  echo "--- $label ---"
  echo "log: $logfile"
  if ! "$@" >>"$logfile" 2>&1; then
    echo "!! $label FAILED (continuing); see $logfile" | tee -a "$LOG/ingest-all.log"
  else
    echo "ok $label"
  fi
}

# Calendar first (smallest, cheapest, sanity-check auth on every account).
for acct in "${ACCOUNTS[@]}"; do
  run_step "calendar-${acct}" python3 "$ROOT/workspaces/calendar/scripts/ingest_all.py" --account "$acct"
done

# Drive next (metadata is cheap; download/markitdown takes time).
for acct in "${ACCOUNTS[@]}"; do
  run_step "gdrive-${acct}" python3 "$ROOT/workspaces/gdrive/scripts/ingest_all.py" --account "$acct"
done

# Email last (highest volume).
for acct in "${ACCOUNTS[@]}"; do
  run_step "email-${acct}" python3 "$ROOT/workspaces/email/scripts/ingest_all.py" --account "$acct"
done

end_ts="$(date +%s)"
elapsed=$((end_ts - start_ts))
echo
echo "=== ingest-all done: $(date -Iseconds)  (elapsed ${elapsed}s) ==="
