#!/usr/bin/env bash
# Incremental Slack ingest. Default workspace: eclipse-labs.
# Re-entrant: ingest_all.py resumes via raw/.ingest-log/slack-<workspace>.cursors.json.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG="$ROOT/raw/.ingest-log"
mkdir -p "$LOG"

WORKSPACE="${SLACK_ACCOUNT:-eclipse-labs}"
label="slack-${WORKSPACE}"
logfile="$LOG/${label}.log"

if ! python3 "$ROOT/workspaces/slack/scripts/ingest_all.py" --workspace "$WORKSPACE" >>"$logfile" 2>&1; then
  echo "!! ${label} FAILED (see ${logfile})" >&2
  tail -n 10 "$logfile" >&2 || true
  exit 1
fi
