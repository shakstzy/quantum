---
name: gpt-images
description: Generate images on chatgpt.com using Adithya's existing ChatGPT plan via patchright (no OpenAI API key, no extra billing). Off-screen Chrome drives the chat UI, types the prompt, downloads the generated PNG, saves to skill-output. Triggers on "gpt image", "make me a gpt image", "generate an image with gpt", "chatgpt image of X", "openai image of X". For Higgsfield-specific image gen, use the higgsfield skill instead.
---

# gpt-images Skill

UI-driven image generation via chatgpt.com. Mirrors the discord/higgsfield pattern: persistent Chrome profile with one-time visible login, off-screen runtime Chrome for actual generation. No OpenAI API key, no separate billing — uses Adithya's ChatGPT Plus/Pro plan.

## When this fires

Trigger phrases (non-exhaustive): "gpt image", "make me a gpt image", "generate an image with gpt", "chatgpt image of X", "openai image of X", "generate an image of X" when context implies ChatGPT (not Higgsfield).

Do NOT fire for:
- Higgsfield models (nano banana, soul cinematic, seedance, kling, veo, wan, sora) → `higgsfield` skill.
- Imagen / Gemini-side generation → not yet wired (would be a separate skill).
- Image editing / variations / inpainting → out of scope v1.

## QUANTUM integration

This is a **generative skill**, not a data-source workspace.

| Property | Data-source workspace | This skill |
|---|---|---|
| Direction | Pulls external data INTO `raw/<name>/` | Produces NEW media OUTSIDE the repo |
| Graphify | Indexes its `raw/` deposits | Outputs are NOT indexed (not personal knowledge) |
| Output | `raw/<name>/YYYY-MM-DD-*` | `~/.quantum/skill-output/gpt-images/<run>/` |

Never deposit gpt-images outputs into `raw/`. They are not durable knowledge about Adithya's life.

- **Home:** `_core/skills/gpt-images/`
- **Chrome profile:** `~/.quantum/chrome-profiles/chatgpt/` (separate from higgsfield, web-research, discord)
- **Output folder:** `~/.quantum/skill-output/gpt-images/<YYYYMMDD-HHMMSS>-<slug>/`

## First-time setup (once)

```bash
cd _core/skills/gpt-images
node scripts/run.mjs login
```

First invocation runs `npm install` to fetch patchright + Chrome (~300MB, 2-3 minutes). After that, opens a visible Chrome window pointed at chatgpt.com. Sign in normally (Google / Apple / email). The script polls `/api/auth/session` until a user object appears, then closes.

Future runs reuse cookies silently. Re-run `login` when the session expires (Plus sessions are long-lived; expect months between logins).

## Commands

```bash
# One-time visible login.
node scripts/run.mjs login

# Confirm session is alive.
node scripts/run.mjs whoami

# Generate an image.
node scripts/run.mjs generate "a watercolor of a cyberpunk Austin skyline at dusk"

# With flags.
node scripts/run.mjs generate "..." --debug --timeout 240000 --out /tmp/test-run

# Profile / breaker state.
node scripts/run.mjs status

# Reset breaker after manual intervention.
node scripts/run.mjs reset-breaker
```

## Procedure (generate)

1. **Boot.** Off-screen patchright Chrome, persistent profile, breaker check, pidfile.
2. **Probe session.** `GET https://chatgpt.com/api/auth/session` — die early with a clear message if logged out.
3. **Cloudflare check.** Read body text for "verify you are human" / "just a moment". If present, trip breaker, halt.
4. **Submit prompt.** Wait for `#prompt-textarea`, click, type `Please generate an image: <prompt>`, press Enter.
5. **Poll for image.** Watch the newest `[data-message-author-role="assistant"]` for an `<img>` whose src is a real URL (not data:/blob:) and whose `naturalWidth`/`naturalHeight` are non-zero. Heuristic prefers `oaiusercontent.com` / `files.oai*` / `sdmnt*` hosts; falls back to any non-avatar https img >= 100px.
6. **Download.** `context.request.get(src)` — patchright's request inherits browser cookies, so signed CDN URLs resolve. Body written to `image-1.<ext>`.
7. **Metadata.** `metadata.json` with run_id, prompt, full_prompt, image_url, image_path, dimensions, bytes, user (email or id), created_at.
8. **Output.** Run dir absolute path on stdout. Errors on stderr.

## Failure modes

| Symptom | Cause | Action |
|---|---|---|
| `Session expired or never logged in` | Cookies cleared / session JWT expired | Run `login` |
| `Cloudflare challenge` | chatgpt.com flagged the off-screen Chrome | Run `login` (headed) once to refresh trust, or wait. Breaker trips. |
| `No image produced within 180s` | Model returned text only (often a content-policy refusal) or rate-limited | Inspect run dir for `prompt.txt`; rephrase. Plus / Pro have separate image quotas. |
| `Composer not found within 30s` | chatgpt.com UI changed (selector drift) | Run `--debug` to log poll output; update `COMPOSER_SELECTOR` in `generate.mjs`. |
| `Image fetch failed: HTTP 403` | Signed CDN URL expired before download | Re-run; CDN URLs are short-lived. |
| `BREAKER_HALTED` | Two consecutive bot-detection signals in 24h | `reset-breaker` only after understanding why it tripped. |

## Safety / ToS

- Driving chatgpt.com programmatically is in a grey zone. OpenAI's ToS allows browser-based use under your plan, but discourages automation. Detection signals (Cloudflare challenges, persistent CAPTCHAs) trip the 24h breaker by design.
- Off-screen Chrome ≠ headless. Patchright + visible flag (window moved off-screen) gets past most detection that pure headless trips. If chatgpt.com starts rejecting consistently, switch to fully visible runs (`--debug` + manual oversight) before raising the breaker bar.
- Plus / Pro plans have image-generation quotas. The skill does not track them; rely on the failure-mode table above.

## Files

- `scripts/run.mjs` — CLI dispatcher (entry for every verb)
- `scripts/login.mjs` — one-time visible login
- `scripts/generate.mjs` — chat-UI driver + DOM polling + asset download
- `scripts/browser.mjs` — patchright launcher, profile dir, pidfile, breaker, session probe
- `package.json` — patchright as the only dep; `postinstall` pins Chrome channel
