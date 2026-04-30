---
name: instagram-summary
description: Fetch an Instagram post or reel and summarize it. Posts return caption + metadata + visual analysis. Reels also return an audio transcript. Final multimodal synthesis is delegated to the `cloud-llm` skill (gemini Pro across cycled accounts → claude -p sonnet fallback). Trigger when Adithya pastes an instagram.com/p/, /reel/, /reels/, or /tv/ URL and asks to summarize, explain, or extract takeaways.
allowed-tools: Bash
---

# instagram-summary

Posts return caption + metadata + visual analysis of the image(s). Reels additionally return an audio transcript. Both paths end in a multimodal synthesis dispatched through the shared `cloud-llm` skill (gemini Pro vision across 3 cycled accounts, with claude -p sonnet as fallback). Carousels (multi-image posts) analyze up to 10 items.

Implementation lives in this directory: `fetch.py` is the entrypoint. Runtime venv lives at `~/.quantum/instagram-summary/.venv/` (out of the repo, not committed).

## When this fires

Trigger phrases (semantic, non-exhaustive): "summarize this insta", "tldr this reel", "what's in this post", "explain this reel", "what's this carousel about", "extract takeaways from this post", or any prompt where Adithya pastes one of these URL shapes:

- `instagram.com/p/...` (single post or carousel)
- `instagram.com/reel/...` or `/reels/...`
- `instagram.com/tv/...`
- `instagram.com/share/p/...` or `/share/reel/...`

Do NOT fire for:
- Profile pages (no shortcode). Tell Adithya we need a specific post URL.
- Stories. Different surface, not supported here.
- DM links or live stream links.
- Re-uploads on other platforms (TikTok, YouTube Shorts). Use the matching skill.

## Prereqs

1. **Cloud LLM dispatch via cloud-llm skill.** This skill delegates the multimodal synthesis call to `_core/skills/cloud-llm/client.py`. Read that stub for engine cycle (gemini accounts + claude fallback) and behavior. Posts and reels fail fast if all engines are exhausted; surface the error with a pointer to that skill.
2. **Whisper model cached** for reel audio (~470MB, one-time):

   ```
   ~/.quantum/instagram-summary/.venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small.en')"
   ```

Posts work as soon as cloud-llm has at least one healthy engine (gemini account or claude). Reels also need Whisper.

## Procedure

```
~/.quantum/instagram-summary/.venv/bin/python /Users/shakstzy/QUANTUM/_core/skills/instagram-summary/fetch.py <URL>
```

Output blocks:

- **Post**: `TYPE`, `AUTHOR`, `DATE`, `LIKES`, `COMMENTS`, optional `CAROUSEL: M items`, `CAPTION`, `VISUAL+SYNTHESIS SUMMARY`.
- **Reel**: same fields plus `AUDIO TRANSCRIPT` before the synthesis block.

Lead the reply with `VISUAL+SYNTHESIS SUMMARY`. Quote the transcript or caption only when Adithya asks for more detail. If the reel has `(no speech detected)` and the visual summary is thin, say it's a music or aesthetic clip rather than padding.

stderr carries `[pipeline: Xs]` timing and instaloader retry chatter. Both ignorable.

## Errors

- `cloud-llm dispatch failed`: all gemini accounts exhausted AND claude -p also failed. Hand off to `_core/skills/cloud-llm/SKILL.md` (it owns the engine cycle and account state). Likely cause: every Gemini account 429'd this week and Claude Max weekly cap also hit — wait for caps to reset.
- `LoginRequired`: Instagram demanding auth. Run once with a burner:

  ```
  ~/.quantum/instagram-summary/.venv/bin/instaloader --login=<username>
  ```

- `yt-dlp failed`: Instagram changed its download surface. `brew upgrade yt-dlp`.
- Shortcode parse failure: confirm URL has `/p/`, `/reel/`, `/reels/`, `/tv/`, or `/share/(p|reel)/`.

## Expected runtime (M5 Max 128GB)

- Single-image post: 3-6s
- Carousel: 8-20s depending on item count (cap 10)
- Reel: 10-18s

Daemon keeps Gemma weights warm. No per-call cold-load tax.

## Layout

- Code: `/Users/shakstzy/QUANTUM/_core/skills/instagram-summary/fetch.py` (committed in repo).
- Runtime venv: `~/.quantum/instagram-summary/.venv/` (out-of-repo, not committed).

## QUANTUM notes

- Local pipeline plus local Gemma. No keychain, no remote API key.
- If Adithya asks to save the summary, drop it at `raw/library/YYYY-MM-DD-<author>-<shortcode>.md` so Graphify picks it up. Slug pattern: `ig-<author>-<shortcode>`.
- Do NOT hand-edit `graphify-out/`.
