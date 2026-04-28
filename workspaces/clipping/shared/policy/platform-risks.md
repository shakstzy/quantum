# Platform Risks

Per-platform suppression and ban vectors. Used by `gate.py::_platform_risk_score`.

## TikTok (April 2026)

| Risk | Score weight | Detection |
|------|--------------|-----------|
| Reused-content tag | +30 | Any source `rights_status` of `fair_use_review` (TT explicitly down-ranks) |
| Watermark from another platform | +30 | Pixel-test corners for IG/Snapchat/Capcut watermarks |
| Under 60s with low transformation | +15 | duration < 60 AND originality_check has only one transformation flag |
| Banned-niche keyword in caption | +50 | `banned-niches.md` regex hits |
| New account in warmup | +20 | account.status == 'warmup' |
| Above daily cap forecast | +25 | last 24h posts >= daily_post_cap - 1 |

## Instagram Reels (April 2026)

| Risk | Score weight | Detection |
|------|--------------|-----------|
| Reposted unoriginal | +35 | Meta March 2026 originality update; same as TT |
| 9:16 not produced natively | +10 | Render pipeline always produces native 9:16, so usually 0 |
| Captions not burned in | +5 | We burn captions, so usually 0 |
| External watermark | +30 | same pixel test |
| Banned-niche | +50 | regex |
| Over 90s | +15 | IG Reels favors 60-90s |

## YouTube Shorts (April 2026)

| Risk | Score weight | Detection |
|------|--------------|-----------|
| Reused content (no commentary) | +40 | YouTube reused-content policy is harsher than TT |
| Over 60s | +30 | Anything over 60s is not a Short, defeats purpose |
| Vertical not native | +5 | We always export 1080x1920 |
| Banned-niche | +50 | regex |
| Misleading thumbnail | +20 | If thumbnail doesn't match clip content |
| Channel under 1000 subs | 0 (informational) | Cannot monetize Shorts directly, but does not affect publish risk |

## Score interpretation

| Score | Verdict |
|-------|---------|
| 0-29 | Safe to publish on this platform |
| 30-49 | Yellow zone. Pre-publish gate fails. Requires explicit fix. |
| 50+ | Red zone. Hard reject. |

## Cross-platform recommendation

When the same clip has different scores per platform: publish to the lowest-risk platform first; do not auto-cross-post a clip with a yellow/red score on any one platform; treat each platform like a separate decision.

This means a single approved render can spawn 1-3 publish_attempts (one per qualifying platform), not always 3. The scheduler in 06-publish handles the per-platform branching.
