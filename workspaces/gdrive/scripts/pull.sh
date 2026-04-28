#!/usr/bin/env bash
# Incremental Google Drive ingest across all 4 accounts into raw/gdrive/<account>/.
# Re-entrant: ingest_all.py resumes via raw/.ingest-log/gdrive-<account>.files.txt.
# Uses _core/scripts/.venv (pymupdf4llm dep). Runs accounts in parallel.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG="$ROOT/raw/.ingest-log"
VENV_PY="$ROOT/_core/scripts/.venv/bin/python"
mkdir -p "$LOG"

if [[ ! -x "$VENV_PY" ]]; then
  echo "missing venv at $VENV_PY (run _core/scripts/setup-venv.sh or equivalent)" >&2
  exit 2
fi

ACCOUNTS=(
  "adithya.shak.kumar@gmail.com"
  "adithya@eclipse.builders"
  "adithya@outerscope.xyz"
  "adithya@synps.xyz"
)

declare -a PIDS=()
declare -a LABELS=()

for acct in "${ACCOUNTS[@]}"; do
  label="gdrive-${acct}"
  logfile="$LOG/${label}.log"
  (
    "$VENV_PY" "$ROOT/workspaces/gdrive/scripts/ingest_all.py" --account "$acct"
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
