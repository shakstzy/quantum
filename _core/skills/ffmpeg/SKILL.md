---
name: ffmpeg
description: Audio and video transcoding, trimming, concat, extraction, and resizing via the `ffmpeg` CLI. Already installed (Homebrew, ffmpeg 8.x). Use for compressing video, extracting audio, trimming clips, generating thumbnails/GIFs, normalizing audio, and converting between formats. Do NOT use for live streaming setups, hardware-encoder tuning, broadcast pipelines, or video editing UIs (Premiere, FCP, Resolve).
---

# ffmpeg

Trigger doc for routing Claude to `ffmpeg` when media work shows up. Tool is already installed (`/opt/homebrew/bin/ffmpeg`, version 8.x). No auth, no keychain. This skill teaches Claude *when* to reach for ffmpeg and the small set of verbs Adithya uses repeatedly.

## When this fires

Trigger phrases (semantic, non-exhaustive): "compress this video", "shrink this mp4", "convert <file> to <format>", "extract audio from this video", "rip the audio out", "trim this clip from <start> to <end>", "cut this video", "make a gif from this", "resize this video to <res>", "downscale to 720p", "make a thumbnail", "concat these clips", "join these videos", "normalize the audio in this", "transcode for whatsapp / iMessage / web", "what's the duration of this", "probe this file", "strip the audio from this video", "speed this up 2x", "slow this down".

Do NOT fire for:
- Live streaming pipelines (RTMP relay, OBS bridge). Different territory.
- Hardware-encoder tuning (NVENC, QSV, VideoToolbox profiles) beyond the macOS `h264_videotoolbox` defaults.
- DRM'd content or anything DRM-removal-adjacent. Hard refuse.
- Editing tasks where a UI is the right answer (multi-track timeline, color grade, transitions).
- Image-only tasks. Use ImageMagick or a Python tool. ffmpeg can do single images but it's not the right hammer.

## Procedure

1. **Probe first for non-trivial inputs.** Run `ffprobe -v error -print_format json -show_streams -show_format <input>` if you don't already know codec, duration, resolution, or audio channels. Cheap and prevents bad assumptions.
2. **Pick the right preset.** Default to `-c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k` for general-purpose mp4. Switch to `h264_videotoolbox` for hardware-accelerated encodes when speed matters more than file size (3-5x faster, slightly larger files).
3. **Always set output explicitly.** Never use `-y` (overwrite) without confirming the user wants to overwrite an existing file.
4. **For destructive ops** (overwriting, in-place transcode, deleting source), preview command + paths in chat and confirm before running.
5. **Stream copy when you can.** If only trimming or container-swapping, `-c copy` avoids re-encode. 100x faster, lossless.
6. **Audit.** Run the Audit table below.

## Common patterns

