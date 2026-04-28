# Confirmation Gate

The mandatory human checkpoint before any write to a real account. This is the single most important safety rail in the skill. Eight adversarial reviewers converged on it independently.

## What it does

Before calling `zernio.sh post`, the agent prints the full assembled payload and stops. The user must respond with the literal token `PUBLISH` to proceed. Any other response aborts the post.

## What to print

All of the following, nothing omitted:

- Every target: `{platform, account_alias, accountId, username}`.
- Every media file: local path, size, MIME, resulting public URL from upload step.
- Full `content` / caption text.
- Every field in `platformSpecificData` for Instagram and YouTube, and every field in `tiktokSettings` (top-level, not nested) for TikTok, including defaults the skill filled in.
- Explicit AI-disclosure values for each platform (even if false or unset).
- `publishNow` and `scheduledAt` values.
- For TikTok targets: the `privacy_level` picked AND the `privacyLevels` array that creator-info returned, so the user can see the match.
- For YouTube targets: the `madeForKids` value. If true, print a warning that this is permanent.

## What a valid response looks like

- `PUBLISH` (literal, case sensitive) -> proceed to step 8.
- Anything else, including `publish`, `yes`, `ok`, empty -> abort, return the payload to the caller for editing, do not call `posts`.

## The escape hatch

Environment variable `ZERNIO_NO_CONFIRM=1` skips the gate. Used only by explicit scripted flows where another layer already performed the confirmation (e.g. a future content-workspace stage that has its own approval checkpoint).

When the escape hatch is used, the skill MUST:

1. Log the skip to `output/zernio-result-[ts].json` with a `confirmation_skipped: true` field.
2. Never skip for YouTube posts where `madeForKids=true`. That field is permanent; confirmation is always required regardless of env.
3. Never skip for scheduled posts more than 24h out. A scheduled post is harder to cancel than a publish-now.

## Why this is non-negotiable

YouTube `madeForKids=true` cannot be reversed. TikTok posts cannot be edited after publish. Instagram posts can be deleted but not un-seen by followers with notifications on. The skill posts to Adithya's real accounts with real followers. A silent-default gate would make a bad post a single-prompt-injection away.

Do not implement "skip confirmation if the caption is short" or "skip if it is a dry-run build." Those are holes. The gate is binary.
