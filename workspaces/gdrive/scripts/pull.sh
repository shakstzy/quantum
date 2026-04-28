#!/usr/bin/env bash
# Pull recent Drive file metadata across all 4 accounts into raw/gdrive/.
# Usage: pull.sh [days]   default: 30
set -euo pipefail

DAYS="${1:-30}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RAW="$ROOT/raw/gdrive"
mkdir -p "$RAW"

ACCOUNTS=(
  "adithya.shak.kumar@gmail.com"
  "adithya@eclipse.builders"
  "adithya@outerscope.xyz"
  "adithya@synps.xyz"
)

CUTOFF="$(date -v-${DAYS}d +%Y-%m-%dT%H:%M:%S)"
STAMP="$(date +%Y-%m-%d)"

for acct in "${ACCOUNTS[@]}"; do
  slug="${acct//[@.]/-}"
  out="$RAW/${STAMP}-${slug}.json"
  echo "pulling $acct drive (modified after $CUTOFF) -> $out"
  gog -a "$acct" -j drive search --raw-query "modifiedTime > '${CUTOFF}'" --all-pages > "$out"
done

echo "done. files in $RAW"
