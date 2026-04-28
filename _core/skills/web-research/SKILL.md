---
name: web-research
description: Smart multi-step web research orchestrator. Chains brave-search and firecrawl with one Codex/GPT red-team pass that finds retrieval gaps. Use when the user asks to research a topic, find sources, build a reading list, or do a deep dive. Output is ephemeral by default — only promotes to raw/library/ on explicit save.
---

# web-research

Hybrid orchestrator. Claude does query gen, ranking, and synthesis. Codex (already installed CLI) runs ONE red-team pass to find missing source classes / domains / viewpoints and emits follow-up queries. Empirically grounded:

- **Self-MoA (arxiv 2502.00674)** — single-best-model synthesis beats cross-model synthesis. So synthesis stays Claude.
- **PROClaim (arxiv 2603.28488)** — cross-model wins came from *retrieval expansion*, not from arguing. So heterogeneity is used at the gap-discovery layer only, and its output is *queries*, not prose critique.
- **Identity bias in MAD (arxiv 2510.07517)** — anonymize inputs to the critic; don't tell it which model produced the shortlist.

## When this fires

Trigger phrases (semantic, non-exhaustive): "research X", "do a deep dive on Y", "find sources on Z", "build a reading list on W", "what do experts say about V", "give me the lay of the land on U".

Do NOT fire for:
- One-off factual lookups → `brave-search` skill directly
- Single-URL reads → `firecrawl` skill directly
- Knowledge-graph questions about Adithya's own life → `/graphify query` first

## Auth

Inherits `BRAVE_API_KEY` and `FIRECRAWL_API_KEY` from `.claude/settings.local.json`. Codex CLI is already authenticated globally (`/opt/homebrew/bin/codex`).

## Procedure

### 1. Frame queries
Generate **3 query variants** covering different angles. Don't echo Adithya's phrasing. Vary on: framing (how vs why vs what), freshness (all-time vs recent), perspective (proponents vs critics vs primary). Note `runId=$(date +%Y%m%d-%H%M%S)` for the rest of the run.

### 2. Fan-out search (parallel)
```bash
_core/skills/brave-search/search.sh "variant 1" 10 > /tmp/wr-$runId-q1.json &
_core/skills/brave-search/search.sh "variant 2" 10 > /tmp/wr-$runId-q2.json &
_core/skills/brave-search/search.sh "variant 3" 10 > /tmp/wr-$runId-q3.json &
wait
```
Apply `freshness=pw|pm|py` on the variant where recency matters.

### 3. Merge and rank
Read the three JSONs. Dedupe by hostname. Score each candidate on:
- **Domain authority**: primary source > regulator > known publication > vendor blog > random blog
- **Topical fit**: snippet matches the ask, not just keywords
- **Recency**: when the topic is time-sensitive
- **Query coverage**: bonus for URLs surfaced by 2+ variants

Produce a **shortlist of 7-10** with title, hostname, and a one-line rationale per row.

### 4. Red-team pass (Codex, anonymized)
Pipe the shortlist to Codex. Do NOT mention which model produced it. Demand strict JSON. From repo root:

```bash
codex exec --skip-git-repo-check -s read-only --ignore-rules --ephemeral \
  -o /tmp/wr-$runId-redteam.txt <<EOF
You are a research red-team auditor. A junior researcher proposed the shortlist below. Your job: find what it MISSES.

Question: "<the user's research ask>"

Shortlist:
- "<title>" (<hostname>): <one-line rationale>
- ...

Output STRICT JSON (no prose, no markdown fences):
{
  "missing_classes": ["primary research", "regulatory perspective", ...],
  "biases": ["over-represents vendor blogs", "single publisher dominance", ...],
  "followup_queries": ["query 1", "query 2", "query 3", "query 4", "query 5"]
}

Hard rules:
- 3-5 follow-up queries, each targeting a specific gap
- Each query must be independently runnable in a web search
- No hedging, no caveats, no apologies
EOF
```
Parse the JSON. If Codex returned prose anyway, salvage what you can; don't loop.

### 5. Backfill on follow-up queries
Run brave-search on each `followup_queries[]` entry in parallel. Pick the strongest 1-2 candidates per gap query (same scoring as step 3). Add them to the final scrape list.

### 6. Scrape (parallel, capped)
Cap total scrapes at **10** unless Adithya explicitly raises the budget. Save raw markdown to the ephemeral run dir:

```bash
mkdir -p ~/.quantum/skill-output/web-research/$runId/sources
for url in "${urls[@]}"; do
  slug=$(echo "$url" | sed -e 's|https\?://||' -e 's|[/?#].*||' -e 's|[^a-zA-Z0-9.-]|-|g' | head -c 60)
  _core/skills/firecrawl/scrape.sh "$url" \
    | jq -r '.markdown' \
    > ~/.quantum/skill-output/web-research/$runId/sources/$slug.md &
done
wait
```

### 7. Synthesize with confidence labels
Read all scraped markdown. Write a 3-5 paragraph synthesis. Tag every non-trivial claim:

| Tag | Meaning |
|-----|---------|
| `[corroborated]` | Claim appears in 3+ independent domains |
| `[primary-source]` | Sourced from the actual paper / dataset / regulator / first-party |
| `[single-source]` | Only one source supports this — treat as soft |
| `[conflicting]` | Sources disagree — surface the disagreement explicitly |

Cite each claim by hostname inline. Do NOT paste full scraped contents into chat — they live in the run dir.

Also save the synthesis itself to `~/.quantum/skill-output/web-research/$runId/synthesis.md` with frontmatter (`question`, `runId`, `query_variants`, `followup_queries`, `sources`, `created_at`).

## Output handling

**Default: ephemeral.** Everything lives at `~/.quantum/skill-output/web-research/$runId/`:
```
$runId/
├── synthesis.md         # the answer
├── sources/             # scraped markdown
├── shortlist.json       # ranked candidates from step 3
└── redteam.txt          # raw Codex output
```
Graphify ignores this path entirely. No pollution.

**Promote to library (explicit only).** If Adithya says "save this", "keep this", "add to my library", "ingest this run":
- Promote chosen source files to `raw/library/YYYY-MM-DD-<slug>.md` with frontmatter (`url`, `title`, `captured_at`, `intent`, `relevance`, `source_type`).
- Promote the synthesis to `raw/library/YYYY-MM-DD-research-<topic-slug>.md` if requested.
- Adithya picks which sources go in. Don't dump the whole run.

## Budget

- 3 query variants (step 1)
- 3-5 follow-up queries (step 4)
- ≤10 total scrapes (step 6)
- 1 Codex red-team call (step 4)

Cap can be lifted by explicit instruction. If a step starts looping or returning garbage, stop — don't retry-storm.

## Audit (run before declaring done)

| Check | Pass condition |
|-------|----------------|
| All scraped files present in run dir | `ls $runId/sources/` matches the URLs you cited |
| Synthesis cites every saved file | No orphan sources, no fabricated citations |
| Confidence tags applied | Every non-trivial claim has one of the four tags |
| No paywalled / login-gated content scraped | Skipped at vet stage, not after |

## Files

- `_core/skills/brave-search/search.sh` — primitive (search)
- `_core/skills/firecrawl/scrape.sh` — primitive (scrape)
- `codex` — already installed at `/opt/homebrew/bin/codex` for the red-team pass
- `~/.quantum/skill-output/web-research/$runId/` — run output (graphify-ignored)
- `raw/library/` — promotion target on explicit save
