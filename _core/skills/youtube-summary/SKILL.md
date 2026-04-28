---
name: youtube-summary
description: Fetch a YouTube video's transcript and summarize the key points. Trigger when Adithya pastes a YouTube URL (youtube.com/watch, youtu.be, youtube.com/shorts, youtube.com/live, youtube.com/embed) and asks to summarize, explain, recap, tl;dr, or extract takeaways. Local-only, no auth.
allowed-tools: Bash
---

# youtube-summary

Pulls a YouTube transcript via `youtube_transcript_api` and produces a summary. Runtime venv lives at `~/.quantum/youtube-summary/.venv/` (out-of-repo, not committed).

## When this fires

Trigger phrases (semantic, non-exhaustive): "summarize this youtube", "tldr this video", "what's this video about", "recap this", "extract the takeaways", "explain this video", or any prompt where Adithya pastes one of these URL shapes:

- `youtube.com/watch?v=...`
- `youtu.be/...`
- `youtube.com/shorts/...`
- `youtube.com/live/...`
- `youtube.com/embed/...`

Do NOT fire for:
- Non-YouTube video URLs (Vimeo, Loom, Twitch, X video posts).
- YouTube channel or playlist pages without a specific video.
- DRM-locked content or anything DRM-removal-adjacent.
- Music-video lyric extraction. Captions on music videos are usually wrong or absent.

## Procedure

1. Extract the 11-character video ID from the URL (after `v=`, `youtu.be/`, `/shorts/`, `/embed/`, or `/live/`).
2. Run:

   ```
   ~/.quantum/youtube-summary/.venv/bin/python -m youtube_transcript_api <VIDEO_ID> --languages en --format text
   ```

3. stdout is the transcript, newline-separated. Read it, then produce a summary focused on:
   - Core thesis or argument
   - Key points in order
   - Concrete takeaways or recommendations

4. Match summary length to video length unless Adithya asks for more or less detail.

## Errors (stderr, non-zero exit)

- `TranscriptsDisabled` / `NoTranscriptFound`: captions off or no English track. Tell Adithya plainly. No workaround.
- `VideoUnavailable`: private, deleted, or region-locked.
- `RequestBlocked` / `IpBlocked`: YouTube is rate-limiting this IP. Retry later.

## QUANTUM notes

- Pure local CLI. No keychain, no network gate, no human-in-the-loop required.
- If Adithya asks to save the summary, drop it under `raw/library/YYYY-MM-DD-<slug>.md` so the next Graphify run picks it up. Default filename slug: short kebab of video title.
- Do NOT hand-edit `graphify-out/`. Let the Layer 3 lint timer re-extract.
