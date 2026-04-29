# 03-render

Drive Higgsfield Marketing Studio (UGC preset) to render the picked script's clips. Delegates to the existing higgsfield skill.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|---------------|---------------|-----|
| Picked script | `../02-script/output/<product-slug>-picked.md` | Full file | The dialogue + B-roll cues |
| Host look | `../../shared/hosts/<host-id>/look.md` + `reference-images/` | Full | Character consistency across clips |
| Product image | `inbox/<product-slug>/product/*.{jpg,png}` | Full | Higgsfield receives this for clip-2 (product reveal) |
| Higgsfield skill | `_core/skills/higgsfield/SKILL.md` | Marketing Studio command | The actual render call |

## Process

1. Read picked script. Split into clips (typically 3 clips, ~15s each).
2. For each clip, build a Higgsfield Marketing Studio call:
   - `node /Users/shakstzy/QUANTUM/_core/skills/higgsfield/scripts/run.mjs marketing --preset UGC --prompt "<clip prompt>" --new` (first clip) or `--project-id <pid>` (subsequent clips, to lock the host avatar).
   - First clip: pass host reference image via `--product-image` (overloaded for character image in UGC preset, see higgsfield skill for current spec).
   - Product-reveal clip: pass `--product-image` of the actual product.
3. Submit clips serially (Higgsfield is rate-limited and uses a single Chrome profile).
4. On each success, capture `run-id`, output mp4 path, credit cost.
5. Write `output/<product-slug>-renders.json` with `[{clip_index, run_id, mp4_path, credits, prompt}, ...]`.
6. If any clip fails (captcha, breaker tripped, model error), abort and surface state.json path. Do not partial-ship.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Render manifest | `output/<product-slug>-renders.json` | JSON array of clip metadata |
| Raw mp4s | `~/.quantum/skill-output/higgsfield/<run-id>/*.mp4` | mp4 (owned by higgsfield skill) |

## Audit

- All clips listed in picked script have a corresponding mp4 path in the manifest
- All mp4 paths exist on disk and are non-zero bytes
- Total credit cost in the manifest matches `~/.quantum/skill-output/higgsfield/<run-id>/state.json`
- No JWT or signed URL leaked into the manifest
