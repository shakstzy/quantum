#!/usr/bin/env bash
# Start the local-llm daemon. Idempotent.
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.quantum.local-llm.plist"
PORT=8765
if [ ! -f "$PLIST" ]; then
    echo "ERROR: plist not installed at $PLIST. Run install.sh first." >&2
    exit 1
fi
launchctl load "$PLIST" 2>/dev/null || launchctl kickstart -k "gui/$(id -u)/com.quantum.local-llm"
echo "Waiting for health on port $PORT (up to 60s)..."
for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
        echo "Ready after ${i}s."
        exit 0
    fi
    sleep 1
done
echo "ERROR: did not become healthy in 60s. Check $HOME/.quantum/local-llm/server.log" >&2
exit 1
