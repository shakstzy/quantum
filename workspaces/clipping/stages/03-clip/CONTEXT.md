# 03-clip

Transcribe (cached forever), rank moments, fingerprint, persist as `clip_candidates`.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|--------------|---------------|-----|
| Source row | DB `sources` | Full row | Identifies file + rights |
| Transcript cache | DB `transcripts` keyed on `(source_id, model_version)` | Cached forever | Adv review v2: never re-whisper |
| Rank prompt | `shared/prompts/rank-moments.md` | Full file | LLM ranking instructions |
| Banned niches | `shared/policy/banned-niches.md` | Full file | Reject moments mentioning banned topics |

## Process

1. **Transcribe (cached).** Look up `(source_id, model_version)` in `transcripts`. If hit: load JSON from `transcripts.filepath`. If miss: run `mlx_whisper` with word-level timestamps, write JSON to `~/.quantum/clipping/transcripts/<source_video_id>-<model>.json`, INSERT row.
2. **Rank moments.** Send transcript chunks (5-min windows with 30s overlap) to Claude via `bot/src/lib/claude.py` using `shared/prompts/rank-moments.md`. Returns top-N `(start_s, end_s, hook, score, rationale)` per chunk.
3. **Filter banned-niche moments.** Drop any candidate whose `transcript_excerpt` matches the banned-keyword regex from `shared/policy/banned-niches.md`.
4. **Cut tight.** For each surviving candidate, refine boundaries via PySceneDetect on the source segment to snap start/end to the nearest shot change inside +/- 1.5s of the LLM-suggested boundary.
5. **Fingerprint.** Compute `ngram_hash` (SHA-256 of normalized 8-gram set from `transcript_excerpt`) and `perceptual_hash` (pHash of one I-frame at clip midpoint via OpenCV).
6. **Dedup score.** Query DB for existing `clip_candidates` with same `ngram_hash` OR with `perceptual_hash` within Hamming distance 6. Set `duplicate_score = max(matched_count / 5, 0..1)`.
7. **Persist.** INSERT each candidate into `clip_candidates` with `status='candidate'`.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Transcript cache | `~/.quantum/clipping/transcripts/<id>-<model>.json` | JSON with words + timestamps |
| Candidates rows | DB | SQLite |
| Cut intermediate | NOT WRITTEN here. Render stage cuts from source on demand. | n/a |

## Audit

- [ ] Transcript was loaded from cache when present (no double-whisper).
- [ ] Every candidate has `ngram_hash` AND `perceptual_hash` populated.
- [ ] Banned-niche regex was applied.
- [ ] No candidate has `start_s >= end_s` or `(end_s - start_s) > 90` seconds.

## Hard Rules

1. Never bypass the transcript cache. Whisper time is the most expensive step.
2. Never write cut mp4s here. Render stage owns mp4 production.
3. Default model: `mlx-community/whisper-large-v3-turbo`. Override via env `CLIPPING_WHISPER_MODEL`.
