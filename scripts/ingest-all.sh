#!/usr/bin/env bash
# One-time bulk ingest: Gmail + Calendar + Drive across all 4 accounts.
# Fully parallel: 12 jobs (4 accounts x 3 services) run concurrently.
# Safe because Google API quotas are per-user-per-API, so accounts and services
# don't share budgets. Each job paces internally at 10 req/sec.
# Resumable; safe to re-run; read-only operations only.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/raw/.ingest-log"
mkdir -p "$LOG"

# gdrive ingestor needs pymupdf4llm; runs from a dedicated venv.
VENV_PY="$ROOT/_core/scripts/.venv/bin/python"
PYBIN_DEFAULT="python3"
pybin_for() { case "$1" in gdrive) echo "$VENV_PY";; *) echo "$PYBIN_DEFAULT";; esac; }

ACCOUNTS=(
  "adithya.shak.kumar@gmail.com"
  "adithya@eclipse.builders"
  "adithya@outerscope.xyz"
  "adithya@synps.xyz"
)
SERVICES=("calendar" "gdrive" "email")

start_ts="$(date +%s)"
echo "=== ingest-all start: $(date -Iseconds) ==="
echo "launching $(( ${#ACCOUNTS[@]} * ${#SERVICES[@]} )) jobs in parallel"

declare -a PIDS=()
declare -a LABELS=()

for svc in "${SERVICES[@]}"; do
  py="$(pybin_for "$svc")"
  for acct in "${ACCOUNTS[@]}"; do
    label="${svc}-${acct}"
    logfile="$LOG/${label}.log"
    echo "--- launch ${label} -> ${logfile}"
    (
      "$py" "$ROOT/workspaces/${svc}/scripts/ingest_all.py" --account "$acct"
      ec=$?
      if [ $ec -eq 0 ]; then
        echo "ok ${label}"
      else
        echo "!! ${label} FAILED (exit ${ec}); see ${logfile}"
      fi
    ) >>"$logfile" 2>&1 &
    PIDS+=($!)
    LABELS+=("$label")
  done
done

# Mirror per-job completion to stdout so the orchestrator output (and any tail-based
# monitor) sees ok/!! lines as jobs finish.
for i in "${!PIDS[@]}"; do
  pid="${PIDS[$i]}"
  label="${LABELS[$i]}"
  if wait "$pid"; then
    tail -n 1 "$LOG/${label}.log" 2>/dev/null
  else
    tail -n 1 "$LOG/${label}.log" 2>/dev/null || echo "!! ${label} FAILED"
  fi
done

end_ts="$(date +%s)"
elapsed=$((end_ts - start_ts))
echo "=== ingest-all done: $(date -Iseconds)  (elapsed ${elapsed}s) ==="
