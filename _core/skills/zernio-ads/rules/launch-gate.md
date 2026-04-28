# LAUNCH-AD confirmation gate

Every write path in `zernio-ads.sh` moves real money or sends PII / user data to a paid platform. The gate is mandatory before any of these calls:

| Command | Why gated |
|---------|-----------|
| `boost-post` | Spends from the connected ad account |
| `create-ad` | Spends from the connected ad account |
| `create-ctwa` | Spends from the connected Meta ad account |
| `update-ad` (when changing budget or status to ACTIVE) | Increases or resumes spend |
| `cancel-ad` | Visible to platform; affects active campaigns |
| `update-campaign`, `update-ad-set` (when changing budget) | Increases spend |
| `campaign-status`, `ad-set-status` (ACTIVE) | Resumes spend |
| `delete-campaign` | Cascades on Meta; not reversible |
| `duplicate-campaign` | Creates new spending campaign |
| `bulk-status` (any ACTIVE) | Resumes spend across many campaigns |
| `create-audience` | Sends PII (or seed audience IDs for lookalikes) to Meta |
| `add-audience-users` | Sends PII to Meta |
| `delete-audience` | Visible on Meta; can break running campaigns referencing it |
| `send-conversions` | Sends user-event data to Meta CAPI / Google ingestEvents |
| `connect-ads` | Pulls in OAuth scopes; visible to the platform |

## What to show before the gate

Every gate prompt MUST include:

1. **Subcommand and platform.** "boost-post on linkedinads", "create-audience on metaads", etc.
2. **Full assembled payload.** Pretty-printed JSON, not summarized. Include every targeting field, every creative URL, every consent flag.
3. **Dollar exposure.** Computed worst-case spend.
   - `budget.type === "daily"` and a `schedule.endDate`: `amount * (endDate - startDate in calendar days)`. If `startDate` is missing, default to today.
   - `budget.type === "lifetime"`: `amount` as-is.
   - `budget.type === "daily"` with no end date: surface "OPEN-ENDED daily spend at $X/day, no auto-stop". Treat as a flag - the user should usually set an end date.
4. **PII volume (audience-sync only).** "Sending 4,217 plaintext emails + 1,803 plaintext phone numbers to Meta. Hashed server-side by Zernio."
5. **Special-category flag (Meta only).** If `specialAdCategories` is set (housing, employment, credit, political), call it out explicitly so the user can confirm it's intentional. If it's missing on a payload that looks like one of those categories, ASK before launching - Meta will reject otherwise.

## The token

Accept exactly the literal string `LAUNCH-AD` (case-sensitive, no surrounding whitespace, no quotes). Anything else - including `PUBLISH` (the organic-publish token), `yes`, `confirm`, `go` - is a no. If the user types something else that clearly means yes ("yeah do it", "looks good", "send it"), DO NOT proceed. Re-prompt with: "Type `LAUNCH-AD` to confirm, or describe an edit."

PUBLISH is intentionally NOT accepted here. Organic posting and paid ads are two different risk surfaces; reusing the same token blurs them.

## ZERNIO_NO_CONFIRM escape hatch

If the env var `ZERNIO_NO_CONFIRM=1` is set in the calling shell, skip the LAUNCH-AD gate and log that it was skipped. This is for scripted contexts (e.g. an upstream skill that already gated the user). Never set this var inside this skill. Never suggest the user set it as a workaround for a confusing payload.

## After the gate

Once `LAUNCH-AD` is received, write the payload to `output/zernio-ads-payload-[ts].json` BEFORE making the API call. If the call fails or partial-fails, the saved payload is the audit trail.
