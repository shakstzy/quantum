---
name: higgsfield
description: Drive higgsfield.ai from Claude Code to generate images (Nano Banana Pro, Soul Cinematic), videos (Kling, Seedance, Veo, Wan, Sora), Marketing Studio ads, and Cinema Studio scenes. Browser automation via patchright over a dedicated persistent Chrome profile. Saves outputs locally with full metadata. Triggers on "higgsfield image", "higgsfield video", "nano banana", "soul cinematic", "marketing ad on higgsfield", "cinema studio scene".
---

# Higgsfield Skill

Five tool families on higgsfield.ai, one Node CLI. UI automation first, direct-API fallback, DataDome-aware stealth, resumable state machine, Quantum-compliant output.

## When this fires

Trigger phrases (non-exhaustive): "generate a higgsfield image", "higgsfield video", "make a marketing ad", "cinema studio scene", "nano banana", "soul cinematic", "seedance", "kling 2.5", "veo", "wan", "sora 2", "make me a video / image of X" when context implies higgsfield.

Do NOT fire for:
- Non-higgsfield AI image/video services (DALL-E, Midjourney, Runway — use their own skills/APIs).
- Text generation, music generation, audio generation.
- Edit / remix / inpaint flows on higgsfield (out of scope v1).
- Character or location creation (`/character`, Soul Cast/Location).

## Quantum integration

This is a **generative skill**, not a data-source workspace. Distinction:

| Property | Data-source workspace (slack, journal, ...) | This skill |
|---|---|---|
| Direction | Pulls external data INTO `raw/<name>/` | Produces NEW media OUTSIDE the repo |
| Graphify | Indexes its `raw/` deposits | Outputs are NOT indexed (not personal knowledge) |
| Output | `raw/<name>/YYYY-MM-DD-*` | `~/.quantum/skill-output/higgsfield/<run>/` |
| Safe to delete? | No, `raw/` is immutable | Yes, regen any time |

Never deposit Higgsfield outputs into `raw/`. They are not durable knowledge about Adithya's life.

- **Home:** `_core/skills/higgsfield/` (matches the other 13 Quantum skills)
- **Chrome profile:** `~/.quantum/chrome-profiles/higgsfield/` (persistent, first login manual, session survives restarts)
- **Output folder:** `~/.quantum/skill-output/higgsfield/<YYYYMMDD-HHMMSS>-<slug>/`

## Browser runtime contract

| Item | Path / Value |
|---|---|
| Profile directory | `~/.quantum/chrome-profiles/higgsfield/` |
| Login command | `node scripts/run.mjs login` |
| Pidfile | `~/.quantum/chrome-profiles/higgsfield/.skill.pid` (atomic `openSync(..., 'wx')`) |
| Breaker file | `~/.quantum/chrome-profiles/higgsfield/.breaker.json` |
| Breaker trip | Two consecutive 403s OR any captcha DOM detection |
| Breaker cooldown | 24h halt; `--force` to override |
| Auth probe | Clerk session cookie + DOM marker for signed-in state |

## First-time setup

```bash
cd _core/skills/higgsfield
npm install                       # installs patchright + chrome browser
node scripts/run.mjs login        # opens visible Chrome window for Clerk OAuth
```

Opens a visible Chrome window. Complete Clerk login (Google / Apple / Microsoft / email). Skill confirms session and writes profile to disk. Future runs reuse silently. If session expires, run `login` again.

## Commands

```bash
node scripts/run.mjs image --model nano-banana-pro --prompt "..." [--aspect 3:4] [--res 1k] [--batch 1]
node scripts/run.mjs image --model soul-cinematic  --prompt "..." [--aspect 16:9] [--character <id>]
node scripts/run.mjs video --model seedance_2_0    --prompt "..." [--start-frame PATH] [--duration 5s]
node scripts/run.mjs marketing --preset UGC        --prompt "..." [--project-id X | --new] [--product-image PATH]
node scripts/run.mjs cinema    --mode image|video  --scene "..." [--project-id X | --new] [--duration 8s]
node scripts/run.mjs batch --jobs <jobs.jsonl> [--concurrency 4]
node scripts/run.mjs resume <run-dir>
node scripts/run.mjs status
```

