#!/usr/bin/env bash
# Health + launchd state. Exit 0 if healthy.
PORT=8765
echo "== launchctl list =="
launchctl list | grep com.quantum.local-llm || echo "    (not loaded)"
echo
echo "== health endpoint =="
if curl -sf -m 5 "http://127.0.0.1:$PORT/health" > /dev/null; then
    echo "    HEALTHY (200 from http://127.0.0.1:$PORT/health)"
    exit 0
else
    echo "    UNHEALTHY (no 200 from http://127.0.0.1:$PORT/health)"
    echo
    echo "== last 20 log lines =="
    tail -n 20 "$HOME/.quantum/local-llm/server.log" 2>/dev/null || echo "    (no log file)"
    exit 1
fi
