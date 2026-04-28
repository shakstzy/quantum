#!/bin/bash
# Full pipeline for one campaign-source pair.
# Usage: bash run.sh <campaign-slug> <source-url> --rights <r> --evidence "<e>" [--top 5]
source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

CAMPAIGN_SLUG="${1:?campaign slug required}"; shift
SOURCE_URL="${1:?source url required}"; shift

SOURCE_OUT="$(python "$SRC/source.py" "$CAMPAIGN_SLUG" "$SOURCE_URL" "$@" 2>&1)"
echo "$SOURCE_OUT"
SID="$(echo "$SOURCE_OUT" | grep -oE 'source id=[0-9]+' | head -1 | grep -oE '[0-9]+')"
if [[ -z "$SID" ]]; then
  echo "could not parse source id from output" >&2
  exit 2
fi

python "$SRC/clip.py" "$SID"
echo "candidates ready. Run: bash render.sh <candidate-id> && bash qa.sh <cand> <acct> --apply && bash publish.sh <cand>"
