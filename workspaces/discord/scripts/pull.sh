#!/usr/bin/env bash
# Pull Discord DMs + group DMs into raw/discord/.
# Driven by ingest_all.mjs, which uses the discord skill (CDP token capture)
# and Gemma (local-llm skill) for significance scoring.
# Usage: pull.sh [--dry-run] [--max-channels=N] [--backfill-days=N] [--no-gemma]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/ingest_all.mjs" "$@"
