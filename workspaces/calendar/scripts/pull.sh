#!/usr/bin/env bash
# Pull calendar events across all 4 accounts into raw/calendar/.
# Usage: pull.sh [past_days] [future_days]   default: 7 30
set -euo pipefail

PAST="${1:-7}"
FUTURE="${2:-30}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RAW="$ROOT/raw/calendar"
mkdir -p "$RAW"

ACCOUNTS=(
  "adithya.shak.kumar@gmail.com"
  "adithya@eclipse.builders"
  "adithya@outerscope.xyz"
  "adithya@synps.xyz"
)

START="$(date -v-${PAST}d +%Y-%m-%d)"
END="$(date -v+${FUTURE}d +%Y-%m-%d)"
STAMP="$(date +%Y-%m-%d)"

for acct in "${ACCOUNTS[@]}"; do
  slug="${acct%@*}"
  slug="${slug//./-}"
  out="$RAW/${STAMP}-${slug}.json"
  echo "pulling $acct events ${START}..${END} -> $out"
  gog -a "$acct" -j calendar events --start "$START" --end "$END" > "$out"
done

echo "done. files in $RAW"
