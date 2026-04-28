#!/usr/bin/env bash
# Pull new iMessage / SMS / RCS messages from local chat.db into raw/imessage/.
# Incremental by ROWID watermark. Read-only, no auth, no network.
# Usage: pull.sh [--full]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$SCRIPT_DIR/ingest_all.py" "$@"
