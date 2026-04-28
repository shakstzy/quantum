#!/bin/bash
# UserPromptSubmit hook: inject relevant QUANTUM learnings into Claude's context
# Runs on every user prompt. Must complete in <500ms to feel responsive.
set -eu

LEARNINGS_DIR="/Users/shakstzy/QUANTUM/raw/learnings"
MAX_CTX_BYTES=4000

# No learnings dir, nothing to do
[ -d "$LEARNINGS_DIR" ] || exit 0

# Count .md files (exclude .gitkeep)
COUNT=$(find "$LEARNINGS_DIR" -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
[ "$COUNT" -eq 0 ] && exit 0

# Read prompt from stdin JSON; fail silent if jq or stdin is broken
PROMPT=""
if command -v jq >/dev/null 2>&1; then
  PROMPT=$(jq -r '.prompt // empty' 2>/dev/null || echo "")
fi

# Pick content to inject
CONTENT=""
if [ "$COUNT" -le 5 ]; then
  # Small store: just dump everything
  CONTENT=$(find "$LEARNINGS_DIR" -maxdepth 1 -name '*.md' -type f -exec cat {} + 2>/dev/null)
else
  # Big store: ripgrep keywords from prompt, take top 3 matching files
  KEYWORDS=$(printf '%s' "$PROMPT" | tr -cs 'a-zA-Z0-9' ' ' | tr ' ' '\n' | awk 'length($0) >= 4' | head -5 | paste -sd '|' -)
  MATCHES=""
  if [ -n "$KEYWORDS" ] && command -v rg >/dev/null 2>&1; then
    MATCHES=$(rg -l -i -- "($KEYWORDS)" "$LEARNINGS_DIR" 2>/dev/null | head -3)
  fi
  if [ -z "$MATCHES" ]; then
    # No keyword hits: fall back to 3 most recent learnings
    MATCHES=$(ls -t "$LEARNINGS_DIR"/*.md 2>/dev/null | head -3)
  fi
  if [ -n "$MATCHES" ]; then
    CONTENT=$(printf '%s\n' "$MATCHES" | xargs -I{} cat {} 2>/dev/null)
  fi
fi

[ -z "$CONTENT" ] && exit 0

# Cap to protect context window; iconv -c strips any partial multibyte char at the boundary
CONTENT=$(printf '%s' "$CONTENT" | head -c "$MAX_CTX_BYTES" | iconv -c -t UTF-8 2>/dev/null || printf '%s' "$CONTENT" | head -c "$MAX_CTX_BYTES")

# Build payload
HEADER="<quantum-learnings note=\"auto-injected from raw/learnings/, $COUNT total. Use if relevant; ignore if not.\">"
FOOTER="</quantum-learnings>"
FULL=$(printf '%s\n%s\n%s' "$HEADER" "$CONTENT" "$FOOTER")

if command -v jq >/dev/null 2>&1; then
  jq -n --arg ctx "$FULL" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
else
  exit 0
fi
