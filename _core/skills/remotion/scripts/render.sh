#!/bin/bash
# render.sh - drive Remotion CLI from any workspace.
# Usage: render.sh <project_dir> <composition_id> <out_path> [props_json]
set -euo pipefail

PROJECT_DIR="${1:?project_dir required}"
COMPOSITION_ID="${2:?composition_id required}"
OUT_PATH="${3:?out_path required}"
PROPS_JSON="${4:-}"

if [[ ! -d "$PROJECT_DIR/node_modules/.bin" ]]; then
  echo "Remotion not installed at $PROJECT_DIR. Running npm install..." >&2
  (cd "$PROJECT_DIR" && npm install --silent)
fi

ENTRY="$PROJECT_DIR/src/index.ts"
if [[ ! -f "$ENTRY" ]]; then
  echo "expected entry at $ENTRY" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUT_PATH")"

CMD=(npx remotion render "$ENTRY" "$COMPOSITION_ID" "$OUT_PATH" --codec=h264 --concurrency=4)
if [[ -n "$PROPS_JSON" ]]; then
  if [[ ! -f "$PROPS_JSON" ]]; then
    echo "props.json not found: $PROPS_JSON" >&2
    exit 2
  fi
  CMD+=(--props "$PROPS_JSON")
fi

cd "$PROJECT_DIR"
"${CMD[@]}"
echo "rendered: $OUT_PATH"
