#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "ad-factory status"
echo "================="
echo
echo "Hosts:"
if [[ -d "$ROOT/shared/hosts" ]]; then
  found=0
  for h in "$ROOT"/shared/hosts/*/; do
    base="$(basename "$h")"
    if [[ "$base" == "_template" ]]; then continue; fi
    found=1
    echo "  - $base"
  done
  if [[ "$found" == 0 ]]; then echo "  (none seeded)"; fi
fi

echo
echo "Inbox (products awaiting work):"
if [[ -d "$ROOT/inbox" ]]; then
  found=0
  for p in "$ROOT"/inbox/*/; do
    [[ -d "$p" ]] || continue
    found=1
    echo "  - $(basename "$p")"
  done
  if [[ "$found" == 0 ]]; then echo "  (empty)"; fi
fi

echo
echo "Recent stage outputs:"
for s in 01-research 02-script 03-render 04-edit 05-ship 06-metrics 07-learn; do
  d="$ROOT/stages/$s/output"
  [[ -d "$d" ]] || continue
  count=$(find "$d" -maxdepth 1 -type f | wc -l | tr -d ' ')
  echo "  $s: $count files"
done
