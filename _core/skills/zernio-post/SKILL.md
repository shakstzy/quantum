---
name: zernio-post
description: Publish a piece of content to Instagram, YouTube, or TikTok via the Zernio REST API. Handles local file upload, TikTok creator-info precheck, payload assembly, confirmation gate, post call, and status polling. Use when an agent or workspace needs to push a finished artifact to one or more of Adithya's social accounts. Do NOT use for DMs, comments, ads, analytics, or platforms other than IG/YT/TT.
---

# Zernio Post

Direct-REST skill for publishing to Instagram, YouTube, and TikTok.

Deliberately NOT an MCP wrapper. Zernio's hosted MCP exposes 280+ tools, which ambient-load into every session and pollute context. This skill calls the REST API directly via `scripts/zernio.sh` (curl) so nothing is loaded until the skill is invoked.

## When this fires

Trigger phrases: "post to IG", "publish this reel", "drop this on TikTok", "upload to YouTube", "cross-post this", "publish the finished artifact".

Do NOT fire for:
- Reading DMs, replying to comments, or analytics lookups (not covered; use Zernio dashboard).
- Platforms other than IG, YT, TikTok (future references/ files can extend; do not improvise).
- Paid ads, audience sync, conversion events (CAPI / Google `ingestEvents`), ad-level analytics. Those live in the sibling `_core/skills/zernio-ads/` playbook (covers all six Zernio ad platforms: `metaads`, `googleads`, `linkedinads`, `tiktokads`, `pinterestads`, `xads`). Trigger phrases route there, not here. Same `ZERNIO_API_KEY`, but a tighter `LAUNCH-AD` gate replaces `PUBLISH` because every write path moves real money or sends PII to a paid platform. See `references/ads-api.md` for the cross-link.
- Content that has not yet been approved by the caller. The skill publishes; it does not draft.

## Required caller inputs

Before the skill runs, the caller MUST supply every field in `rules/call-shape.md`. If any are missing, stop and ask. Do not guess.

## Procedure

1. **Load references.** Read `references/<platform>.md` for each target platform. Read `rules/preflight.md`, `rules/confirmation-gate.md`, `rules/error-taxonomy.md`, `rules/ai-disclosure.md`.
2. **Resolve accounts.** If caller passed an alias (e.g. `my-ig`), resolve to `accountId` via `~/.zernio/accounts.yaml`. Accept natural-language variants: "my ig" / "my instagram" / "my personal ig" -> `my-ig`; "my yt" / "my youtube" -> `my-youtube`; "my tiktok" / "my tt" -> `my-tiktok`. If the registry is missing or the alias (after normalization) is not found, call `scripts/zernio.sh accounts` and surface the list to the caller to pick from, then write the registry.
3. **TikTok precheck (mandatory).** For every TikTok target, call `scripts/zernio.sh creator-info <accountId>` and confirm the caller's requested `privacy_level` is in the returned `privacyLevels` array. If not, stop. Do not post with a guessed value. Also surface `postingLimits` so the caller knows remaining daily budget.
4. **Preflight media.** Call `scripts/zernio.sh preflight <file> <platform> [surface]` for every media file against every target platform. For Instagram, pass the surface (`feed`, `story`, `reels`, `carousel`) so the correct size cap applies (Story is 100MB, Reel/feed is 300MB). Apply checks in `rules/preflight.md`. The script fails hard on: missing file, zero bytes, wrong MIME, oversize, and (when ffprobe is present) aspect-ratio or duration violations.
5. **Upload media.** For each file, call `scripts/zernio.sh upload <file>`. Returns `{publicUrl}`. The upload URL TTL is undocumented by Zernio; treat it as short and retry on expiry.
6. **Assemble payload.** Build the JSON for `POST /posts` by combining caller inputs with platform-specific shape from the matching `references/*.md`. Apply AI-disclosure flags only as the caller specified (no default-on policy; see `rules/ai-disclosure.md`). For TikTok targets, explicitly verify that `content_preview_confirmed` and `express_consent_given` are present and true before proceeding; these are legal flags that the skill never defaults. If `draft: true` for TikTok, force `publishNow: false` in the payload. Save the assembled payload to `output/zernio-payload-[ts].json` (stage `output/` if invoked inside a stage, otherwise `~/.zernio/output/`) before the next step.
7. **Confirmation gate (Pattern 11).** Present the full assembled payload to the user and require a literal `PUBLISH` token in response before proceeding. If env `ZERNIO_NO_CONFIRM=1` is set, skip this step (scripted-context escape hatch; log that it was skipped). See `rules/confirmation-gate.md`.
8. **Post.** Call `scripts/zernio.sh post zernio-payload-[ts].json`. Capture the full response. Write request and response to `output/zernio-result-[ts].json`.
9. **Poll status.** Call `scripts/zernio.sh status <post._id>` and poll until terminal state (`published`, `scheduled`, `failed`). Zernio reports some transcoding failures asynchronously, so `posts_create` returning 200 does not mean the post is live. Write final status to the result file.
10. **Audit.** Run every check in the Audit table below. If any fail, surface them. Do not claim success on a silent failure.

## Checkpoint (Pattern 11)

| After step | Agent presents | Human decides |
|------------|----------------|---------------|
| 6 | Full assembled payload (all platforms, all fields, all media URLs, all AI flags) | Type `PUBLISH` to confirm, or edit a field, or abort |

The checkpoint is mandatory unless `ZERNIO_NO_CONFIRM=1` is explicitly set in the caller's environment. This is the write-path safety rail called out by the adversarial review. Do not bypass it implicitly.

## Audit (Pattern 12)

Run after step 9, before declaring done:

| Check | Pass condition |
|-------|----------------|
| All uploads returned 2xx | `publicUrl` present for every media file |
| Payload saved before post | `output/zernio-payload-[ts].json` exists |
| Post response captured | `output/zernio-result-[ts].json` exists with request and response |
| Terminal status reached | Final `status` is `published` or `scheduled` (not `processing` or `failed`) |
| TikTok only: `privacy_level` matched creator-info | Value was in `privacyLevels` response |
| YouTube only: `madeForKids` matches caller input | Field is explicitly set, not defaulted |
| No AI-disclosure surprise | `containsSyntheticMedia` / `video_made_with_ai` values match caller inputs (not skill defaults) |

## Budget

- Live posts per run: no hard cap; platform rate limits apply (IG 100/24h rolling, TT daily varies, YT quota units).
- Upload bytes per run: no cap; preflight rejects oversize files.
- Status polling: max 60 iterations at 5s each (5 minutes). After that, leave status as last observed and surface to caller.

## Files

- `rules/call-shape.md` — required caller input contract
- `rules/preflight.md` — local file validation rules, platform-specific
- `rules/confirmation-gate.md` — confirmation-gate semantics, `ZERNIO_NO_CONFIRM` override
- `rules/ai-disclosure.md` — caller sets AI flags per-post; skill warns, does not default
- `rules/error-taxonomy.md` — retryable vs fatal, partial-failure handling
- `references/instagram.md` — `platformSpecificData` shape for feed/carousel/story/reel
- `references/youtube.md` — title/category/visibility/madeForKids/Shorts auto-detection
- `references/tiktok.md` — creator-info precheck, privacy_level enum, consent flags
- `references/ads-api.md`: forward reference for Zernio's unified Ads API. Out of scope for this playbook; consumed when the future `zernio-ads` sibling is built.
- `scripts/zernio.sh` — single-entry curl wrapper (accounts, creator-info, preflight, presign, upload, post, status)
