#!/usr/bin/env bash
# Firecrawl single-URL scrape via REST API. Returns markdown.
#
# usage:
#   scrape.sh <url> [format]
#     format  markdown (default) | html | rawHtml | links | screenshot
#
# Requires FIRECRAWL_API_KEY in env (sourced from .claude/settings.local.json).

set -euo pipefail

if [[ -z "${FIRECRAWL_API_KEY:-}" ]]; then
  echo "FIRECRAWL_API_KEY not set. Add it to .claude/settings.local.json env block." >&2
  exit 2
fi

url="${1:?url required}"
format="${2:-markdown}"

body=$(jq -n --arg u "$url" --arg f "$format" '{url:$u, formats:[$f]}')

curl -sS -X POST "https://api.firecrawl.dev/v1/scrape" \
  -H "Authorization: Bearer $FIRECRAWL_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$body" \
  | jq '{url: .data.metadata.sourceURL, title: .data.metadata.title, description: .data.metadata.description, markdown: .data.markdown}'
