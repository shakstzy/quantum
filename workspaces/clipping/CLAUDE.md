# clipping

Bounty-compliance and distribution system that happens to render clips. The render stack is replaceable. The campaign/account/rights ledger is what keeps the operation alive.

## Purpose

Find verified, funded clipper campaigns (Whop, Vyro, Discord, direct deals). Source long-form content with documented rights. Transcribe once and cache. Rank candidate moments. Render only what passes the pre-publish gate. Publish through 1-3 niche-coherent accounts. Reconcile views to payouts. Goal: maximize `paid_views_per_approved_publish`, not clips per day.

Per Adv Review v1: 95% of clippers earn under $50/month not because they cannot render but because they cannot ship approved, non-suppressed, non-duplicate views into a real funded campaign.

Per Adv Review v2: build the ledger before the render speed.

## Triggers

| Keyword | Action |
|---------|--------|
| `setup` | Re-run `setup/questionnaire.md` |
| `status` | `bash bot/scripts/status.sh` (DB counts + queue depths) |
| `discover` | `bash bot/scripts/discover.sh` (verify Whop/Vyro/Discord campaigns into DB) |
| `source <campaign-slug> <url>` | `bash bot/scripts/source.sh` (yt-dlp + rights ledger) |
| `clip <source-id>` | `bash bot/scripts/clip.sh` (transcribe -> rank -> fingerprint -> candidates) |
| `render <candidate-id>` | `bash bot/scripts/render.sh` (Remotion compose vertical+captions) |
| `qa` | `bash bot/scripts/qa.sh` (apply pre-publish gate, surface for human approval) |
| `publish` | `bash bot/scripts/publish.sh` (zernio-post quota-aware scheduler, dry-run by default) |
| `reconcile` | `bash bot/scripts/reconcile.sh` (refresh metrics + payout claims) |
| `run` | full pipeline for one campaign end-to-end |

## Layout

```
workspaces/clipping/
  CLAUDE.md           (this file)
  CONTEXT.md          (top-level task routing)
  setup/              (questionnaire + locked decisions)
  shared/
    schema.sql        (the SQLite control plane spine)
    policy/           (scam-checklist, banned-niches, ftc-disclosure, pre-publish-gate, platform-risks)
    prompts/          (LLM ranking + extraction prompts)
  stages/01-discover .. 07-track  (each has CONTEXT.md per Pattern 1)
  bot/src/            (python pipeline: db, discover, source, transcribe, rank, fingerprint, cut, compose, gate, publish, track)
  bot/scripts/        (bash entry points)
  remotion/           (node project for vertical compose + word-by-word captions)
  .venv/              (python deps; do not commit)
```

State paths:
- DB: `~/.quantum/clipping/clipping.db` (SQLite, single source of truth)
- Source video files: `~/.quantum/clipping/sources/<source_video_id>.mp4`
- Transcripts cache: `~/.quantum/clipping/transcripts/<source_video_id>-<model>.json`
- Rendered candidates: `~/.quantum/clipping/candidates/<candidate-id>.mp4`
- Approved-pre-publish: `~/.quantum/clipping/approved/<candidate-id>.mp4`
- Logs: `~/.quantum/clipping/logs/`

Raw deposits (immutable, ingested by Graphify):
- `raw/clipping/campaigns/<slug>.md` is one per verified campaign with frontmatter
- `raw/clipping/2026-MM-DD-<clip-slug>.md` is one per published clip with cross-links

## Hard Rules

1. Nothing renders or publishes unless the candidate passes every gate in `shared/policy/pre-publish-gate.md`.
2. No source downloaded without an entry in `sources.rights_status` of `authorized`, `campaign_allowed`, or `fair_use_review` with documented evidence.
3. No campaign pursued unless it scores past `shared/policy/scam-checklist.md`.
4. No niche from `shared/policy/banned-niches.md` (gambling, sports betting, crypto trading, get-rich claims, medical advice, financial advice without disclaimers).
5. Transcripts are cached forever by `(source_video_id, model_version)`. Never re-whisper.
6. Each account posts to one niche only. Cross-posting to a different niche is a ban-vector.
7. New accounts go through `warmup` for 14 days before posting bounty-campaign clips.
8. Daily post cap: 3 per account on TikTok, 2 on IG Reels, 2 on YT Shorts (per Buffer 2026 sweet-spot data).
9. FTC disclosure required for compensated bounty posts: `#ad` or platform-native paid-partnership tag per `shared/policy/ftc-disclosure.md`.
10. `publish` defaults to dry-run. Live posting requires `LIVE=1` env var AND zernio-post `PUBLISH` token.

## North-Star Metric

`paid_views_per_approved_publish = sum(payable_views) / count(publish_attempts where qa_status=approved)`

Tracked daily via `bot/scripts/reconcile.sh`. Anything that does not move this metric is decoration.

## External Skills Wired

| Skill | Used by stage | Purpose |
|-------|---------------|---------|
| `_core/skills/firecrawl/` | 01-discover | Scrape Whop/Vyro campaign pages |
| `_core/skills/brave-search/` | 01-discover | Find new campaign sources |
| `_core/skills/remotion/` | 04-render | Vertical 9:16 compose with word-level captions |
| `_core/skills/zernio-post/` | 06-publish | Direct REST publish to TT/IG/YT |
| `_core/skills/youtube-summary/` | 02-source | Cross-validate transcripts on long YT sources |
| `_core/skills/local-llm/` | 03-clip | Optional second-opinion moment ranking via Gemma |

## Setup

One-time:
1. `python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
2. `cd remotion && npm install`
3. `python bot/src/db.py init` (creates `~/.quantum/clipping/clipping.db` from `shared/schema.sql`)
4. Fill in `setup/questionnaire.md` if any decisions need to change from `setup/decisions.md` defaults.
5. Optional: register at least one Whop account so `discover` can verify campaigns.

Auto-sync (scripts/sync.sh, every 60s) will commit work-in-progress. raw/clipping/ is gitignored.
