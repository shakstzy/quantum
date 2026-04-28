# Error Taxonomy

How to classify a failure and what to do about it. Write the classification to `output/zernio-result-[ts].json` under `error_class` so the caller can decide.

## Classes

### `retryable_now`

Transient errors that a second attempt within seconds will fix.

- HTTP 5xx from Zernio (not from the downstream platform).
- TLS or connection reset during upload (`curl` exit code 56 or 35).
- Upload URL expired mid-transfer (response body mentions `expires` or 403 with signature error).

Action: retry up to 2 times with 1s, then 5s backoff. If still failing, reclassify as `retryable_later`.

### `retryable_later`

Platform-side limits that will clear on a defined schedule.

- Instagram: `429` or body matches `100 posts per 24-hour rolling window`.
- TikTok: body matches `daily posting limit`.
- YouTube: `quotaExceeded` or `rateLimitExceeded`.

Action: surface the limit reset window to the caller. Do not auto-retry. Write the observed reset window to the result file.

### `fatal_content`

Platform rejected the media or caption for policy reasons. No retry will help.

- Instagram: `Duplicate content detected`, `Instagram blocked your request`, `Cannot process video from this URL`.
- TikTok: `Content flagged for spam/moderation risk`, error codes 30001 (invalid codec), 30005 (processing timeout on validation side).
- YouTube: `videoRejected`, `invalidCategoryId`, `failedPrecondition`.

Action: stop. Return full error to caller. Do not delete output files; caller may need them for a fix.

### `fatal_auth`

Credential problem. No retry until credentials are refreshed.

- HTTP 401 from Zernio.
- Body matches `Instagram access token expired` or equivalent for YT/TT.
- Account disconnected server-side since session start.

Action: stop. Tell caller to reconnect the account via `zernio.com/dashboard/accounts`. Do not rotate the Zernio API key based on this; the Zernio key is fine, the per-account OAuth token is the problem.

### `partial_failure`

Multi-platform post where at least one platform succeeded and at least one failed.

- Response has a `platforms` array with mixed `status` values.
- Common when a cross-post hits one platform's rate limit but not others.

Action: write a full result file. Caller decides whether to retry the failed platforms individually. Do not auto-retry because the successful posts are already live.

### `async_pending`

`posts_create` returned 200 but post status is `processing` or unknown.

Action: poll via `zernio.sh status <post_id>` per PLAYBOOK.md procedure step 9. Terminal states are `published`, `scheduled`, `failed`. If polling reaches the 5-minute budget, reclassify as `async_timeout` and surface to caller.

## What NOT to do

- Do not auto-retry a post that returned a success status but has a `failed` async status. That was a platform rejection, not a network blip. Reclassify as `fatal_content`.
- Do not delete a scheduled post on error. Caller may want to fix and unschedule manually.
- Do not rotate the Zernio API key on any error class. That would lock the caller out of everything else.
- Do not swallow errors and return a synthesized success. Every error class writes to the result file; nothing is hidden.
