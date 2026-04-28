# clipping — Top-Level Task Routing

Pattern 6: routing only. Definitions live elsewhere.

## What I want to do

| Task | Read first |
|------|------------|
| Find/verify a paying campaign | `stages/01-discover/CONTEXT.md` |
| Add a long-form source (podcast / VOD) | `stages/02-source/CONTEXT.md` |
| Transcribe + rank moments + cut candidates | `stages/03-clip/CONTEXT.md` |
| Render a candidate to vertical 9:16 with captions | `stages/04-render/CONTEXT.md` |
| Run the pre-publish gate + human approval | `stages/05-qa/CONTEXT.md` |
| Publish approved clip across accounts | `stages/06-publish/CONTEXT.md` |
| Reconcile views to payouts; update north-star | `stages/07-track/CONTEXT.md` |

## What rules apply

| Concern | File |
|---------|------|
| Is this campaign real? | `shared/policy/scam-checklist.md` |
| Can I post this niche? | `shared/policy/banned-niches.md` |
| Do I have to disclose? | `shared/policy/ftc-disclosure.md` |
| Is this clip safe to publish? | `shared/policy/pre-publish-gate.md` |
| What can each platform tolerate? | `shared/policy/platform-risks.md` |

## Core data model

The DB is the source of truth, not the filesystem. See `shared/schema.sql` for tables. Rule of thumb: every artifact on disk has a row in the DB; every row in the DB has either an artifact or a `null` filepath with documented reason.

## Pipeline shape

```
01-discover -> campaigns row (verified, scam-screened)
   v
02-source   -> sources row (rights_status documented) + raw video on disk
   v
03-clip     -> transcripts row (cached forever) + clip_candidates rows (ranked, fingerprinted)
   v
04-render   -> renders row + mp4 on disk (only after dedup gate)
   v
05-qa       -> qa_reviews row (gate must be all-green to advance)
   v
06-publish  -> publish_attempts rows (one per (candidate, account))
   v
07-track    -> metrics_snapshots + payout_claims rows
```

Stages 04-render through 06-publish enforce gates from `shared/policy/pre-publish-gate.md`.
