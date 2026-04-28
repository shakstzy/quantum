#!/usr/bin/env bash
# Ad-hoc one-shot chat. Reads prompt from stdin or first arg, prints response.
# Usage: echo "prompt" | bash chat.sh    OR    bash chat.sh "prompt"
set -euo pipefail
PORT=8765
if [ "$#" -ge 1 ]; then
    PROMPT="$1"
else
    PROMPT="$(cat)"
fi
PAYLOAD="$(jq -nc --arg p "$PROMPT" '{
    model: "unsloth/gemma-4-26b-a4b-it-UD-MLX-4bit",
    messages: [{role: "user", content: $p}],
    max_tokens: 1024,
    temperature: 0.3
}')"
curl -sf "http://127.0.0.1:$PORT/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" | jq -r '.choices[0].message.content'
