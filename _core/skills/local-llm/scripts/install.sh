#!/usr/bin/env bash
# Install the local-llm shared skill. Idempotent.
#
# What this does:
#   1. Verify Python 3.11+ is available
#   2. Create venv at ~/.quantum/local-llm/.venv
#   3. Install mlx-vlm
#   4. Verify Gemma 4 26B-A4B weights are cached (download if not, ~15GB)
#   5. Render launchd plist from template into ~/Library/LaunchAgents/
#   6. Load the launchd job
#   7. Wait for the health endpoint to respond
#   8. Print server status
set -euo pipefail

RUNTIME="$HOME/.quantum/local-llm"
PLIST_LABEL="com.quantum.local-llm"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$SKILL_DIR/scripts/launchd.plist.template"
PORT=8765
MODEL="unsloth/gemma-4-26b-a4b-it-UD-MLX-4bit"

echo "==> Setting up runtime at $RUNTIME"
mkdir -p "$RUNTIME"

echo "==> Checking Python"
PYTHON="$(command -v python3.14 || command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3 || true)"
if [ -z "$PYTHON" ]; then
    echo "ERROR: no Python 3.11+ found. Install via: brew install python@3.13"
    exit 1
fi
echo "    using $PYTHON"

if [ ! -d "$RUNTIME/.venv" ]; then
    echo "==> Creating venv"
    "$PYTHON" -m venv "$RUNTIME/.venv"
fi

echo "==> Installing mlx-vlm"
"$RUNTIME/.venv/bin/pip" install --quiet --upgrade pip
"$RUNTIME/.venv/bin/pip" install --quiet mlx-vlm

echo "==> Verifying Gemma weights cached"
"$RUNTIME/.venv/bin/python" -c "
from huggingface_hub import snapshot_download
import os
print('    downloading or verifying', '$MODEL')
path = snapshot_download('$MODEL')
print('    weights at', path)
"

echo "==> Rendering launchd plist"
sed "s|{{HOME}}|$HOME|g" "$TEMPLATE" > "$PLIST_PATH"
echo "    wrote $PLIST_PATH"

echo "==> Unloading any prior instance"
launchctl unload "$PLIST_PATH" 2>/dev/null || true

echo "==> Loading launchd job"
launchctl load "$PLIST_PATH"

echo "==> Waiting for health endpoint on port $PORT (up to 90s for first cold load)"
for i in $(seq 1 90); do
    if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
        echo "    ready after ${i}s"
        break
    fi
    if [ "$i" -eq 90 ]; then
        echo "ERROR: server did not become healthy in 90s"
        echo "Check logs: tail -f $RUNTIME/server.log"
        exit 1
    fi
    sleep 1
done

echo "==> Status"
launchctl list | grep "$PLIST_LABEL" || true
echo
echo "Done. Endpoint: http://127.0.0.1:$PORT/v1/chat/completions"
echo "Logs:           $RUNTIME/server.log"
echo "Restart:        bash $SKILL_DIR/scripts/restart.sh"
