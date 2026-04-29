# 02-script

Generate 3 script variants from the brief, the research synthesis, the picked host's bible, and recent learnings. Operator picks one before render.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|---------------|---------------|-----|
| Brief | `inbox/<product-slug>/brief.md` | Full file | Product, USP, CTA, tone |
| Research | `../01-research/output/<product-slug>-research.md` | Top Angles, Top Hooks, CTA Patterns | Bias toward winners |
| Picked host | `../../shared/hosts/<host-id>/persona.md` + `look.md` + `voice.md` | Full files | In-character dialogue |
| Recent learnings | `../../shared/learnings/{angles,hooks,fails}.md` | Last 30d | Self-improvement loop |

## Process

1. Operator picks the host: `<host-id>` from `shared/hosts/`. Recorded in `inbox/<product-slug>/brief.md` as `host: <host-id>`.
2. Claude reads inputs.
3. Claude writes 3 script variants. Each variant is one 40-60 second podcast-style ad: 3 clips of ~15s, 4 lines per clip, host + guest dialogue, B-roll cues marked. Each variant uses a different angle pulled from research.
4. Each variant ends with picked-CTA from the brief.
5. Variants are written character-consistent with the host (voice tics from `voice.md`, look anchored to `look.md`).
6. Operator reads, picks one, renames `<product-slug>-v<n>.md` -> `<product-slug>-picked.md`.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Variant 1 | `output/<product-slug>-v1.md` | Markdown: Angle / Hook / Clip-1 dialogue / Clip-2 dialogue / Clip-3 dialogue / B-roll cues / CTA |
| Variant 2 | `output/<product-slug>-v2.md` | same |
| Variant 3 | `output/<product-slug>-v3.md` | same |
| Picked | `output/<product-slug>-picked.md` | Operator-renamed copy of one variant |

## Audit

- Each variant is in-character with the picked host (voice tics present, no contradictions with `look.md`)
- Each variant uses a distinct angle (no two share the same hook structure)
- Each clip is 4 lines or fewer (Higgsfield Seedance pacing constraint from the source video)
- No FTC-risky claims (efficacy, health, financial returns) — workspace policy excludes those niches anyway, but check
