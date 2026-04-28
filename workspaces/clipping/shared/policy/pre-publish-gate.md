# Pre-Publish Gate

Mandatory gate before any publish_attempts row leaves `status='queued'`.
Per Adv Review v2: this is the most important rule in the system. No bypass.

## Checks (all must be green)

| Check | Source | Pass condition |
|-------|--------|---------------|
| `campaign_verified` | `campaigns.status` | == 'active' AND `verified_at` is not NULL |
| `rights_check` | `sources.rights_status` | in (`authorized`, `campaign_allowed`, `fair_use_review`) |
| `duplicate_check` | `clip_candidates.duplicate_score` | < 0.5 |
| `account_cadence_available` | `publish_attempts` last 24h+1h | account is below `daily_post_cap` AND `hourly_post_cap` |
| `account_niche_fit` | `accounts.niche` vs `campaigns.niche` | exact match (string-eq) |
| `originality_check` | candidate has hook overlay OR custom captions OR commentary track | at least one transformative element |
| `disclosure_required_resolved` | `gate.disclosure_check(candidate, account)` | True (per `ftc-disclosure.md`) |
| `qa_status` | `qa_reviews.decision` for latest review | == 'approve' |
| `platform_risk_score` | per-platform | < 30 for the target platform |
| `banned_niche_clean` | `banned.is_banned(transcript_excerpt + caption)` | (False, []) |

## Implementation

`bot/src/gate.py`:

```
def gate(candidate_id: int, account_id: int) -> GateResult:
    checks = {
        "campaign_verified":     _campaign_verified(candidate_id),
        "rights_check":          _rights_check(candidate_id),
        "duplicate_check":       _duplicate_check(candidate_id),
        "account_cadence":       _account_cadence(account_id),
        "account_niche_fit":     _account_niche_fit(candidate_id, account_id),
        "originality_check":     _originality_check(candidate_id),
        "disclosure_resolved":   _disclosure_check(candidate_id, account_id),
        "qa_status":             _qa_status(candidate_id),
        "platform_risk_score":   _platform_risk_score(candidate_id, account_id),
        "banned_niche_clean":    _banned_niche_clean(candidate_id),
    }
    failed = [k for k, v in checks.items() if not v.passed]
    return GateResult(passed=(len(failed) == 0), failed_checks=failed, full=checks)
```

## Failure semantics

- One failing check = full reject. No "5 of 10 passed, ship it" logic.
- Failed gate kicks the candidate to `status='qa_rejected'` and logs to `~/.quantum/clipping/logs/gate-failures-YYYY-MM-DD.ndjson` so we can learn which checks fail most often.
- If `originality_check` fails: the fix is in 04-render (add hook overlay, regenerate captions). Do not weaken the check.
- If `duplicate_check` fails: the fix is in 03-clip (pick a different moment). Do not weaken the check.
- If `disclosure_resolved` fails: the fix is in caption generation. Never disable disclosure.

## Override path (extremely narrow)

There is exactly one override: a human operator can flip `qa_reviews.reasons` to `MANUAL_OVERRIDE: <one-paragraph justification>` AND set the candidate `status='qa_approved'` directly via `python bot/src/db.py override <candidate-id> "<reason>"`. This is logged as an immutable audit row in `qa_reviews` with reviewer='manual_override'. Use only for novel campaign rules that the gate cannot encode.

## Why this exists

Adv Review v2: "Build a bounty compliance and distribution system that happens to render clips. The render stack is replaceable. The account/campaign/rights ledger is the part that keeps the operation alive long enough to learn what pays."

This file IS the ledger contract. Without it, the rest of the system is just a video factory.
