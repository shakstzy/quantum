# Onboarding Questionnaire

This workspace was scaffolded with answers pre-locked in `setup/decisions.md` per
Adithya's "maximize money fastest, DIY only, don't ask me" instruction. Re-run only
to override locked decisions.

| Question | Locked answer | File |
|----------|---------------|------|
| Q1 workspace name | clipping | `CLAUDE.md`, `CONTEXT.md` |
| Q2 one-sentence purpose | bounty-compliance + distribution for paid UGC clipping | `CLAUDE.md` |
| Q3 purpose paragraph | See `CLAUDE.md` Purpose | `CLAUDE.md` |
| Q4 ingest source | hybrid (Whop/Vyro/Discord scrape + yt-dlp source ingest) | `setup/decisions.md` |
| Q5 pull command | `bash bot/scripts/discover.sh` (campaigns), `bash bot/scripts/source.sh` (sources) | `CLAUDE.md` |
| Q6 pull script | `bot/scripts/discover.sh` | `CLAUDE.md` |
| Q7 output path | `raw/clipping/campaigns/<slug>.md` and `raw/clipping/YYYY-MM-DD-<clip-slug>.md` | `setup/decisions.md` |
| Q8 slug rule | campaigns `<payer>-<niche>-<source>`; clips `<source-id>-<start>-<hook>` | `setup/decisions.md` |
| Q9 output format | Markdown with YAML frontmatter | `setup/decisions.md` |
| Q10 dedupe key | campaigns `(source,payer,slug)`; sources `source_video_id`; candidates `perceptual_hash + ngram_hash` 30d window | `setup/decisions.md` |
| Q11 launchd? | manual until first payout | `setup/decisions.md` |
| Q12-14 launchd config | n/a until activated | n/a |
| Q15 mutation skill? | yes | `setup/decisions.md` |
| Q16 skill names | zernio-post, firecrawl, remotion | `setup/decisions.md` |
| Q17 additional conventions | see `setup/decisions.md` Q17 | `setup/decisions.md` |
| Q18 PULL_AUTOMATION | manual only (until first payout) | n/a |

## To re-run

If you want to override a locked answer (e.g. switch niche, enable launchd, add a fourth account):

1. Edit the corresponding row in `setup/decisions.md`.
2. Re-run `python3 _core/skills/icm-audit/scripts/audit.py` to confirm no `{{` placeholders remain anywhere in the workspace.
3. If you changed niche or account caps, re-run `python bot/src/db.py reload-config` to push the new values into the `accounts` table.
