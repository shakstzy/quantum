#!/bin/bash
# SessionStart hook: brief inventory of QUANTUM learnings at session open
# UserPromptSubmit hook does the per-prompt injection; this just tells Claude
# the store exists and how big it is.
set -eu

LEARNINGS_DIR="/Users/shakstzy/QUANTUM/raw/learnings"

[ -d "$LEARNINGS_DIR" ] || exit 0

COUNT=$(find "$LEARNINGS_DIR" -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
[ "$COUNT" -eq 0 ] && exit 0

# List up to 20 file names (no content)
NAMES=$(find "$LEARNINGS_DIR" -maxdepth 1 -name '*.md' -type f -exec basename {} \; 2>/dev/null | sort | head -20)

CTX=$(printf '%s\n%s\n%s\n%s' \
  "<quantum-learnings-inventory>" \
  "QUANTUM has $COUNT accumulated learnings in /Users/shakstzy/QUANTUM/raw/learnings/." \
  "Relevant ones auto-inject on each prompt via the UserPromptSubmit hook." \
  "Available files (most recent ${COUNT}, capped at 20):
$NAMES
</quantum-learnings-inventory>")

if command -v jq >/dev/null 2>&1; then
  jq -n --arg ctx "$CTX" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
else
  exit 0
fi
