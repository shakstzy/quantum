#!/usr/bin/env bash
# Single source of truth for shell consumers of the QUANTUM local-llm daemon.
# Source this file (do not execute it) to export the canonical endpoint vars.
# Mirrors client.py for Python consumers. If the daemon shape changes (port,
# host, model), edit this file once and every shell consumer auto-fixes.
#
# Usage:
#   source /Users/shakstzy/QUANTUM/_core/skills/local-llm/scripts/endpoint.sh
#   curl -sf "$LOCAL_LLM_URL" -d '...'
#   OPENAI_API_KEY=local OPENAI_BASE_URL="$LOCAL_LLM_BASE_URL/v1" some-cli ...

export LOCAL_LLM_HOST="127.0.0.1"
export LOCAL_LLM_PORT="8765"
export LOCAL_LLM_BASE_URL="http://${LOCAL_LLM_HOST}:${LOCAL_LLM_PORT}"
export LOCAL_LLM_URL="${LOCAL_LLM_BASE_URL}/v1/chat/completions"
export LOCAL_LLM_HEALTH_URL="${LOCAL_LLM_BASE_URL}/health"
export LOCAL_LLM_MODEL="unsloth/gemma-4-26b-a4b-it-UD-MLX-4bit"
