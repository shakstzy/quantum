# 07-learn

Sweep over recent ads. Rewrite `shared/learnings/*.md` with patterns that distinguish winners from losers. Lightweight v1: in-context learnings injected into stage 02-script. Heavyweight prompt rewrites are v2.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|---------------|---------------|-----|
| Recent metrics | `../06-metrics/output/*-metrics.json` | Last 30d | Verdicts |
| Picked scripts | `../02-script/output/*-picked.md` | Last 30d | What we shipped |
| Research synthesis | `../01-research/output/*-research.md` | Last 30d | What we expected to win |
| Host performance | `../../shared/hosts/*/performance.md` | Last 30d | Host-level signal |
| Existing learnings | `../../shared/learnings/*.md` | Full | Prior patterns to update |

## Process

1. Aggregate last 30d ads. Tag each as winner / neutral / loser per stage 06's verdict.
2. Cluster winners and losers separately along: angle, hook, host, product category, day-of-week, time-of-day.
3. For each cluster, ask Claude: what pattern distinguishes winners from losers here? Be specific (e.g., "skeptic-flip hooks beat problem-solution hooks 3:1 in fitness niche").
4. Rewrite `shared/learnings/hosts.md` with current host-by-niche performance.
5. Rewrite `shared/learnings/angles.md` with top 5 angles + 3 anti-patterns.
6. Rewrite `shared/learnings/hooks.md` with top 5 hook structures + sample wording.
7. Rewrite `shared/learnings/fails.md` with the 3 biggest tank patterns.
8. Append a `WARN:` line for any host whose last-10 average is below 20% of niche median.
9. Write a one-page `output/<run-date>-learnings.md` summary that humans can scan.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Updated learnings | `../../shared/learnings/{hosts,angles,hooks,fails}.md` | Markdown (rewritten in place) |
| Learn-run summary | `output/<run-date>-learnings.md` | Markdown one-pager |

## Audit

- All four `shared/learnings/*.md` files were touched (mtime check)
- Each learning cites at least 3 ads as evidence (no single-data-point claims)
- Anti-patterns are kept (don't only write what works)
- WARN lines for underperforming hosts surface to operator; agent does not retire hosts itself
