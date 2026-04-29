# 04-edit

Cut the rendered clips into 1 hero edit + 9x16 + 1x1 variants using ffmpeg.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|---------------|---------------|-----|
| Render manifest | `../03-render/output/<product-slug>-renders.json` | Full file | mp4 paths in order |
| Picked script | `../02-script/output/<product-slug>-picked.md` | B-roll cues, captions | Edit decisions |
| Host voice | `../../shared/hosts/<host-id>/voice.md` | tone | Caption styling |

## Process

1. Read manifest. Concatenate clips in order (ffmpeg `concat` demuxer, no re-encode if codecs match).
2. Apply standard cuts from the source-video pattern: trim filler ("mhm", reaching for product), overlap audio across cut points so transitions feel natural.
3. Burn captions:
   - Generate caption track via Whisper on the assembled audio (use `whisper.cpp` or whatever's local; if not installed, surface and stop).
   - Color host lines blue, guest lines orange (per the source video).
   - Font: Montserrat. Add black shadow for legibility.
4. Insert subtle keyframe zooms at the start of each clip (3-5s mark, increases retention).
5. Insert B-roll per script cues. B-roll source TBD; for v1, leave gaps marked `BROLL: <description>` in the output and skip insertion.
6. Add curiosity sound bed (low-volume music, royalty-free, sourced from `~/.quantum/ad-factory/sound-library/`, empty for v1).
7. Render three deliverables:
   - `hero.mp4`: 16:9 or original aspect, source-of-truth edit.
   - `9x16.mp4`: vertical, center-crop, captions repositioned to safe zone.
   - `1x1.mp4`: square, center-crop.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Hero edit | `~/.quantum/ad-factory/edits/<product-slug>/hero.mp4` | mp4, h264 |
| Vertical | `~/.quantum/ad-factory/edits/<product-slug>/9x16.mp4` | mp4, h264 |
| Square | `~/.quantum/ad-factory/edits/<product-slug>/1x1.mp4` | mp4, h264 |
| Edit log | `output/<product-slug>-edit.json` | JSON: input clips, ffmpeg commands run, durations, sizes |

## Audit

- All 3 deliverables exist and are non-zero bytes
- Each plays end-to-end without dropped frames (ffprobe check)
- Captions are burned, not separate track (platforms strip sidecar tracks)
- Audio is normalized (loudnorm filter pass)
- Total duration is 30-90 seconds (longer than that and TikTok / Reels truncate)

## v1 trade-offs

- Manual polish in CapCut still expected for B-roll insertion. Stage emits a "BROLL: <cue>" overlay so the operator can hand-finish in CapCut without tracking down each cue.
- Remotion (skill at `_core/skills/remotion/`) is the v2 upgrade for word-by-word caption animations.