All commands accept `--output <dir>` (override default), `--dry-run` (print intent, do not submit), `--debug` (keep browser open on failure).

## Procedure

1. **Pre-flight.** Read the target tool's section in `rules/tool-flows.md` for selector map and body schema. Confirm cost with user if > 20 credits.
2. **Launch.** `node scripts/run.mjs <cmd> ...`. Dispatcher checks pidfile, installs deps if missing, spawns the target handler.
3. **State machine.** Every transition (`pending -> submitted -> polling -> downloading -> saved/failed/timeout`) writes `state.json` atomically. If the process dies, `resume <run-dir>` picks up.
4. **Circuit breaker.** Two consecutive 403s OR any captcha DOM trips a 24h halt. Refuses to launch until cooldown expires or `--force`.
5. **Report.** On success: local file path + cost + job UUID. On failure: state.json path + specific error. Never prints JWT or signed CloudFront URL.

## Budget and safety

- Per-run cost cap: 500 credits default (`--cost-cap N` to override). Default covers any single submit incl. cinema video (96 cr); still catches runaway batches.
- Max retries on 429: 3, total wait capped at 5 minutes.
- Polling caps: 5 min for images, 30 min for videos. Timeout leaves `state=timeout`; resumable.
- Concurrent invocations on same profile: refused via pidfile.

## Files

- `scripts/run.mjs` — CLI dispatcher (entry point for every command)
- `scripts/{image,video,marketing,cinema,batch}.mjs` — per-tool handlers
- `scripts/{browser,job,state,download,ui-submit,jwt,behavior,fingerprint}.mjs` — shared infra
- `scripts/diag-*.mjs` — DOM probes for selector-drift debugging (no spend, no submit)
- `rules/tool-flows.md` — per-tool UI selectors, backend slugs, body schemas (reference; catalogs are hardcoded in `.mjs`)
- `rules/datadome-defenses.md` — stealth stack, cadence settings, circuit-breaker rules
- `rules/output-conventions.md` — output folder layout, metadata.json schema
- `rules/site-map.json` — discovered routes

## Composing into workflows

Higgsfield is a primitive other skills can shell out to. Each run produces a deterministic `<runDir>` containing `state.json` (job_uuid, prompt, params) and `metadata.json` (local_path, sha256, cost_credits_actual). Pattern:

```bash
RUN_DIR=$(node _core/skills/higgsfield/scripts/run.mjs image \
  --model nano-banana-pro --prompt "..." --aspect 1:1 --res 1K \
  | grep -oE "/Users/.*skill-output/higgsfield/[^ ]+")
LOCAL_PATH=$(jq -r '.local_path' "$RUN_DIR/metadata.json")
# now hand $LOCAL_PATH to ffmpeg / zernio-post / iMessage / wherever
```

Composition recipes (Claude can wire these on demand, no extra code needed):
- **Generate then publish:** `higgsfield image` → `_core/skills/zernio-post` (cross-platform)
- **Generate then text:** `higgsfield image` → `_core/skills/macos-contacts-imessage` send with attachment
- **Batch then post-process:** `higgsfield batch --jobs jobs.jsonl` → loop over `metadata.json` files → `_core/skills/ffmpeg` for transcode/thumbnail
- **Storyboard:** prompt `_core/skills/local-llm` for N scene descriptions → emit `jobs.jsonl` → `higgsfield batch`

## Out-of-scope (v1)

- No audio gen (`/ai/audio`)
- No character / location creation (`/character`, Soul Cast/Location)
- No edit / remix / inpaint
- No cron / scheduled launches (use `batch` for parallel submits)
- No automatic upscale / post-processing

## Troubleshooting

| Problem | Action |
|---|---|
| `Profile locked by pid N` | Wait or kill stale pid. |
| `Session expired` | `node scripts/run.mjs login` |
| `403 from DataDome` | Breaker halt 24h. Wait or `--force`. Consider tethering / proxy. |
| `Captcha in DOM` | Same as above. |
| Downloaded file size 0 / mismatch | `resume <run-dir>` retries download only. |
| `Insufficient credits` | Top up. Skill surfaces wallet balance pre-submit. |

## ToS

Automated access to higgsfield.ai likely violates ToS; DataDome bypass is circumvention of technical protection. Use at user's discretion. Burner account recommended.
