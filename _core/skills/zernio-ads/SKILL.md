---
name: zernio-ads
description: Manage paid ads across Meta (Facebook/Instagram), Google Ads, LinkedIn Ads, TikTok Ads, Pinterest Ads, and X Ads via the Zernio unified Ads REST API (`/v1/ads/*`). Covers ad-account discovery, OAuth-style ads connections, boost-post, standalone-ad creation, campaign and ad-set management, custom audience CRUD with PII hashing, conversion events (Meta CAPI / Google ingestEvents), and analytics. The entire surface (reads AND writes) requires the Zernio Ads add-on enabled in billing, the script surfaces the 403 cleanly. Every write path moves real money and is gated on a LAUNCH-AD confirmation token. Sibling to `zernio-post` (organic publishing). Do NOT use for organic posting, DMs, comments, or reading inbox - those are separate skills or live in the Zernio dashboard.
---

# Zernio Ads

Direct-REST skill for Zernio's Ads API. Sibling to `zernio-post`. Same bearer token, same base URL, but a separate skill so the write-path money-mover sits behind a tighter confirmation gate than organic publishing.

Deliberately NOT an MCP wrapper. Zernio's hosted MCP exposes 280+ tools that ambient-load into every session and pollute context. This skill calls REST directly via `scripts/zernio-ads.sh` (curl + jq) so nothing loads until it fires.

## When this fires

Trigger phrases (semantic, non-exhaustive):

**Read / discovery (safe, no gate):**
- "list my ad accounts" / "what ads accounts do I have" / "show my Meta/LinkedIn/TikTok/Pinterest/X/Google ad accounts"
- "show me my ad spend" / "ad analytics for X" / "how is my campaign doing"
- "show my campaign tree" / "list my campaigns" / "list my ads"
- "list my custom audiences" / "what targeting interests are available for X"

**Connect ad accounts:**
- "connect my Meta ads" / "connect my LinkedIn ads" / "connect my TikTok ads" / "connect my Pinterest ads" / "connect my X ads" / "connect my Google ads"
- "link my ad account on X" / "hook up my X ads to Zernio"

**Write paths (LAUNCH-AD token required):**
- "boost this post" / "promote this post" / "turn this into a paid ad"
- "launch an ad on X" / "create a Meta ad" / "run a LinkedIn campaign" / "spin up a Pinterest promoted pin"
- "create a Click-to-WhatsApp ad" / "CTWA ad on Meta"
- "pause this campaign" / "resume this campaign" / "cancel this ad" / "delete this campaign" / "duplicate this campaign"
- "update my ad budget to X" / "update targeting on this ad" / "rename this ad"

**Audience sync (also LAUNCH-AD gated since it sends PII to Meta):**
- "sync this customer list to a Meta audience" / "create a custom audience from this list" / "add these emails to my Meta audience" / "create a lookalike audience"

**Conversion events (LAUNCH-AD gated; sends user data to Meta CAPI / Google):**
- "send this conversion to Meta" / "fire a CAPI event" / "log this purchase to Google Ads"

Do NOT fire for:
- Organic posting (IG / YT / TT / LinkedIn / Twitter / etc.) - that's `zernio-post`.
- DMs, comments, inbox reads - those live in the Zernio dashboard or future skills.
- Reading or replying to ad comments outside the `ad-comments` read path - moderation lives in the Zernio dashboard for now.
- Any action against an ad platform that is NOT one of the six Zernio supports (e.g. Snapchat ads, Reddit ads). Surface the gap instead.

## Add-on precheck (do this first)

The Zernio Ads add-on gates the ENTIRE `/v1/ads/*` surface, including read paths. Before any ads call, check the organic accounts response, which carries an `adsStatus` field per platform:

```
_core/skills/zernio-post/scripts/zernio.sh accounts | jq '.accounts[] | {platform, adsStatus, displayName}'
```

Values:
- `connected` - the platform's ads side is wired up; reads and writes will work as long as the add-on is enabled.
- `not_connected` - the platform supports Zernio ads but Adithya hasn't run `connect-ads` yet. Offer to run it.
- `not_available` - the platform is NOT supported by Zernio's Ads API (e.g. YouTube). Don't try.

