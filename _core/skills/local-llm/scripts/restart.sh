#!/usr/bin/env bash
# Stop + start. Use after model swap, stuck inference, or config change.
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
bash "$SKILL_DIR/scripts/stop.sh"
sleep 2
bash "$SKILL_DIR/scripts/start.sh"
