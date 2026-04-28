# Preflight Media Validation

Client-side file checks that run BEFORE any network call. Purpose: reject obvious failures offline, do not burn upload time or MCP quota on files that were never going to work.

## Universal checks

- File exists at given path.
- File size is greater than 0 bytes.
- MIME type can be read via `file -b --mime-type` (libmagic).
- MIME matches an allowed type for every target platform (see per-platform tables below).

Failure modes: return non-zero exit with a specific error message.

## Instagram

| Media | Allowed MIME | Max size | Duration | Aspect |
|-------|--------------|----------|----------|--------|
| Image (feed) | image/jpeg, image/png | 8 MB | n/a | 0.8 to 1.91:1 |
| Image (story) | image/jpeg, image/png | 8 MB | n/a | 9:16 recommended |
| Image (carousel) | image/jpeg, image/png | 8 MB each | n/a | 1:1 recommended; up to 10 items |
| Video (feed) | video/mp4, video/quicktime (H.264 30fps) | 300 MB | max 60 min | 4:5 to 1.91:1 |
| Video (reels) | video/mp4, video/quicktime | 300 MB | max 90 s | 9:16 (1080x1920) |
| Video (story) | video/mp4, video/quicktime | 100 MB | max 60 s | 9:16 |

Caption max 2,200 chars. Instagram auto-compresses oversize images; the skill still rejects images over 8 MB to keep the upload predictable.

## YouTube

| Media | Allowed MIME | Max size | Duration | Aspect |
|-------|--------------|----------|----------|--------|
| Video (regular) | video/mp4, video/quicktime, video/x-msvideo, video/x-ms-wmv, video/x-flv, video/3gpp, video/webm | 256 GB (verified) | 12 hr (verified) / 15 min (unverified) | 16:9 recommended |
| Video (Shorts) | same | 256 GB | max 3 min | 9:16 (1080x1920) |
| Thumbnail (regular only) | image/jpeg, image/png, image/gif | 2 MB | n/a | 1280x720 recommended |

Shorts is auto-detected by YouTube when duration <= 3 min AND aspect = 9:16. No flag to force.

## TikTok

| Media | Allowed MIME | Max size | Duration | Aspect |
|-------|--------------|----------|----------|--------|
| Video | video/mp4, video/quicktime, video/webm (H.264 30fps) | 4 GB | 3 s to 10 min | 9:16 only viable |
| Image (carousel) | image/jpeg, image/png, image/webp | 20 MB each | n/a | 9:16 recommended; up to 35 items |

Caption: videos 2,200 char max; photo carousels 4,000 char max.

Cannot mix video and image in a single TikTok post. If caller passes mixed types with TikTok target, stop.

## Cross-platform posts

If the caller targets multiple platforms with the same file, preflight runs the intersection of constraints. A single file that passes all targets is the most common valid shape. If constraints conflict (e.g. 16:9 horizontal MP4 targeting TikTok), stop and surface which platform rejected.

## What preflight does NOT check

- Codec details beyond MIME (bitrate, frame rate, color space). Platforms validate these server-side after upload and may reject silently. Surface any such failure via `error-taxonomy.md`.
- Content policy. No AI moderation runs locally.
- Copyright. No audio-ID check runs locally.
- Whether the account is rate-limit-capped right now (check via `creator-info` or by the 429 response).

## Script

`scripts/zernio.sh preflight <file> <platform>` returns a JSON blob with `{file, size, mime, platform, warnings[]}` on pass, or exits non-zero with a diagnostic on fail. ffprobe is used opportunistically for duration and dimensions when available; absence does not fail the check.
