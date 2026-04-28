# Locked Architectural Decisions

Pre-recorded answers to setup questionnaire, locked from adversarial review.
Re-read `_core/CONVENTIONS.md` Pattern 17 before editing this file.

## Q1-Q3: Identity

- **Workspace name:** clipping
- **One-sentence purpose:** Bounty-compliance and distribution system for paid UGC clipping campaigns; produces approved, attributable, non-duplicate vertical clips and tracks them to payout.
- **Purpose paragraph:** see `CLAUDE.md` Purpose section (canonical).

## Q4: Source

Hybrid. This is not a pure ingest workspace. It pulls campaign listings (firecrawl Whop/Vyro/Discord) and source videos (yt-dlp). Per CONVENTIONS Pattern 16 it is workflow-shaped (multi-stage pipeline).

## Q5-Q7: Entry points and outputs

- **Pull (campaigns):** `bash bot/scripts/discover.sh`
- **Pull (sources):** `bash bot/scripts/source.sh <campaign-slug> <url>`
- **Output paths:**
  - Verified campaigns: `raw/clipping/campaigns/<slug>.md`
  - Published clips: `raw/clipping/YYYY-MM-DD-<clip-slug>.md`
- **Slug rule:** campaigns use `<payer>-<niche>-<source>` (e.g. `iman-business-whop`). Clips use `<source-id>-<segment-start>-<hook-slug>`.

## Q8-Q9: Format

- Markdown with YAML frontmatter (Graphify-readable per QUANTUM CLAUDE.md "Raw deposits MUST be graph-linkable" rule).

## Q10: Dedupe

- Campaigns: `(source, payer, slug)` unique.
- Sources: `source_video_id` (e.g. youtube ID) unique.
- Candidates: perceptual-hash + transcript-n-gram-hash window of 30 days.

## Q11-Q14: Automation

- Manual at first. Once we have one paid campaign, propose a launchd plist for `discover` (every 6h) and `reconcile` (every 4h). Not automated until first payout to avoid wasting cycles on a system that does not yet make money.

## Q15-Q16: External-mutation skill

- Yes: `_core/skills/zernio-post/SKILL.md` for publish, `_core/skills/firecrawl/SKILL.md` for campaign scrape, `_core/skills/remotion/SKILL.md` for compose. Workspace is read-write; mutation paths flow through these skills.

## Q17: Additional conventions

1. **DB is canonical.** Filesystem is artifact storage; the SQLite at `~/.quantum/clipping/clipping.db` owns state.
2. **Transcripts cached forever** by `(source_video_id, model_version)` key. Never re-whisper.
3. **Pre-publish gate is non-negotiable.** Every gate flag in `shared/policy/pre-publish-gate.md` must be green. No human override; failures kick back to fix the underlying issue.
4. **Niche pivot from adv-review v1.** Initial niche bias: B2B SaaS / AI tools / fintech-with-disclosure (rate $3-5/1K, less saturated). NOT business gurus. Sports-entertainment with rights-cleared assets is allowed when campaigns supply them. Banned: gambling, sports betting, crypto-trading, get-rich-quick, supplements, medical, financial-advice-without-disclaimer.
5. **Account strategy.** 3 distinct accounts max, one niche each. 14-day warmup before any bounty post. Hard caps: TT 3/day, IG 2/day, YT 2/day per account.
6. **North-star metric:** `paid_views_per_approved_publish`. Render throughput is decoration.
7. **Live publish requires** `LIVE=1` env var AND zernio-post `PUBLISH` token. Default is dry-run.
8. **No em dashes anywhere** (QUANTUM root rule).

## Adversarial-review fixes baked in

From `/tmp/clip-adv-1.md`:
- N3on real rate is $0.40-0.50/1K not $2-5; ignore the celebrity-rate hype.
- Iman/Kai Whop pages are mostly UGC creator-campaign offers, not faceless reposts.
- Best 2026 niche is B2B SaaS/AI/fintech, not business gurus.
- Time to first $100 is 2-6 weeks for a competent operator.
- 95% of clippers fail because they ship duplicative, suppressed, unapproved views into bad campaigns. Fix is: pick one funded campaign, 3 distinct accounts, materially different clips, kill formats after 10 posts under 1-3K views.

From `/tmp/clip-adv-2.md`:
- Build the SQLite control plane before scaling render throughput.
- Cache transcripts by `(source_video_id, model_version)` permanently.
- Add `clip_fingerprint` (perceptual hash + transcript n-gram) before publish.
- Every campaign needs a `campaign_contract.json` with confidence scores.
- Add mandatory `pre_publish_checklist` gate.
- Optimize for `paid_views_per_approved_publish`, not clips/day.
- Quota-aware scheduler at publish stage, not direct from render.
