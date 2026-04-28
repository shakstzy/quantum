# 02-source

Download long-form source content for a verified campaign. Document rights status. Persist as `sources` rows.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|--------------|---------------|-----|
| Active campaigns | DB table `campaigns` where status='active' | rules_json: source_creators, allowed_platforms, asset_drive | Defines what is fair game |
| Campaign asset drive | URL from `campaigns.rules_json.asset_drive` if present | Full file | Pre-cleared rights |
| YouTube/podcast URLs | Manual pass via `bash bot/scripts/source.sh <campaign-slug> <url>` | n/a | Bulk ingestion |

## Process

1. Resolve `<campaign-slug>` to a row; abort if status != 'active'.
2. Determine `rights_status`:
   - If campaign provides asset drive containing this URL: `authorized` with evidence pointer.
   - If campaign permits clipping creator X publicly: `campaign_allowed` with rule citation.
   - If neither but creator is publicly documented as encouraging clips: `fair_use_review` with link to creator statement; flag for human confirm.
   - Otherwise: REJECT. Do not download.
3. Run `yt-dlp -f bv*+ba/best -o ~/.quantum/clipping/sources/<source_video_id>.%(ext)s <url>`.
4. Compute `audio_hash` (SHA-256 of decoded mono 16kHz WAV first 60s) for transcript-cache key.
5. Probe duration via `ffprobe`; INSERT into `sources` with all fields populated.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Source video | `~/.quantum/clipping/sources/<source_video_id>.mp4` | mp4 |
| Sources row | DB | SQLite |

## Audit (Pattern 12)

- [ ] `rights_status` is never NULL or `unknown` after this stage.
- [ ] Every `unauthorized` URL was REJECTED, not stored.
- [ ] `audio_hash` is populated (transcript cache key depends on it).
- [ ] Source file is on disk and `filepath` matches.

## Hard Rules

1. Never download anything with `rights_status = unauthorized`.
2. Never re-download an existing `source_video_id` (idempotent).
3. Do not save sources outside `~/.quantum/clipping/sources/`. They are large and unversioned.
