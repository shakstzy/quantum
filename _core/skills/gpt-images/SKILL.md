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

1. **Boot.** Off-screen patchright Chrome, persistent profile, atomic pidfile (`openSync wx`), breaker check.
2. **Probe session.** `GET https://chatgpt.com/api/auth/session` — die early with a clear message if logged out.
3. **Cloudflare check.** Read body text for "verify you are human" / "just a moment". If present, trip breaker, halt.
4. **Pre-submit snapshot.** Capture existing `<img>` src set in `<main>` and current user-turn count. Used to require a NEW image (rules out stale prior outputs) and verify submission landed.
5. **Submit prompt.** Wait for `#prompt-textarea`, click, type `Please generate an image: <prompt>`. Wait up to 5s for an enabled send button (`[data-testid="send-button"]` and 4 fallback selectors), click it. If no button surfaces, fall back once to `Cmd+Enter` (ProseMirror's submit shortcut). Plain Enter is unsafe — it inserts a hard break in ChatGPT's editor.
6. **Verify submission.** Poll for the user-turn count to increment within 10s. If not, the click was a no-op — fail fast instead of waiting the full image-poll timeout.
7. **Poll for new image.** Search `<main>` for `<img>` whose src is not in the pre-submit set, hosted on an OpenAI asset domain (`oaiusercontent.com`, `files.oai*`, `sdmnt*`, `chatgpt.com/backend-api/estuary|files`) OR rendered ≥ 200×200. Stability gate: require **two consecutive polls** with the same src + naturalWidth/Height before declaring ready, so a low-res placeholder doesn't get downloaded before it swaps to full-res.
8. **Download + validate.** `context.request.get(src)` (inherits browser cookies). Reject responses < 512 bytes. Magic-byte sniff (PNG/JPEG/WebP/GIF) — if the body is HTML or empty, fail with a clear error so a Cloudflare interstitial returning 200 is not silently saved as `image-1.png`.
9. **Metadata.** `metadata.json` with `run_id`, `prompt`, `full_prompt`, `image_url` (signature/token query params redacted), `image_path`, `width`/`height`, `bytes`, `user` (email or id), `page_url`, `created_at`.
10. **Output.** Run dir absolute path on stdout. Errors on stderr. Failures also drop `failure.png` + `failure-dom.json` into the run dir for selector-drift diagnosis.

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
- `scripts/browser.mjs` — patchright launcher, profile dir, atomic pidfile, breaker, session probe
- `scripts/diag.mjs` — selector-survey + screenshot tool for debugging UI drift
- `package.json` — patchright as the only dep; `postinstall` pins Chrome channel

## Hardenings (codex-reviewed)

- **Pre-submit image snapshot** prevents reporting a prior image in the same conversation as a new success.
- **User-turn increment check** verifies the click actually submitted before we wait minutes for an image.
- **Stability gate** (two consecutive matching polls) avoids downloading the low-res placeholder.
- **Magic-byte sniff** rejects HTML challenge pages and empty bodies that returned HTTP 200.
- **Atomic pidfile** (`openSync wx` with stale-pid recovery) prevents two concurrent runs on the same profile.
- **Storage-state restore is idempotent** — only re-injects cookies when the persistent context has none, so a stale snapshot can't poison a working session.
- **Login timeout no longer trips the bot-detection breaker** — only Cloudflare/captcha signals do.
- **Signed-URL credentials** (`sig=`, `signature=`, `X-Amz-Signature`, `token`) are redacted in saved `metadata.json`.
