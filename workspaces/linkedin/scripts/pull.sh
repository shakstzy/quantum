#!/usr/bin/env bash
# Daily pull entrypoint. Wraps `node scripts/pull.mjs` so launchd can call a stable shell path.
# Exits non-zero on any failure (caps tripped, halt set, ban signal, browser unresponsive).
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/pull.mjs "$@"
