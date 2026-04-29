#!/usr/bin/env bash
set -euo pipefail
echo "[ad-factory/01-research] not yet wired" >&2
echo "" >&2
echo "Implementation needed:" >&2
echo "  1. Patchright IG hashtag scrape (model after _core/skills/discord/)" >&2
echo "  2. Patchright TikTok hashtag scrape" >&2
echo "  3. Frame sampling + Gemma multimodal analysis loop (use _core/skills/local-llm/client.py)" >&2
echo "  4. Aggregate -> output/<slug>-research.md" >&2
echo "  5. Delete ~/.quantum/ad-factory/scrape-tmp/<slug>/" >&2
exit 1
