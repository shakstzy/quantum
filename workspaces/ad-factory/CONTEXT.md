# ad-factory CONTEXT

Top-level task routing. Stages are linear unless the operator runs them individually.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|---------------|---------------|-----|
| Workspace contract | `CLAUDE.md` | Triggers, Hard Rules, Skills used | Always |
| Per-product brief | `inbox/<product-slug>/brief.md` | Full file | Operator-authored input |
| Host bibles | `shared/hosts/<host-id>/*.md` | persona.md + look.md + voice.md | Picked at stage 02 |
| Recent learnings | `shared/learnings/*.md` | Last 30d entries | Bias script generation |

## Process

1. Operator runs `new <slug>`. Scaffolds `inbox/<slug>/brief.md`. Operator fills it.
2. Run `research <slug>` -> writes `stages/01-research/output/<slug>-research.md`.
3. Run `script <slug>` -> emits `stages/02-script/output/<slug>-v{1,2,3}.md`. Operator picks one, renames to `<slug>-picked.md`.
4. Run `render <slug>` -> Higgsfield Marketing Studio, mp4s land in `~/.quantum/skill-output/higgsfield/`.
5. Run `edit <slug>` -> `~/.quantum/ad-factory/edits/<slug>/{hero,9x16,1x1}.mp4`.
6. Run `ship <slug>` -> zernio-post with PUBLISH gate. Writes `stages/05-ship/output/<slug>-shipped.md`.
7. Run `metrics <slug>` at 24h, 7d, 30d marks. Appends to `shared/hosts/<host-id>/performance.md`.
8. Run `learn` weekly. Rewrites `shared/learnings/*.md` from the last 30d.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Research synthesis | `stages/01-research/output/<slug>-research.md` | Markdown |
| Script variants | `stages/02-script/output/<slug>-v{1,2,3}.md` | Markdown |
| Picked script | `stages/02-script/output/<slug>-picked.md` | Markdown |
| Render manifest | `stages/03-render/output/<slug>-renders.json` | JSON (Higgsfield run-ids + paths) |
| Final cuts | `~/.quantum/ad-factory/edits/<slug>/*.mp4` | mp4 |
| Ship record | `stages/05-ship/output/<slug>-shipped.md` | Markdown |
| Metrics log | `stages/06-metrics/output/<slug>-metrics.json` | JSON (timeseries) |
| Learnings | `shared/learnings/*.md` | Markdown (rewritten in-place) |
