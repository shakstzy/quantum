#!/usr/bin/env bash
# Incremental Gmail ingest across all 4 accounts into raw/email/<account>/YYYY-MM.ndjson.
# Re-entrant: ingest_all.py resumes via raw/.ingest-log/email-<account>.threads.txt.
# Runs accounts in parallel (per-user Gmail quotas don't share). Safe at any cadence.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG="$ROOT/raw/.ingest-log"
mkdir -p "$LOG"

ACCOUNTS=(
  "adithya.shak.kumar@gmail.com"
  "adithya@eclipse.builders"
  "adithya@outerscope.xyz"
  "adithya@synps.xyz"
)

declare -a PIDS=()
declare -a LABELS=()

for acct in "${ACCOUNTS[@]}"; do
  label="email-${acct}"
  logfile="$LOG/${label}.log"
  (
    python3 "$ROOT/workspaces/email/scripts/ingest_all.py" --account "$acct"
  ) >>"$logfile" 2>&1 &
  PIDS+=($!)
  LABELS+=("$label")
done

fail=0
for i in "${!PIDS[@]}"; do
  if ! wait "${PIDS[$i]}"; then
    echo "!! ${LABELS[$i]} FAILED (see $LOG/${LABELS[$i]}.log)" >&2
    tail -n 5 "$LOG/${LABELS[$i]}.log" >&2 || true
    fail=1
  fi
done

exit $fail