| Intent | Command |
|--------|---------|
| Probe a file | `ffprobe -v error -print_format json -show_streams -show_format <in>` |
| Compress mp4 (general purpose) | `ffmpeg -i <in> -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k <out>.mp4` |
| Compress fast (hardware-accelerated, macOS) | `ffmpeg -i <in> -c:v h264_videotoolbox -b:v 4M -c:a aac -b:a 128k <out>.mp4` |
| Trim without re-encode | `ffmpeg -ss <start> -to <end> -i <in> -c copy <out>.mp4` |
| Trim with re-encode (frame-accurate) | `ffmpeg -i <in> -ss <start> -to <end> -c:v libx264 -crf 20 -c:a aac <out>.mp4` |
| Extract audio (mp3) | `ffmpeg -i <in> -vn -c:a libmp3lame -q:a 2 <out>.mp3` |
| Extract audio (lossless) | `ffmpeg -i <in> -vn -c:a copy <out>.<ext>` |
| Strip audio | `ffmpeg -i <in> -an -c:v copy <out>.mp4` |
| Resize to 720p (preserve AR) | `ffmpeg -i <in> -vf "scale=-2:720" -c:v libx264 -crf 23 -c:a copy <out>.mp4` |
| Resize to 1080p | `ffmpeg -i <in> -vf "scale=-2:1080" -c:v libx264 -crf 21 -c:a copy <out>.mp4` |
| GIF (good quality, palette) | Two-pass: `ffmpeg -i <in> -vf "fps=15,scale=480:-1:flags=lanczos,palettegen" palette.png` then `ffmpeg -i <in> -i palette.png -lavfi "fps=15,scale=480:-1:flags=lanczos [x]; [x][1:v] paletteuse" <out>.gif` |
| Single thumbnail at <t> | `ffmpeg -ss <t> -i <in> -frames:v 1 -q:v 2 <out>.jpg` |
| Concat (same codec) | `ffmpeg -f concat -safe 0 -i list.txt -c copy <out>.mp4` (list.txt has `file 'a.mp4'` lines) |
| Concat (mixed codecs) | `ffmpeg -i a.mp4 -i b.mp4 -filter_complex "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]" -map "[v]" -map "[a]" <out>.mp4` |
| Speed up 2x (video + audio) | `ffmpeg -i <in> -filter_complex "[0:v]setpts=0.5*PTS[v];[0:a]atempo=2.0[a]" -map "[v]" -map "[a]" <out>.mp4` |
| Slow down to 0.5x | `ffmpeg -i <in> -filter_complex "[0:v]setpts=2*PTS[v];[0:a]atempo=0.5[a]" -map "[v]" -map "[a]" <out>.mp4` |
| Loudness-normalize audio | `ffmpeg -i <in> -af loudnorm=I=-16:TP=-1.5:LRA=11 -c:v copy <out>.mp4` |
| WhatsApp / iMessage friendly | `ffmpeg -i <in> -c:v libx264 -preset slow -crf 26 -vf "scale='min(1280,iw)':-2" -c:a aac -b:a 96k -movflags +faststart <out>.mp4` |
| Web-friendly (faststart) | Add `-movflags +faststart` to any mp4 output |

## Quality dial (CRF)

For `libx264`: lower CRF = higher quality + larger file. Sane band:

- `crf 18`: visually lossless, very large
- `crf 20`: high quality, large
- `crf 23`: default, good quality, reasonable size  ← start here
- `crf 26`: noticeably compressed, fine for casual sharing
- `crf 28+`: visible artifacts, only for hard size limits

For `libx265`: subtract ~6 from x264 CRF for similar quality (i.e. `crf 28` h265 ≈ `crf 22` h264). Half the file, double the encode time, less compatible.

## Audit (Pattern 12)

| Check | Pass condition |
|-------|----------------|
| Input probed | For non-trivial inputs, ran `ffprobe` before transcoding |
| Output explicit | No `-y` flag unless user confirmed overwrite |
| Codec/container match | Output extension matches the codec (mp4 ↔ libx264/aac, webm ↔ vp9/opus, etc.) |
| Stream copy used when possible | If trim/container-only, `-c copy` was used to avoid re-encode |
| Faststart for web mp4 | `-movflags +faststart` set when output will be uploaded or streamed |
| No source clobber | Source file path != output file path |
| Path safety | Filenames with spaces / special chars are quoted |

## Reference

- `ffmpeg -h full` for the full flag tree.
- Authoritative reference: `https://ffmpeg.org/ffmpeg.html` and `https://trac.ffmpeg.org/wiki`.

## Known limitations

- This skill is x86/Apple-Silicon macOS-tuned. Hardware encoder names (`h264_videotoolbox`, `hevc_videotoolbox`) are macOS-specific.
- AV1 (`libsvtav1`, `libaom-av1`) is supported by Homebrew ffmpeg 8.x but encode times are long. Use only when explicitly asked.
- Subtitle burn-in via `subtitles=` filter requires `libass`, which Homebrew ffmpeg ships with. SRT works out of the box.
- Live capture (`avfoundation` device input) not covered here. Add a section if recurring.
