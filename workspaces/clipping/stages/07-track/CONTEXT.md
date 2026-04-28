# 07-track

Reconcile views to payouts. Update north-star metric `paid_views_per_approved_publish`.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|--------------|---------------|-----|
| Posted attempts | DB `publish_attempts` where status='posted' | Full table | What to measure |
| Campaign rules | DB `campaigns.rules_json` | min_views, payout_caps | Reconciliation math |
| Zernio-post status | `_core/skills/zernio-post/SKILL.md` `status` command | Per `zernio_post_id` | Live view counts |
| Manual payout entries | `~/.quantum/clipping/inbox/payouts/<campaign-slug>.json` | Whop/Discord-reported amounts | Source of truth for paid amount |

## Process

1. For each `publish_attempts` posted in the last 30 days, refresh `metrics_snapshots`:
   - Call zernio-post `status <zernio_post_id>` for current view count.
   - Insert a new row in `metrics_snapshots` (do not update the old one; we want a time series).
2. For each posted attempt, compute expected payout:
   - `expected_usd = max(0, latest_views - min_views) / 1000 * rate_per_1k_usd`
   - Cap by campaign `max_payout_usd` if set.
3. UPSERT `payout_claims` with `expected_usd`, status `pending`.
4. When the operator drops a payout receipt at `~/.quantum/clipping/inbox/payouts/<campaign-slug>.json`, parse and UPDATE matching `payout_claims` rows: set `paid_usd`, `status='paid'`, `paid_at`.
5. Compute and log north-star daily:
   - `paid_views_per_approved_publish = sum(metrics latest views) / count(qa_approved publishes)`
   - Append to `~/.quantum/clipping/logs/north-star.ndjson`.
6. Surface kill-list: any campaign where `(paid_usd / expected_usd) < 0.5` after 7 days, or where 10+ posts averaged under 1k views, gets flagged for `status='paused'` with note.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Metrics snapshots | DB `metrics_snapshots` | SQLite (time series) |
| Payout claims | DB `payout_claims` | SQLite |
| North-star log | `~/.quantum/clipping/logs/north-star.ndjson` | NDJSON |
| Kill-list weekly | `~/.quantum/clipping/logs/kill-list-YYYY-WW.md` | Markdown |

## Audit

- [ ] Every posted attempt has at least one `metrics_snapshots` row from last 24h.
- [ ] No `payout_claims` row has `paid_usd > expected_usd * 1.5` without a manual override note (suspicious overpayment).
- [ ] North-star metric was logged today.

## Hard Rules

1. Never edit `metrics_snapshots`. Only INSERT. We need the time series.
2. Pause campaigns that fail kill-list. Adv review v1: most clippers fail because they keep working dead campaigns.
3. Operator pastes payout receipts manually. Do not infer payment from view counts alone.
