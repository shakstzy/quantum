# 06-metrics

Scrape own posts at 24h / 7d / 30d marks. Append to host performance log.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|---------------|---------------|-----|
| Ship record | `../05-ship/output/<product-slug>-shipped.md` | Post URLs | What to scrape |
| Browser-automation skill | `_core/skills/browser-automation/SKILL.md` | patchright | Auth'd scrape via host's own profile |

## Process

1. Read ship record. Compute time-since-ship.
2. For each post URL:
   - Open via patchright using the host's persistent profile (`~/.quantum/chrome-profiles/<host-id>/`).
   - Read views, likes, comments, shares from the public post page.
   - Record into a timeseries entry.
3. Append to `output/<product-slug>-metrics.json`: `{checkpoint: "24h"|"7d"|"30d", platform, url, views, likes, comments, shares, scraped_at}`.
4. Append to `../../shared/hosts/<host-id>/performance.md`: one row per checkpoint.
5. Compute winner verdict on 7d checkpoint:
   - Winner if views > 5x host's median over last 30 ads
   - Loser if views < 0.2x host's median
   - Otherwise neutral
6. Write verdict into `output/<product-slug>-metrics.json`.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Metrics timeseries | `output/<product-slug>-metrics.json` | JSON: checkpoints array, verdict |
| Performance log | `../../shared/hosts/<host-id>/performance.md` (appended) | Markdown rows |

## Audit

- All shipped post URLs were scraped, not just the first
- Patchright used the correct host profile (not Adithya's personal profile)
- Verdict math is correct: median computed only from ads on the same host
- Failures (post deleted, account suspended, captcha) are logged with reason; do not silently skip
