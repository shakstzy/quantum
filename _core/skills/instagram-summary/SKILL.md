---
name: instagram-summary
description: Fetch an Instagram post or reel and summarize it. Posts return caption + metadata + visual analysis. Reels also return an audio transcript. Final multimodal synthesis is delegated to the `local-llm` skill (persistent local Gemma daemon). Trigger when Adithya pastes an instagram.com/p/, /reel/, /reels/, or /tv/ URL and asks to summarize, explain, or extract takeaways.
allowed-tools: Bash
---

# instagram-summary

Posts return caption + metadata + visual analysis of the image(s). Reels additionally return an audio transcript. Both paths end in a multimodal synthesis by `Gemma 4 26B-A4B (MoE)` served via the shared `local-llm` skill (warm HTTP daemon, no per-call cold-load tax). Carousels (multi-image posts) analyze up to 10 items.

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

1. **Local Gemma daemon up.** This skill delegates the multimodal synthesis call to `_core/skills/local-llm/SKILL.md`. Read that stub for daemon contract, lifecycle, and health checks. Posts and reels both fail fast if the daemon is unreachable; surface the error with a pointer to that skill.
2. **Whisper model cached** for reel audio (~470MB, one-time):

   ```
   ~/.quantum/instagram-summary/.venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small.en')"
   ```

Posts work as soon as the local-llm daemon is healthy. Reels also need Whisper.

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

- `local-llm server unreachable`: daemon not running or not healthy. Hand off to `_core/skills/local-llm/SKILL.md` (it owns status / start / restart / log inspection). Do not duplicate the recovery procedure here.
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
- Runtime venv: `~/.quantum/instagram-summary/.venv/` (out-of-repo, not committed). A separate migration phase moves the existing venv from `~/.claude/skills/instagram-summary/.venv/` to this location; the procedure paths above already assume the post-migration target.

## QUANTUM notes

- Local pipeline plus local Gemma. No keychain, no remote API key.
- If Adithya asks to save the summary, drop it at `raw/library/YYYY-MM-DD-<author>-<shortcode>.md` so Graphify picks it up. Slug pattern: `ig-<author>-<shortcode>`.
- Do NOT hand-edit `graphify-out/`.