If a `/v1/ads/*` call returns `403 {"error":"Ads add-on required"}` or `add_on_required`, the script surfaces a clean message and exits. Do NOT retry. Tell Adithya to enable the add-on at zernio.com/settings/billing (Build $10/mo, Accelerate $50/unit, Unlimited $1k/mo). Reads are also gated, so don't claim "I'll just list accounts" before the add-on is on.

## Required caller inputs

Before this skill runs, the caller MUST supply every applicable field in `rules/call-shape.md`. If any are missing, stop and ask. Do not guess `accountId`, `adAccountId`, `budget.amount`, `goal`, `schedule`, or `targeting`.

## Procedure

1. **Load references.** Read the platform reference for every target ad platform (`references/<platform>.md`). Read `rules/call-shape.md`, `rules/launch-gate.md`, `rules/audience-sync.md`, `rules/error-taxonomy.md`. If a payload contains creative media, also re-read `_core/skills/zernio-post/rules/preflight.md` and run `_core/skills/zernio-post/scripts/zernio.sh preflight ...` against the file before uploading.
2. **Resolve the social account.** Treat the `accountId` exactly as `zernio-post` does: accept aliases (`my-ig`, `my-fb`, `my-linkedin`) and resolve via `~/.zernio/accounts.yaml`. If absent, call `_core/skills/zernio-post/scripts/zernio.sh accounts` and surface the list.
3. **Resolve the ad account.** Call `scripts/zernio-ads.sh ad-accounts <accountId>` to enumerate the platform ad accounts available for that social account. Pick the right `adAccountId` (Meta: `act_…`; LinkedIn: `urn:li:sponsoredAccount:…`; TikTok: numeric advertiser ID; Google: `customers/<id>`; Pinterest: `<bizId>`; X: `18ce…`). NEVER guess. If the result is empty for the target platform, say so and offer to run `connect-ads` first.
4. **For boost-post calls only:** confirm the source post exists by calling `_core/skills/zernio-post/scripts/zernio.sh status <postId>` and verifying it is `published` on the same `accountId` you intend to boost from.
5. **For media-bearing standalone ads:** run preflight via the organic skill, upload the media to get a `publicUrl`, and reference that URL in the creative. The Ads API does NOT auto-upload local files. Same upload mechanism as organic.
6. **For Meta multi-creative requests:** check `rules/call-shape.md` for the `creatives[]` shape. Wrong shape returns 422 with no clear hint.
7. **Assemble payload.** Build the JSON for the target write endpoint per `references/<platform>.md`. Save to `output/zernio-ads-payload-[ts].json` (stage-local `output/` if invoked inside a stage; otherwise `~/.zernio/output/`). For audience-sync (`add-audience-users`), enforce the 10,000-user-per-request cap locally; chunk if larger.
8. **Show the dollar exposure.** Compute the worst-case spend before the LAUNCH-AD prompt. For daily budgets: `amount * (endDate - startDate in days)`. For lifetime budgets: `amount` as-is. Surface this number in the prompt.
9. **LAUNCH-AD gate.** Present the full assembled payload AND the computed dollar exposure to the user. Require a literal `LAUNCH-AD` token in response before proceeding. PUBLISH (used by `zernio-post`) is NOT accepted here. If env `ZERNIO_NO_CONFIRM=1` is set, skip this step and log that it was skipped (scripted-context escape hatch). See `rules/launch-gate.md`.
10. **Call the write endpoint.** Use the matching `zernio-ads.sh` subcommand. Capture the full response. Write request and response to `output/zernio-ads-result-[ts].json`.
11. **Poll status (where applicable).** For `boost-post` and `create-ad`, the response returns the ad's `_id` and an initial `status` (`active`, `pending_review`, `error`, etc.). If the status is non-terminal, poll `scripts/zernio-ads.sh get-ad <adId>` every 30s until it reaches a terminal state (`active`, `pending_review`, `paused`, `rejected`, `cancelled`). Cap at 20 iterations (10 min). Don't claim "launched" while still in `pending_review` - that's pending platform approval, not live.
12. **Audit.** Run every check in the Audit table below. Surface any failure rather than silently claiming success.

