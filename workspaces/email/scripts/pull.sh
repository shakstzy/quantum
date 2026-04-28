#!/usr/bin/env bash
# Pull recent Gmail messages across all 4 accounts into raw/email/.
# Usage: pull.sh [days]   default: 7
set -euo pipefail

DAYS="${1:-7}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RAW="$ROOT/raw/email"
mkdir -p "$RAW"

ACCOUNTS=(
  "adithya.shak.kumar@gmail.com"
  "adithya@eclipse.builders"
  "adithya@outerscope.xyz"
  "adithya@synps.xyz"
)

STAMP="$(date +%Y-%m-%d)"
for acct in "${ACCOUNTS[@]}"; do
  slug="${acct%@*}"
  slug="${slug//./-}"
  out="$RAW/${STAMP}-${slug}.json"
  echo "pulling $acct -> $out"
  gog -a "$acct" -j gmail search "newer_than:${DAYS}d" > "$out"
done

echo "done. files in $RAW"
