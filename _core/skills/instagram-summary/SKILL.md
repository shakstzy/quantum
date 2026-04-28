---
name: instagram-summary
description: Fetch an Instagram post or reel and summarize it. Posts return caption + metadata + visual analysis. Reels also return an audio transcript. Final synthesis runs through the local Gemma server. Trigger when Adithya pastes an instagram.com/p/, /reel/, /reels/, or /tv/ URL and asks to summarize, explain, or extract takeaways.
allowed-tools: Bash
---

# instagram-summary (QUANTUM stub)

Thin QUANTUM-side trigger doc. The real implementation lives at `~/.claude/skills/instagram-summary/`. This stub exists so Claude routes correctly inside QUANTUM and so the trigger appears in `QUANTUM/CLAUDE.md`.

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

## Prereqs (one-time)

1. Local Gemma daemon. The skill posts the final multimodal synthesis to `http://127.0.0.1:8765`. Install via SHAKOS:

   ```
   bash /Users/shakstzy/SHAKOS/system/_core/playbooks/local-llm/scripts/install.sh
   ```

2. Whisper model for reel transcripts (~470MB):

   ```
   ~/.claude/skills/instagram-summary/.venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small.en')"
   ```

Posts work as soon as the daemon is healthy. Reels also need Whisper.

## Procedure

```
~/.claude/skills/instagram-summary/.venv/bin/python ~/.claude/skills/instagram-summary/fetch.py <URL>
```

Output blocks:

- **Post**: `TYPE`, `AUTHOR`, `DATE`, `LIKES`, `COMMENTS`, optional `CAROUSEL: M items`, `CAPTION`, `VISUAL+SYNTHESIS SUMMARY`.
- **Reel**: same fields plus `AUDIO TRANSCRIPT` before the synthesis block.

Lead the reply with `VISUAL+SYNTHESIS SUMMARY`. Quote the transcript or caption only when Adithya asks for more detail. If the reel has `(no speech detected)` and the visual summary is thin, say it's a music or aesthetic clip rather than padding.

stderr carries `[pipeline: Xs]` timing and instaloader retry chatter. Both ignorable.

## Errors

- `local-llm server unreachable`: daemon not running. Run `bash /Users/shakstzy/SHAKOS/system/_core/playbooks/local-llm/scripts/status.sh`. If unhealthy, check `~/.shakos/local-llm/server.log`.
- `LoginRequired`: Instagram demanding auth. Run once with a burner:

  ```
  ~/.claude/skills/instagram-summary/.venv/bin/instaloader --login=<username>
  ```

- `yt-dlp failed`: Instagram changed its download surface. `brew upgrade yt-dlp`.
- Shortcode parse failure: confirm URL has `/p/`, `/reel/`, `/reels/`, `/tv/`, or `/share/(p|reel)/`.

## Expected runtime (M5 Max 128GB)

- Single-image post: 3-6s
- Carousel: 8-20s depending on item count (cap 10)
- Reel: 10-18s

Daemon keeps Gemma weights warm. No per-call cold-load tax.

## QUANTUM notes

- Local pipeline plus local Gemma. No keychain, no remote API key.
- If Adithya asks to save the summary, drop it at `raw/library/YYYY-MM-DD-<author>-<shortcode>.md` so Graphify picks it up. Slug pattern: `ig-<author>-<shortcode>`.
- Do NOT hand-edit `graphify-out/`.