## Checkpoints

| After step | Agent presents | Human decides |
|------------|----------------|---------------|
| 7 | Full assembled payload (every field, every audience entry count, every targeting block, dollar exposure) | Type `LAUNCH-AD` to confirm, edit a field, or abort |

The checkpoint is mandatory unless `ZERNIO_NO_CONFIRM=1` is set in the caller's environment. Audience-sync (`create-audience`, `add-audience-users`) is also gated because it sends PII to Meta. Conversion events (`send-conversions`) are also gated because they send user data to ad platforms.

## Audit

Run after step 11, before declaring done:

| Check | Pass condition |
|-------|----------------|
| Payload saved before write | `output/zernio-ads-payload-[ts].json` exists |
| Response captured | `output/zernio-ads-result-[ts].json` exists with request and response |
| Ad reached terminal status | `status` is one of `active`, `pending_review`, `paused`, `rejected`, `cancelled` (not `processing` or unset) |
| Boost only: source post was published on same accountId | Verified in step 4 |
| Audience sync only: user count chunked under 10,000 / request | All chunks returned 2xx |
| Audience sync only: PII sent as plaintext (Zernio hashes server-side) | No client-side hashing applied |
| Conversion only: stable `eventId` set on every event | For Meta dedup against pixel and Google `transactionId` mapping |
| Special-category ad (Meta only) | If the ad targets housing/employment/credit/political, `specialAdCategories` was set explicitly |
| Dollar exposure matched LAUNCH-AD prompt | Same number quoted to user |

## Add-on requirement

All `/v1/ads/*` endpoints require Zernio's "Ads add-on" billing tier. If the API returns 403 with `add_on_required` (or similar), surface it directly: the user has to enable the Ads add-on in zernio.com billing settings. Do NOT retry. Pricing as of 2026-04-22:
- Build: $10/mo
- Accelerate: $50/unit/mo
- Unlimited: $1,000/mo

## Budget

- Live writes per run: no hard cap; platform rate limits apply.
- Audience-sync rows per request: 10,000 (enforced locally; chunk larger lists).
- Status polling: max 20 iterations at 30s each (10 minutes).

## Files

- `rules/call-shape.md` - required caller input contract for every write path
- `rules/launch-gate.md` - LAUNCH-AD confirmation gate semantics, `ZERNIO_NO_CONFIRM` override
- `rules/audience-sync.md` - PII handling, 10k chunking, lookalike rules, plaintext-not-hashed
- `rules/error-taxonomy.md` - retryable vs fatal, add-on-required, special-category, partial-failure
- `references/linkedinads.md` - LinkedIn boost-post (Sponsored Content), urn format, $10/day floor, B2B targeting roadmap
- `references/metaads.md` - Meta boost + standalone, ad-set hierarchy, CBO/ABO, custom audiences, CTWA, Conversions API
- `references/googleads.md` - Search + Display campaigns, customer-id format, no-boost limitation, Conversions API
- `references/tiktokads.md` - Spark Ads (boost), standalone campaigns, custom audiences, advertiser-id format
- `references/pinterestads.md` - Promoted Pin campaigns, basic audiences, Pinterest pin requirements
- `references/xads.md` - Standalone campaigns, promote tweets, no audience sync, line-item hierarchy
- `scripts/zernio-ads.sh` - single-entry curl wrapper (read + write commands; see help for full list)

## Cross-skill notes

- The same `ZERNIO_API_KEY` works for organic and ads. No separate auth.
- Ad accounts are connected via `GET /v1/connect/{platform}/ads`, NOT `GET /v1/connect/{platform}` (which is the organic-posting flow). Use `connect-ads` only after the organic posting account already exists for that platform (except `googleads`, which is standalone).
- For "boost this Zernio post", the calling chain is: `zernio-post` (publish) -> wait for analytics -> `zernio-ads` (boost the winner). The post's `_id` from organic is the `postId` for `boost-post`.
