#!/usr/bin/env bash
# Stop the local-llm daemon.
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.quantum.local-llm.plist"
if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    echo "Unloaded com.quantum.local-llm."
else
    echo "No plist installed at $PLIST; nothing to stop."
fi
