# 06-publish

Quota-aware scheduler. Publish approved candidates via zernio-post. Default dry-run.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|--------------|---------------|-----|
| Approved candidates | DB `clip_candidates` where status='qa_approved' | Full row | Ready to ship |
| Render mp4 | `renders.filepath` for each | Full file | Upload payload |
| Account roster | DB `accounts` where status='active' | Full table | Where it ships |
| Zernio-post skill | `_core/skills/zernio-post/SKILL.md` | Full file | Publish primitives |
| FTC disclosure | `shared/policy/ftc-disclosure.md` | Full file | Caption must include disclosure tag |

## Process

1. Build candidate-to-account mapping: for each approved candidate, find every active account where `accounts.niche == campaigns.niche`. Skip accounts in `warmup` status.
2. Quota check per account: count `publish_attempts` in last 24h and last hour. Skip if either cap is hit (defaults: 3/day, 1/hour). Per-account caps live in `accounts` row.
3. Generate caption: combine `candidates.hook` + niche hashtags + required disclosure tag (from FTC policy) + campaign tracking ID if campaign requires.
4. Create one `publish_attempts` row per (candidate, account) with `status='queued'`.
5. If env `LIVE=1`: invoke `_core/skills/zernio-post/SKILL.md` per attempt. Pass through the `PUBLISH` confirmation gate. On success, set `status='posted'`, `zernio_post_id`, `platform_url`, `posted_at`. On failure, set `status='failed'` with `failure_reason`.
6. If env `LIVE` is unset: set `status='dry_run'` and write a payload preview to `~/.quantum/clipping/logs/publish-dryrun-<ts>.md` so a human can see exactly what would have shipped.
7. After posting, write `raw/clipping/YYYY-MM-DD-<clip-slug>.md` with frontmatter linking back to the campaign and source so Graphify picks it up.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Publish attempt rows | DB | SQLite |
| Dry-run preview | `~/.quantum/clipping/logs/publish-dryrun-<ts>.md` | Markdown |
| Live post artifact | `raw/clipping/YYYY-MM-DD-<clip-slug>.md` | Markdown + frontmatter |

## Audit

- [ ] Caption contains FTC-disclosure tag for every paid-campaign post.
- [ ] No account exceeded its daily or hourly cap.
- [ ] Every `posted` row has `zernio_post_id` and `platform_url`.
- [ ] Dry-run logs are readable; LIVE=1 was explicit, never inferred.

## Hard Rules

1. `LIVE=1` MUST be explicitly set in env. Default is dry-run.
2. zernio-post `PUBLISH` token gate is non-negotiable.
3. Never post to an account in `warmup` status.
4. Never exceed `accounts.daily_post_cap` or `accounts.hourly_post_cap`. The scheduler enforces, not the human.
