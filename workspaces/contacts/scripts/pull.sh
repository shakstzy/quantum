#!/usr/bin/env bash
# cron entry point: ingest macOS Contacts then classify junk.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$HERE/ingest.mjs"
node "$HERE/classify.mjs"
