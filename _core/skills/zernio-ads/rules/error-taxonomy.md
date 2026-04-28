# Error taxonomy

How to interpret Zernio Ads API error responses and decide retry vs surface vs abort.

## Add-on required (403)

If a write call returns 403 with `add_on_required` (or any wording mentioning the Ads add-on):
- DO NOT retry.
- Surface to the user: "The Zernio Ads add-on is not enabled on your account. Enable it at zernio.com/settings/billing (Build $10/mo, Accelerate $50/unit, Unlimited $1,000/mo) and try again."
- Stop the playbook.

## Auth (401)

If 401 with `Unauthorized`:
- DO NOT retry.
- Surface: "ZERNIO_API_KEY is missing, expired, or revoked. Check `.claude/settings.local.json` and zernio.com Settings -> API Keys."
- Stop.

## Validation (422)

If 422 with a field-level message:
- DO NOT retry.
- Quote the exact field and message back to the user. Do not silently rewrite the payload.
- Common cases:
  - `goal` not supported on platform (e.g. `app_promotion` on Pinterest) - amend goal and re-prompt LAUNCH-AD.
  - LinkedIn duplicate-content rejection on boost - the source post text is already on LinkedIn, post a fresh organic version first.
  - Meta `BUDGET_LEVEL_MISMATCH` (409) when updating a campaign budget on an ABO campaign - retry against `PUT /v1/ads/ad-sets/{adSetId}` instead.
  - Meta `special_ad_category_required` - prompt the user for the category, set it, re-prompt LAUNCH-AD.

## Platform error (4xx with platform-side reason)

If the error is `platform_error` and includes a Meta/TikTok/LinkedIn/etc. error message:
- DO NOT retry. Platform errors are sticky (token scope missing, page not paired with WA, ad-account suspended, daily spend cap hit).
- Quote the platform's message verbatim. Common ones:
  - Meta `(#100) Invalid parameter` - usually wrong adAccountId format, missing pixel for conversion goal, or invalid targeting interest ID.
  - Meta `(#200) Permissions error` - the connected token lacks `ads_management`. Re-run `connect-ads` to refresh scopes.
  - LinkedIn `INVALID_PARAMETER_VALUE r_organization_admin` - the LinkedIn token lacks the required organization-admin scope. Re-run `connect-ads linkedin <accountId>`.
  - TikTok `40002 - account not approved` - the TikTok ad account is in pending review.

## Rate limit (429)

If 429:
- Honor the `Retry-After` header (or default to 60s) and retry ONCE.
- If the second attempt also 429s, abort and surface. Don't loop.
- For Meta-specific rate limits, sometimes the limit is per-app and sometimes per-ad-account; the response should say which.

## Network / 5xx

If `curl` exits non-zero (DNS, connect, TLS) or the API returns 5xx:
- Retry up to 2 times with 5s and 15s backoff.
- If still failing, abort and surface.

## Partial failure on bulk operations

`bulk-status` and `add-audience-users` return per-row results:
- Single bad row does not fail the whole batch.
- Parse the response: `{ updated: [...], failed: [{id, reason}] }`.
- Always surface every failed row to the user. Do not silently retry failed rows; the reason is usually data-shape (deleted campaign, malformed phone, etc.).

## Status polling

`pending_review`, `processing`, `learning` are non-terminal but valid. Poll until terminal (`active`, `paused`, `rejected`, `cancelled`). Terminal does NOT mean "spending":
- `pending_review` is final from Zernio's perspective once seen, but it's the platform that decides when it goes `active`. Surface the state truthfully.
- `rejected` is terminal; quote the platform's `rejectionReason` field.

## Ads add-on minimums

LinkedIn enforces $10/day and $100 lifetime minimums. Meta and TikTok have similar floors that vary by goal. If a 422 mentions a budget minimum, surface it directly - don't auto-bump the budget.

## What never to do

- Never retry write calls that returned 4xx. The first attempt may have already created a campaign/ad even if the response says error - retrying creates duplicates.
- Never strip or rewrite targeting fields silently to "make it work" after a 422. The user may have asked for that exact targeting on purpose.
- Never claim success when the API returned `pending_review` or `processing`. Say what the actual state is.
