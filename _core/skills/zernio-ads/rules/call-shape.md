# Required caller inputs

Per-write-command. If any required field is missing, stop and ask the user. Don't guess values that affect spend, targeting, or PII.

## boost-post (POST /v1/ads/boost)

Required:
- `postId` OR `platformPostId` (one or the other; `postId` is the Zernio internal ID returned by organic publishing)
- `accountId` - Zernio social account that owns the post
- `adAccountId` - platform ad account to spend from. Format varies by platform:
  - Meta: `act_<digits>` (e.g. `act_123456789`)
  - LinkedIn: `urn:li:sponsoredAccount:<digits>` (e.g. `urn:li:sponsoredAccount:12345`)
  - TikTok: numeric advertiser ID (e.g. `7234567890123456789`)
  - Pinterest: business ID
  - X: alphanumeric account ID (e.g. `18ce54d4x5t`)
  - Google: `customers/<digits>` (e.g. `customers/1234567890`)
- `name` - human-readable label, max 255 chars
- `goal` - one of: `engagement`, `traffic`, `awareness`, `video_views`, `lead_generation`, `conversions`, `app_promotion`. Per-platform support:
  - Meta + TikTok: all 7
  - LinkedIn: all except `app_promotion`
  - X: `engagement`, `traffic`, `awareness`, `video_views`, `app_promotion`
  - Pinterest + Google Ads: `engagement`, `traffic`, `awareness`, `video_views`
- `budget.amount` - positive number in `currency` units
- `budget.type` - `daily` or `lifetime`

Optional:
- `budget.currency` - ISO 4217 (defaults to ad account currency)
- `schedule.startDate`, `schedule.endDate` - ISO 8601. STRONGLY RECOMMENDED with daily budgets to bound spend.
- `targeting` - per-platform shape; see `references/<platform>.md`. For Meta, prefer running `search-interests` first to get real interest IDs.
- `bidAmount` - Meta only, max bid cap.
- `tracking` - Meta only, pixel + URL tag specs.
- `specialAdCategories` - Meta only, REQUIRED for housing/employment/credit/political.

## create-ad (POST /v1/ads/create)

Three mutually-exclusive shapes selected by the body:

1. **Legacy single-creative (all platforms, default).** `creative.{...}` at the top level, plus all `boost-post` fields except `postId`/`platformPostId`. Per-platform required creative fields differ; see references.
2. **Meta multi-creative.** `creatives: [{...}, {...}]` array (one ad set, N ads sharing budget+targeting). Meta only.
3. **Meta attach.** `adSetId: "<existing>"` plus a single `creative`. Meta only. Inherits budget+targeting from the existing ad set.

Required common fields: `accountId`, `adAccountId`, `name`, `goal`, `budget`. Per-platform creative requirements live in references.

## create-ctwa (POST /v1/ads/ctwa)

Click-to-WhatsApp ad on Meta. Required:
- `accountId` (Meta posting account that owns the Page paired with WhatsApp)
- `adAccountId`
- `pageId` - the Facebook Page paired with the WhatsApp Business number
- `name`, `budget`, `goal`, `creative.{...}`

Prerequisites enforced by Meta (the API returns `platform_error` if any is missing):
- The Facebook Page must be paired with a verified WhatsApp Business number.
- The WABA must be business-verified.
- The Meta access token must carry `ads_management`.

CTA is locked to `WHATSAPP_MESSAGE`; the ad URL is hard-coded to `api.whatsapp.com/send`.

## update-ad (PUT /v1/ads/{adId})

Body fields are all optional - send only what you're changing:
- `name`
- `status` - `ACTIVE`, `PAUSED`
- `budget.amount`, `budget.type`
- `targeting` - Meta only
- `schedule.endDate`

Multi-field updates land atomically per Meta. LinkedIn and TikTok require status changes via separate calls; the Zernio API normalizes this.

## create-audience (POST /v1/ads/audiences)

Required:
- `accountId` - Zernio ads social account (e.g. `metaads`, `tiktokads`, `pinterestads`)
- `adAccountId`
- `type` - one of: `customer_list`, `website_retargeting`, `lookalike` (Meta-only types beyond customer_list may differ on TikTok/Pinterest; check `references/<platform>.md`)
- `name`

Type-specific:
- `customer_list`: optional initial `users` (max 10,000). Otherwise add via `add-audience-users` after creation.
- `lookalike`: `seedAudienceId` AND `country` codes AND `ratio` (1-10, percent of country pop).
- `website_retargeting`: `pixelId`, `retentionDays`, `eventName`.

## add-audience-users (POST /v1/ads/audiences/{audienceId}/users)

Required:
- `users[]` - max 10,000 per request. Each row: `{ email?: string, phone?: string, externalId?: string }`. At least one of those three. PLAINTEXT - Zernio SHA-256-hashes server-side per Meta's normalization spec. Do NOT pre-hash.

If the caller has more than 10,000 users, chunk and call repeatedly. The local script enforces this cap.

## send-conversions (POST /v1/ads/conversions)

Required top-level:
- `accountId` - Zernio ads social account (Meta or Google).
- `destinationId` - resolved via `conversion-destinations <accountId>`:
  - Meta: pixel (dataset) ID, e.g. `"123456789012345"`.
  - Google: conversion action resource name, e.g. `"customers/1234567890/conversionActions/987654321"`.
- `events[]` - max 1000 per request (Meta cap; Google allows 2000, but the lower cap is the safe default).

Per-event:
- `eventId` - REQUIRED. Stable, unique per event. Meta uses for pixel dedup; Google maps to `transactionId`.
- `eventName` - e.g. `Purchase`, `Lead`, `AddToCart`.
- `eventTime` - ISO 8601 or unix seconds.
- `userData` - PII PLAINTEXT (`email`, `phone`, `firstName`, `lastName`, `externalId`, `clientIpAddress`, `clientUserAgent`, `fbc`, `fbp`, `clickId`). Hashed server-side. Google's Gmail-specific dot/plus-suffix stripping is handled by Zernio.
- `customData` - optional, e.g. `{ value, currency, contentIds, contents }`.

## connect-ads (GET /v1/connect/{platform}/ads)

Required:
- `platform` - one of: `facebook`, `instagram`, `linkedin`, `pinterest`, `tiktok`, `twitter`, `googleads`. The Zernio API derives the ads-platform key (e.g. `facebook` -> `metaads`).

Optional:
- `accountId` - REQUIRED for `tiktok` and `twitter` (separate-token platforms). The new ads SocialAccount is linked to this existing posting account. NOT required for `googleads` (standalone) or same-token platforms (`facebook`, `instagram`, `linkedin`, `pinterest`).

Returns either `{ alreadyConnected: true, ... }` (same-token paths where the parent posting account's OAuth token is reused) or `{ authUrl: "..." }` (separate-token paths needing the user to OAuth into the platform's marketing API).

## campaign-status, ad-set-status

Required: `<id>` and `<ACTIVE|PAUSED>`. Body shape is `{"status": "ACTIVE"}` or `{"status": "PAUSED"}` and is constructed by the script.
