# TODO

Captured from the Codex code-review pass on 2026-04-28. Items 1, 2, 5, 6, 8 were
fixed in the same session. Remaining items are documented limitations of v1, fix
in v2 once we have first payouts and the system is proven valuable enough to
harden.

## Deferred from Codex review v1

### M1 (medium): SQLite TOCTOU across logical units

- Files: `gate.py`, `source.py`, `transcribe.py`, `clip.py`
- Risk: race conditions in low-concurrency single-operator setting are theoretical.
  Single Mac, single operator, sequential pipeline.
- Fix v2: add transaction-scoped DB functions (`upsert_source_after_download`,
  `get_or_create_transcript`, `insert_candidate_with_duplicate_check`) using
  `BEGIN IMMEDIATE` where the next write depends on the read.

### M2 (medium): Quota check race in `gate._account_cadence` + `publish.create_publish_attempt_after_gate`

- Files: `gate.py:_account_cadence`, `db.py:create_publish_attempt_after_gate`
- Risk: two simultaneous `publish.py` runs can both pass the cap check, then both
  insert. Today the operator never runs publish in parallel; documented to never
  fire two publish.py concurrently in CLAUDE.md hard rules.
- Fix v2: move cadence check INTO the same `BEGIN IMMEDIATE` transaction inside
  `create_publish_attempt_after_gate`. Or add a `publish_reservations` table.

### M3 (medium): N-gram exact-SHA matching is brittle

- File: `fingerprint.py`, `db.py:find_duplicate_candidates`
- Risk: a single ASR correction or boundary trim creates a different sorted-set
  hash and slips past the duplicate gate. We compensate today with the perceptual
  hash side, which catches near-duplicate frames even when text differs.
- Fix v2: store individual normalized 8-gram shingles in a separate
  `clip_shingles` table; compare via Jaccard `>= 0.75`; fall back to current
  exact-SHA as a fast-path check.

### M4 (medium): `campaign_id NOT NULL` is wrong paid-disclosure heuristic

- Files: `schema.sql`, `gate.py:_disclosure_check`
- Risk: today every candidate has a campaign so disclosure is always required.
  This is over-disclosure (safe direction) but does not capture the FTC's actual
  three-pronged test (compensation + promotion + audience-knowledge).
- Fix v2: add to `clip_candidates`:
  - `compensation_expected BOOLEAN`
  - `promotional_relationship BOOLEAN`
  - `audience_connection_obvious BOOLEAN`
  Gate `_disclosure_check` reads these instead of `campaign_id`.

### M5 (medium): Face tracking is Haar at 1Hz with EMA, Remotion math approximate

- Files: `compose.py:detect_face_track`, `remotion/src/compositions/ClipComposition.tsx`
- Risk: visible quality issue (snapping, drift, profile-face miss) but no
  publish-safety risk. Acceptable for v1; a 50-second talking-head clip looks
  fine 80% of the time.
- Fix v2:
  - Replace Haar with MediaPipe FaceMesh OR YOLOv8-face at 5-10 fps.
  - Hold-last-known fallback instead of center fallback.
  - Reset on scene cuts (already detected by PySceneDetect).
  - Remotion: switch the source to `objectFit: cover`, compute pixel offsets
    from the source dimensions and the cover scale, clamp to crop bounds, then
    apply pixel `translate3d(...) scale(...)`.

### M6 (low): zernio-post payload is v1 minimal, not full per-platform schema

- File: `publish.py:publish_candidate`
- Risk: today the live publish path will likely 4xx on first try because the
  payload is missing per-platform shape (TikTok creator-info pre-check, IG
  Branded Content flag, YouTube paidPromotion). Default is dry-run so this does
  not silently fail.
- Fix v2: parse `_core/skills/zernio-post/references/<platform>.md` and build
  the full `platformSpecificData` blob per target. Add the TikTok creator-info
  precheck step before assembling the payload.

## Open product questions

- Q1: should `discover` automatically promote `pending` to `active` after N days
  of paid-out evidence? Today it requires manual `verified_at` set.
- Q2: should `track.refresh_metrics` poll on a schedule (launchd) once we have
  first paid views? Today it is on-demand only.
- Q3: caption generator currently emits `#ad #<niche>`. Do we want a richer
  generator that picks 5-10 niche hashtags from a curated list per niche?
  See `shared/prompts/caption.md` (placeholder).
