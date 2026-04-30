#!/usr/bin/env bash
# SessionStart hook: fires iMessage ingest in the background.
#
# Why this hook (and not launchd): chat.db is TCC-protected, and grants on
# /bin/bash and /opt/homebrew/.../python3 fail to take effect for launchd-
# spawned processes (SIP + standalone-binary FDA quirks). But Claude Code is
# spawned from iTerm, which IS FDA-blessed, and FDA propagates through the
# session's process tree. So a hook that runs as part of the Claude Code
# session reliably reads chat.db.
#
# Cost: incremental no-op runs are ~0.07s. We background it anyway so a slow
# day's catch-up never blocks session start.
set -uo pipefail

LOG=~/Library/Logs/quantum-imessage.hook.log
SCRIPT=/Users/shakstzy/QUANTUM/workspaces/imessage/scripts/ingest_all.py

# Lockfile so concurrent Claude windows don't run the ingest in parallel.
LOCK=/tmp/quantum-imessage-ingest.lock
exec 9>"$LOCK"
flock -n 9 || exit 0

# Run in the background so we return to Claude Code immediately.
{
  echo "=== $(date -Iseconds) hook fire ==="
  /opt/homebrew/bin/python3 "$SCRIPT" 2>&1
} >>"$LOG" 2>&1 &

disown
exit 0
