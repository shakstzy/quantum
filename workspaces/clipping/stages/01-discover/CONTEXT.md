# 01-discover

Find verified, funded clipper campaigns. Reject scams. Persist as `campaigns` rows.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|--------------|---------------|-----|
| Whop campaign listings | `https://whop.com/discover/content-rewards/` and similar | Scrape via `_core/skills/firecrawl/` | Marketplace truth |
| Vyro campaigns | `https://vyro.io/` (URL TBD) | Same | MrBeast-network campaigns |
| Discord clipping servers | Pre-seeded list of invite URLs | Manual: paste server description text into `~/.quantum/clipping/inbox/discord/` | Auth gates require manual join first |
| Brave Search | `_core/skills/brave-search/` | Query "clipper bounty April 2026" weekly | New campaign discovery |
| Scam checklist | `shared/policy/scam-checklist.md` | Full file | Reject filter |

## Process

1. For each source, scrape via firecrawl into raw markdown.
2. Pass each candidate listing through Claude (`bot/src/lib/claude.py`) with prompt at `shared/prompts/extract-campaign.md` to extract structured fields: `payer, niche, rate_per_1k_usd, min_views, max_payout_usd, total_paid_out_usd, rules`.
3. Compute `scam_score` (0-100; lower = real) using rules in `shared/policy/scam-checklist.md`.
4. INSERT into `campaigns` with `status='pending'`. Reject (do not insert) if rate is over $10/1K (impossible CPM signal) or scam_score over 70.
5. For every campaign with scam_score under 30 and total_paid_out_usd over $1000, write `raw/clipping/campaigns/<slug>.md` with full frontmatter.
6. Surface a list of new pending campaigns for human verification. Move to `status='active'` only after human eyes confirm and (when possible) join the Discord/Whop and verify the campaign is live.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Campaigns rows | `~/.quantum/clipping/clipping.db` table `campaigns` | SQLite |
| Verified campaign markdown | `raw/clipping/campaigns/<slug>.md` | Markdown + YAML frontmatter |
| Scrape log | `~/.quantum/clipping/logs/discover-YYYY-MM-DD.log` | NDJSON |

## Audit (Pattern 12)

Before declaring done:
- [ ] No rows with `rate_per_1k_usd > 10` exist (any such are scams).
- [ ] Every active campaign has at least one rights-statement field in `rules_json`.
- [ ] Every campaign with `scam_score < 30` has been hand-verified (`verified_at NOT NULL`).
- [ ] Banned-niche campaigns are auto-rejected (see `shared/policy/banned-niches.md`).

## Hard Rules

1. Do NOT pursue any campaign that fails `shared/policy/scam-checklist.md`.
2. Do NOT pursue any campaign in a niche listed in `shared/policy/banned-niches.md`.
3. NEVER pay a fee, buy a course, or connect a wallet to access a campaign. That is the universal scam tell.
