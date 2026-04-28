#!/bin/bash
# Common env for clipping pipeline scripts. Sourced by every bot/scripts/*.sh.
set -euo pipefail

WS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$WS_ROOT/bot/src"
VENV="$WS_ROOT/.venv"

if [[ ! -d "$VENV" ]]; then
  echo "no venv at $VENV. run: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 2
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"
export PYTHONPATH="$SRC:${PYTHONPATH:-}"
export CLIPPING_WS_ROOT="$WS_ROOT"

# Pull API keys from QUANTUM .claude/settings.local.json env block if present
SETTINGS_LOCAL="$WS_ROOT/../../.claude/settings.local.json"
if [[ -f "$SETTINGS_LOCAL" ]] && command -v jq >/dev/null 2>&1; then
  while IFS='=' read -r k v; do
    [[ -z "${k:-}" ]] && continue
    [[ -n "${!k:-}" ]] && continue   # do not override pre-set env
    export "$k"="$v"
  done < <(jq -r '.env // {} | to_entries[] | "\(.key)=\(.value)"' "$SETTINGS_LOCAL" 2>/dev/null || true)
fi
