---
name: remotion
description: Programmatic video composition via Remotion (React-based). Render short-form vertical 9:16 video from a TypeScript composition + JSON props. Use when a workspace needs to produce video with code-controlled layout, captions, overlays, face-tracked crop, or templated branding. Add-on packages installed at workspaces/clipping/remotion/: captions (caption helpers), install-whisper-cpp (local Whisper transcription), transitions (scene transitions), google-fonts (cross-platform font bundling). Do NOT use for simple cuts or transcoding (ffmpeg) or for raw AI generation (higgsfield).
---

# Remotion

Programmatic-video skill. Drives the Node Remotion CLI to render a registered composition to mp4. Canonical install lives at `workspaces/clipping/remotion/` (Remotion 4.0.454). This SKILL.md is the wrapper that documents how to invoke that install from any workspace and how to scaffold a new per-workspace install when needed.

## When this fires

Trigger phrases: "render with remotion", "compose this video", "make a vertical 9:16 with captions", "templated short-form video", "generate clip from template", "build a Remotion project", "render the clip at <path>", "add captions to this video via Remotion", "scene transitions on this clip".

Do NOT fire for:
- Simple cut / trim / transcode (use ffmpeg directly).
- Raw AI video generation (use `_core/skills/higgsfield/`).
- Live-streamed compositions (Remotion is offline render only).
- Publishing the rendered video. Hand off to `_core/skills/zernio-post/`.

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

- `references/quick-start.md` - Remotion 4.x project layout, registerRoot pattern, calculateMetadata
- `references/composition-patterns.md` - vertical 9:16 with face-track crop, word-by-word captions, hook overlay
- `scripts/render.sh` - single-entry CLI wrapper

## Available add-on packages (already installed at workspaces/clipping/remotion/)

Lean set installed; reach for these in compositions without re-installing:

- `@remotion/captions` - caption data structures (word-level timings, `Caption[]`)
- `@remotion/install-whisper-cpp` - local Whisper transcription. One-time: `npx --no-install @remotion/install-whisper-cpp install` then `npx --no-install @remotion/install-whisper-cpp install-model --model=medium.en`. Then in code: `import {transcribe} from '@remotion/install-whisper-cpp'`.
- `@remotion/transitions` - `<TransitionSeries>` with `fade`, `slide`, `wipe`, `flip`, `clock-wipe`, `cube`, `none` presentations
- `@remotion/google-fonts` - bundles Google Fonts. ALWAYS prefer this over hardcoded font stacks for any composition that might render off-macOS (Lambda, Linux CI). Example: `import {loadFont} from '@remotion/google-fonts/Inter'`.

NOT installed (add only when a use case actually appears):
- `@remotion/lambda`, `@remotion/cloudrun` (cloud rendering)
- `@remotion/three` (3D scenes), `@remotion/lottie`, `@remotion/rive`, `@remotion/skia` (heavy)
- `@remotion/shiki` (animated code blocks, ~10MB), `@remotion/animated-emoji`, `@remotion/gif`, `@remotion/player`, `@remotion/layout-utils` (niche)

To add later: `npm install --prefix workspaces/<name>/remotion --save-exact @remotion/<pkg>@4.0.454`. All `@remotion/*` packages MUST be the exact same version; mismatched versions break the bundler.

## Scaffolding a NEW per-workspace remotion install

When a new workspace genuinely needs its own composition project (not just to use clipping's), follow these in this order or it will fail:

1. `mkdir workspaces/<name>/remotion && cd workspaces/<name>/remotion && npm init -y`
2. Install pinned core: `npm install --save-exact remotion@4.0.454 @remotion/cli@4.0.454 @remotion/bundler@4.0.454 @remotion/renderer@4.0.454 react@19.2.4 react-dom@19.2.4`
3. Install pinned dev: `npm install --save-dev --save-exact typescript@5.7.3 @types/react@19.2.14 @types/react-dom@19.2.3`
4. Install `@babel/parser@7.28.5` as a TOP-LEVEL dep. This is load-bearing: the CLI uses `recast` which needs `@babel/parser` resolvable from top-level node_modules. The transitive copy under `@remotion/studio-server` is too deep, so without an explicit top-level pin, `remotion versions` errors with `Install @babel/parser to use the typescript parser`.
5. Write a minimal `tsconfig.json` (target ES2018, module ESNext, jsx react-jsx, moduleResolution Bundler, strict true, noEmit true) covering `remotion.config.ts` + `src/**/*.ts*`.
6. Write `remotion.config.ts` with `Config.setVideoImageFormat('jpeg')` and `Config.setOverwriteOutput(true)`.
7. Set `"type": "module"` in package.json.
8. Write `src/index.ts` -> `registerRoot(RemotionRoot)`, `src/Root.tsx` with `<Composition id=... />`, `src/Composition.tsx` with the React component.
9. Render: `./node_modules/.bin/remotion render src/index.ts <CompositionID> out/<name>.mp4`. First render of a session downloads Chrome Headless Shell (~150MB) - cached after.
10. Add to `.gitignore`: `node_modules/`, `out/`, `.remotion/`, `.cache/`, `.DS_Store`.

If `npm install` is incremental and you see `Cannot find native binding ... rspack.darwin-arm64.node`, the optional binding got truncated. Fix: `rm -rf node_modules package-lock.json && npm install`.

## Performance

Apple Silicon: roughly 3-10x realtime for 1080x1920 H264 with simple compositions. Heavy filters (B-roll, particles, generated graphics) drop closer to 1x. Use `--concurrency=4` to start; raise if not RAM-bound, lower if you see swap.

## Out-of-scope

- Audio mastering / loudness norm: use ffmpeg `loudnorm`.
- AI-generated video clips: use `_core/skills/higgsfield/`.
- Subtitle generation from raw audio: use a transcript-producing skill (e.g. clipping workspace's `transcribe.py`) and pass words to Remotion as props.
