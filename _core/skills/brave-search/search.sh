#!/usr/bin/env bash
# Brave Web Search via REST API.
#
# usage:
#   search.sh "query" [count] [freshness]
#     count      1..20 (default 10)
#     freshness  pd|pw|pm|py (past day/week/month/year)
#
# Requires BRAVE_API_KEY in env (sourced from .claude/settings.local.json).

set -euo pipefail

if [[ -z "${BRAVE_API_KEY:-}" ]]; then
  echo "BRAVE_API_KEY not set. Add it to .claude/settings.local.json env block." >&2
  exit 2
fi

q="${1:?query required}"
count="${2:-10}"
freshness="${3:-}"

args=(--data-urlencode "q=$q" --data-urlencode "count=$count" --data-urlencode "extra_snippets=true")
if [[ -n "$freshness" ]]; then
  args+=(--data-urlencode "freshness=$freshness")
fi

curl -sS -G "https://api.search.brave.com/res/v1/web/search" \
  "${args[@]}" \
  -H "Accept: application/json" \
  -H "X-Subscription-Token: $BRAVE_API_KEY" \
  | jq '{query: .query.original, results: [.web.results[]? | {title, url, description, age, extra_snippets}]}'
