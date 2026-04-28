# Higgsfield Workspace

Generative skill for higgsfield.ai. Drives image, video, Marketing Studio, and Cinema Studio gens via headed browser automation over a persistent Chrome profile. Outputs land outside the repo at `~/.quantum/skill-output/higgsfield/`.

## When to use

Trigger on any of:

- "generate a higgsfield image"
- "higgsfield video of ..."
- "make a marketing ad"
- "cinema studio scene"
- "nano banana", "soul cinematic", "seedance", "kling", "veo", "sora 2"

Do NOT use for:

- Non-Higgsfield image/video services (use their own skills)
- Text generation, music generation, audio
- Edit / remix / inpaint, character or location creation (out of scope v1)

## How this fits ICM

Higgsfield is a **generative skill workspace**, not a data-source workspace. Distinction:

| Property | Data-source workspace (slack, email, journal, ...) | Generative workspace (higgsfield) |
|---|---|---|
| Direction | Pulls external data INTO `raw/<name>/` | Produces NEW media OUTSIDE the repo |
| Graphify | Consumes its `raw/` deposits | Not indexed; outputs are not personal knowledge |
| Output location | `raw/<name>/YYYY-MM-DD-*.{md,json,...}` | `~/.quantum/skill-output/higgsfield/<run>/` |
| Deletes safe? | No, raw is immutable | Yes, regen any time |

Keep the boundary clean. **Never deposit Higgsfield outputs into `raw/`.** They are not durable knowledge about Adithya's life.

## Layout

```
workspaces/higgsfield/
├── CLAUDE.md          (this file)
├── SKILL.md           (operator-facing usage and procedure)
├── package.json
├── package-lock.json
├── .gitignore
├── scripts/           (Node CLI: run.mjs is the entry point)
│   ├── run.mjs        (dispatcher)
│   ├── browser.mjs    (patchright runtime, profile, breaker)
│   ├── login.mjs      (one-time Clerk auth)
│   ├── image.mjs      (Nano Banana Pro, Soul Cinematic)
│   ├── video.mjs      (Kling, Seedance, Veo, Wan, Sora)
│   ├── marketing.mjs  (Marketing Studio ads)
│   ├── cinema.mjs     (Cinema Studio scenes)
│   ├── batch.mjs      (parallel jobs.jsonl runner)
│   ├── state.mjs      (atomic state.json transitions)
│   ├── download.mjs   (CloudFront fetch + checksum)
│   ├── job.mjs, jwt.mjs, behavior.mjs, fingerprint.mjs, ui-submit.mjs
│   └── diag-*.mjs     (DOM probes, kept for selector drift debugging)
└── rules/
    ├── tool-flows.md          (per-tool selectors + body schemas, source of truth)
    ├── datadome-defenses.md   (stealth, cadence, breaker policy)
    ├── output-conventions.md  (run dir layout, metadata.json schema)
    └── site-map.json
```

## Out-of-tree state

| Path | Purpose | Backed up? |
|---|---|---|
| `~/.quantum/chrome-profiles/higgsfield/` | Persistent logged-in Chrome profile | NO |
| `~/.quantum/skill-output/higgsfield/<run>/` | Generated media + state.json + metadata.json | NO |
| `~/.quantum/chrome-profiles/higgsfield/.skill.pid` | Atomic lock; refuses concurrent runs | n/a |
| `~/.quantum/chrome-profiles/higgsfield/.breaker.json` | 24h cooldown after 403/captcha | n/a |

Exclude `~/.quantum/` from iCloud / Dropbox sync. The Chrome profile contains session cookies.

## Procedure for Claude

1. Read `SKILL.md` for the exact CLI command shape.
2. Read the relevant section of `rules/tool-flows.md` BEFORE writing or modifying any selector / body schema. That file is the single source of truth.
3. Confirm cost with Adithya if a single submit is over 20 credits, or if a batch totals over 50.
4. Run from this folder: `node scripts/run.mjs <cmd> ...`
5. On 403 or captcha DOM, breaker trips for 24h. Do NOT pass `--force` without Adithya's explicit approval.
6. Never print JWTs, Clerk session cookies, or signed CloudFront URLs.

## Failure modes — what to do

| Symptom | Action |
|---|---|
| `Profile locked by pid N` | Another run is live. Wait, or `kill N` if stale. |
| `Session expired` | `node scripts/run.mjs login`, complete OAuth in the headed Chrome window. |
| `403 from DataDome` | Breaker tripped. Wait 24h. Do not auto-override. |
| Downloaded file size 0 | `node scripts/run.mjs resume <run-dir>` retries the download step only. |
| Selectors broken (UI drift) | Run a `diag-*.mjs` probe, then update `rules/tool-flows.md`, then re-test. |

## ToS note

Automating higgsfield.ai likely violates their ToS, and DataDome bypass is technical-protection-measure circumvention. Use a burner account; main may be suspended.
