#!/bin/bash
# Periodic Codex adversarial review of the bumble workspace WIP code.
# Fires every CADENCE_SEC seconds. Each iteration:
#   1. Snapshot current bumble workspace files into /tmp/bumble-snapshot-<ts>.txt
#   2. Send to `codex exec` with a "find bugs" prompt (read-only sandbox)
#   3. Extract one-line summary, append to /tmp/bumble-codex-loop.ndjson
#
# This is FIXTURE-ONLY (Codex P1#5): we never launch the browser or hit Bumble's
# servers from this loop. Codex only reads local code.
#
# Run this via the Monitor tool so each new ndjson line becomes a notification.

set -u
WS=/Users/shakstzy/QUANTUM/workspaces/bumble
LOG=/tmp/bumble-codex-loop.ndjson
CADENCE_SEC="${CADENCE_SEC:-1500}"   # 25 minutes default (cache-warm window)
MAX_ITERS="${MAX_ITERS:-12}"         # 12 * 25min = 5 hours

mkdir -p /tmp
: > "$LOG.lock" 2>/dev/null || true

iter=0
while [ "$iter" -lt "$MAX_ITERS" ]; do
  iter=$((iter + 1))
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  snap="/tmp/bumble-snapshot-$iter.txt"

  # Build snapshot: CLAUDE.md + every .mjs and .json under bot/ + selectors.
  {
    echo "=== workspaces/bumble/CLAUDE.md ==="
    cat "$WS/CLAUDE.md"
    echo
    echo "=== config files ==="
    for f in "$WS"/config/*.json; do echo "--- $(basename "$f") ---"; cat "$f"; echo; done
    echo "=== bot/src/runtime/*.mjs ==="
    for f in "$WS"/bot/src/runtime/*.mjs; do echo "--- $(basename "$f") ---"; cat "$f"; echo; done
    echo "=== bot/src/bumble/*.mjs ==="
    for f in "$WS"/bot/src/bumble/*.mjs; do echo "--- $(basename "$f") ---"; cat "$f"; echo; done
    echo "=== bot/src/drafting/*.mjs ==="
    for f in "$WS"/bot/src/drafting/*.mjs; do echo "--- $(basename "$f") ---"; cat "$f"; echo; done
    echo "=== bot/scripts/*.mjs ==="
    for f in "$WS"/bot/scripts/*.mjs; do echo "--- $(basename "$f") ---"; cat "$f"; echo; done
  } > "$snap" 2>/dev/null

  size=$(/usr/bin/wc -c < "$snap")
  prompt="You are reviewing a work-in-progress patchright Bumble bot scaffold. The workspace mirrors workspaces/tinder/ doctrine. Selectors are NOT yet discovered (selectors.json is null-stubbed); UI primitives in bot/src/bumble/*.mjs throw PreDiscoveryError until populated.

Find what is wrong. Specifically: race conditions, footguns from the Tinder mirror that Bumble specifically breaks, missing guards, things that will fail loudly the first time a real selector is wired in, missing or wrong abort/halt logic, anything that risks a Bumble account ban beyond what the existing detection ladder catches.

Rank P0/P1/P2. Skip generic advice. Be brutal. End with a one-line TL;DR starting with TLDR:.

== code snapshot ==
$(cat "$snap")"

  out=$(/opt/homebrew/bin/codex exec --skip-git-repo-check --sandbox read-only "$prompt" 2>&1 | /usr/bin/tail -200)
  tldr=$(echo "$out" | /usr/bin/grep -E "^TLDR:" | /usr/bin/head -1 | /usr/bin/cut -c1-200)
  if [ -z "$tldr" ]; then tldr=$(echo "$out" | /usr/bin/tail -1 | /usr/bin/cut -c1-200); fi
  full="/tmp/bumble-codex-iter-$iter.md"
  echo "$out" > "$full"

  printf '{"ts":"%s","iter":%d,"snap_size":%d,"tldr":%s,"full":"%s"}\n' \
    "$ts" "$iter" "$size" "$(/usr/bin/python3 -c 'import sys, json; print(json.dumps(sys.stdin.read().strip()))' <<< "$tldr")" "$full" >> "$LOG"

  /usr/bin/rm -f "$snap"

  if [ "$iter" -lt "$MAX_ITERS" ]; then
    sleep "$CADENCE_SEC"
  fi
done

echo '{"event":"codex_loop_done"}' >> "$LOG"
