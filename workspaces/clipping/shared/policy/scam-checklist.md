# Scam-Whop Checklist

Per Adv Review v1. Score every campaign before persisting `status='active'`.

## Real-campaign signals (each adds -10 to scam_score)

| Signal | Detection |
|--------|-----------|
| Uses Whop's actual Content Rewards flow | URL matches `whop.com/discover/content-rewards/...` or `whop.com/.../content-rewards/...` |
| Funded budget visible | Page text mentions `$X paid out` with X > 1000 |
| Visible total_paid_out > $1k lifetime | scraped from page |
| Creator identity verifiable | payer matches a known social handle (cross-check with `_core/skills/brave-search/`) |
| Submission tracking inside official tooling | rules mention "submit via Whop", "via Vyro", or campaign dashboard |
| Plausible CPM | rate_per_1k_usd in [0.30, 8.0] |
| Reviews mention real approvals | scrape any review section; LLM judges authenticity |
| Clear policy text | rules contain words like "disclosure", "rejection", "minimum views", "payout cap" |

## Scam signals (each adds +20 to scam_score)

| Signal | Detection |
|--------|-----------|
| Celebrity name with unofficial handle | payer is a celebrity but URL slug looks fan-run (no checkmark, off-brand username) |
| "Unlimited budget" with $0 paid out | rules say unlimited but `total_paid_out_usd` is null or zero |
| Requires buying course/Discord/wallet | rules text matches regex `buy|wallet|connect|verification fee|course|membership` |
| Pays for recruiting affiliates | rules mention `referral`, `downline`, `recruit`, `MLM` |
| Vague "post anything" | rules length under 200 chars or no submission requirements |
| Off-platform manual DM payout | rules mention `DM for payout`, `Telegram`, `WhatsApp`, `private channel` |
| Impossible CPM | rate_per_1k_usd > 10 (auto-reject above $10/1K) |
| Asks for login credentials | mentions `share TikTok login`, `provide cookies`, `proxy setup` |
| Promotes banned niche | matches `shared/policy/banned-niches.md` keyword regex |

## Auto-reject (do NOT persist any row)

- `rate_per_1k_usd > 10` (impossible CPM)
- `scam_score > 70`
- Niche in `banned-niches.md`
- Asks for fee/wallet/login credentials

## Score interpretation

| Score | Action |
|-------|--------|
| 0-29 | High confidence real. Auto-eligible for `status='active'` after human verifies. |
| 30-50 | Mixed signals. Hold at `status='pending'` until human inspects Discord/Whop in person. |
| 51-70 | Suspicious. Hold at `status='pending'` with `notes` documenting concerns. |
| 71-100 | Reject. Do not persist (or persist with `status='dead'` and notes for learning corpus). |
