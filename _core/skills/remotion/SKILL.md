---
name: remotion
description: Programmatic video composition via Remotion (React-based). Render short-form vertical 9:16 video from a TypeScript composition + JSON props. Use when a workspace needs to produce video with code-controlled layout, captions, overlays, face-tracked crop, or templated branding. Do NOT use for simple cuts or transcoding (ffmpeg) or for raw AI generation (higgsfield).
---

# Remotion

Programmatic-video skill. Drives the Node Remotion CLI to render a registered composition to mp4. Adithya already has Remotion installed inside `workspaces/clipping/remotion/`; this skill documents how to invoke it from any workspace and how to scaffold one in a new workspace.

## When this fires

Trigger phrases: "render with remotion", "compose this video", "make a vertical 9:16 with captions", "templated short-form video", "generate clip from template", "build a Remotion project", "render the clip at <path>".

Do NOT fire for:
- Simple cut / trim / transcode (use ffmpeg directly).
- Raw AI video generation (use `_core/skills/higgsfield/`).
- Live-streamed compositions (Remotion is offline render only).

## Required caller inputs

| Input | Required | Purpose |
|-------|----------|---------|
| `project_dir` | yes | Path containing `package.json`, `src/index.ts`, `remotion.config.ts` |
| `composition_id` | yes | Matches the `id` of `<Composition>` in `src/Root.tsx` |
| `out_path` | yes | Absolute mp4 output path |
| `props_json` | optional | Path to JSON file with composition props |
| `concurrency` | optional | Default 4. Lower if RAM-bound. |

## Procedure

1. Verify `project_dir/node_modules/.bin/remotion` exists. If not: `cd <project_dir> && npm install`.
2. If `props_json` is supplied: ensure file exists and parses as JSON.
3. Invoke `bash scripts/render.sh <project_dir> <composition_id> <out_path> [props_json]`.
4. Verify output: `ffprobe -v error -select_streams v -show_entries stream=width,height,duration,codec_name -of json <out_path>`. Width should be 1080, height 1920 for 9:16.
5. Surface the path and a one-line summary.

## Files

- `references/quick-start.md` — Remotion 4.x project layout, registerRoot pattern, calculateMetadata
- `references/composition-patterns.md` — vertical 9:16 with face-track crop, word-by-word captions, hook overlay
- `scripts/render.sh` — single-entry CLI wrapper

## Performance

Apple Silicon: roughly 3-10x realtime for 1080x1920 H264 with simple compositions. Heavy filters (B-roll, particles, generated graphics) drop closer to 1x. Use `--concurrency=4` to start; raise if not RAM-bound, lower if you see swap.

## Out-of-scope

- Audio mastering / loudness norm: use ffmpeg `loudnorm`.
- AI-generated video clips: use `_core/skills/higgsfield/`.
- Subtitle generation from raw audio: use a transcript-producing skill (e.g. clipping workspace's `transcribe.py`) and pass words to Remotion as props.
