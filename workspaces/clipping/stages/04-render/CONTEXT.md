# 04-render

Compose vertical 9:16 mp4 with word-level captions. Only after dedup gate.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|--------------|---------------|-----|
| Candidate | DB `clip_candidates` where status='candidate' AND duplicate_score < 0.5 | Full row | Source of truth |
| Source mp4 | from `sources.filepath` | start_s..end_s | Raw frames |
| Transcript words | from `transcripts.filepath` | words within start_s..end_s | Caption timing |
| Remotion project | `workspaces/clipping/remotion/` | Composition `ClipComposition` | Compose engine |
| Render skill | `_core/skills/remotion/SKILL.md` | Full file | How to drive Remotion |

## Process

1. Load candidate. Hard-fail if `duplicate_score >= 0.5`.
2. Cut source: `ffmpeg -ss <start_s> -to <end_s> -i <source.mp4> -c:v copy -c:a copy /tmp/<cand>-raw.mp4`.
3. Detect speaker face per second on the cut: OpenCV Haar or MediaPipe (if installed) to get a list of `[(t, x, y, w, h)]`. Smooth via 1s moving average. Write `/tmp/<cand>-faces.json`.
4. Filter transcript words to the candidate window; subtract `start_s` so timing is relative; write `/tmp/<cand>-captions.json`.
5. Invoke `bash _core/skills/remotion/scripts/render.sh /tmp/<cand>-raw.mp4 /tmp/<cand>-faces.json /tmp/<cand>-captions.json ~/.quantum/clipping/candidates/<cand>.mp4`.
6. The Remotion composition produces 1080x1920 H264 mp4 with: (a) center-locked vertical crop following face track, (b) word-by-word captions burned in mid-frame, (c) optional intro hook text overlay if `candidates.hook` is set.
7. Compute `render_hash` (sha256 first 1MB of file). INSERT into `renders`. UPDATE candidate `status='rendered'`.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Final mp4 | `~/.quantum/clipping/candidates/<candidate-id>.mp4` | 1080x1920 H264 |
| Renders row | DB | SQLite |

## Audit

- [ ] Output file is 1080x1920 (verify with `ffprobe`).
- [ ] Output duration matches `(end_s - start_s)` within 0.2s.
- [ ] `render_hash` is populated.
- [ ] Caption text matches transcript excerpt (sanity sample).

## Hard Rules

1. Render only candidates with `duplicate_score < 0.5`.
2. Never render the same candidate twice in the same template; check `renders` first.
3. Output filename is `<candidate-id>.mp4`. Do not rename.
