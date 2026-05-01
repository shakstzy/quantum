---
name: grok-web
description: Drive grok.com via patchright using Adithya's X Premium-linked account (no xAI API key, no separate billing). Off-screen Chrome runs the chat UI; SSE/NDJSON/WebSocket stream is captured for clean response text + citations + images. Verbs: login (one-time visible sign-in via "Sign in with X"), whoami, chat with --model and --mode (default | think | deepsearch), quota (read /api/rate-limits), status, reset-breaker, diag (selector + network discovery for self-heal). Triggers on "ask grok", "grok this", "use grok", "grok think", "grok deepsearch". For xAI API calls (paid), use a separate grok-cli skill -- not yet built.
---

# grok-web Skill

UI-driven chat against grok.com. Mirrors gpt-images / discord / x-read pattern: persistent Chrome profile with one-time visible login, off-screen runtime Chrome for chat, atomic pidfile, single-strike breaker on cloudflare/captcha. No xAI API key, no separate billing -- uses Adithya's X Premium grok.com access.

## When this fires

Trigger phrases (non-exhaustive): "ask grok X", "grok this", "use grok for X", "grok think mode", "grok deepsearch X", "what does grok say about X", "run X through grok".

Do NOT fire for:
- xAI Cloud API (api.x.ai) -- separate billed surface, would be a different skill (grok-cli).
- ChatGPT / GPT image gen -- use `gpt-images` skill.
- Higgsfield models -- use `higgsfield` skill.
- Reading X (Twitter) -- use `x-read` skill (different account surface).

## QUANTUM integration

This is a **generative skill**, not a data-source workspace. Outputs go OUTSIDE `raw/`.

| Item | Path / Value |
|------|--------------|
| Skill home | `_core/skills/grok-web/` |
| Profile dir | `~/.quantum/chrome-profiles/grok/` (persistent) |
| Pidfile | `~/.quantum/chrome-profiles/grok/.skill.pid` |
| Breaker | `~/.quantum/chrome-profiles/grok/.breaker.json` (single-strike, 24h) |
| Output | `~/.quantum/skill-output/grok-web/<runId>/{response.md, prompt.txt, metadata.json}` |
| Auth probe | A few candidate `/api/auth/session`-ish URLs; first 200 wins. Diag locks it down. |

Never deposit grok-web outputs into `raw/`. Not durable knowledge about Adithya's life.

## First-time setup

```bash
cd _core/skills/grok-web
node scripts/run.mjs login
```

First invocation runs `npm install` (patchright + Chrome, ~300MB, 2-3 minutes). Then opens a visible Chrome window pointed at grok.com. Recommended path: click "Sign in with X" so X Premium is linked. The script polls a session endpoint until logged in, then closes.

Future runs reuse cookies silently. Re-run `login` if a `chat` call exits 2 (session expired).

## Commands

```bash
# One-time visible login.
node scripts/run.mjs login

# Confirm session.
node scripts/run.mjs whoami

# Default chat.
node scripts/run.mjs chat "Explain transformer architecture briefly"

# Pick a specific model.
node scripts/run.mjs chat "Solve: ..." --model "Grok 4.1"

# Toggle Think mode (chain-of-thought).
node scripts/run.mjs chat "Prove ..." --mode think

# Toggle DeepSearch mode (multi-source web research with citations).
node scripts/run.mjs chat "What's new in ..." --mode deepsearch

# Read current rate-limit window.
node scripts/run.mjs quota
node scripts/run.mjs quota --effort high

# Self-heal: dump live UI + network shapes.
node scripts/run.mjs diag --prompt "Hello"

# State.
node scripts/run.mjs status
node scripts/run.mjs reset-breaker
```

## Procedure (chat verb)

Live-verified 2026-04-30 against grok.com.

1. **Boot.** Off-screen patchright Chrome (`channel: 'chrome'`, `--disable-blink-features=AutomationControlled`), persistent profile at `~/.quantum/chrome-profiles/grok/`, atomic pidfile (`openSync wx`), breaker check. Single launch per profile.
2. **Probe session.** `GET /rest/user-settings` (200 JSON = signed in). Fast-fail with exit 2 if logged out. User id read from the `x-userid` cookie.
3. **Challenge probe.** Cloudflare / Turnstile / captcha / account-locked text in body. Trip breaker on hit (single-strike, 24h).
4. **Attach multi-transport capture** (P0 from Codex+Gemini): subscribes to `page.on('response')` for SSE / NDJSON / streamed JSON, plus `page.on('websocket')` for token frames. Quota responses (`POST /rest/rate-limits`) parsed in parallel. URL filter is POST-only and restricted to `/rest/app-chat/conversations/(new|<id>/responses)` so listing GETs do not falsely terminate the aggregator.
5. **Submit-timing listener.** `page.on('request')` filtered to chat-POST URLs records `submittedRequestAt` -- the true "submit landed" signal. (Round-1 P0 fix: `onChatChunk` only fires after the entire response body downloads, which can be >12s for Think/DeepSearch and would falsely time out submit verification.)
6. **Steer.** If `--model`: click `button[aria-label="Model select"]` to open the unified picker (the live setting `useModelModeSelector3: true` means model + mode share one menu), then click the `[role="menuitem"]` matching the requested name. If `--mode think|deepsearch`: same picker, match against `MODE_LABELS`. NEVER press Escape after picking -- live-observed 2026-04-30 it raced with composer focus and clipped subsequent typing. The follow-on composer click safely closes any leftover picker state.
7. **Compose + send.** Type prompt into the live-discovered Tiptap/ProseMirror composer (`div.tiptap.ProseMirror[contenteditable="true"]`). Click `[data-testid="chat-submit"]` once it flips from disabled+invisible to enabled+visible; fall back to `Cmd+Enter` (NEVER plain Enter -- inserts newline in Tiptap). `submittedAt` = click time.
8. **Verify submit.** Wait up to 12s for `submittedRequestAt` to be set by the request listener. Exit 6 if not.
9. **Collect stream.** `StreamAggregator` ingests NDJSON lines from `POST /rest/app-chat/conversations/new`. Each event is `{result: {response: {...}}}` (or `{result: {conversation: {...}}}`); `unwrapGrok` peels both. Tokens with `isThinking: true` route to `thinkingText`; `isThinking: false` tokens route to the main answer. Citations + images extracted from `modelResponse.webSearchResults`, `modelResponse.steps[].webSearchResults`, `modelResponse.generatedImageUrls`, `modelResponse.imageAttachments` (deduped by URL). Watchdogs:
   - **Shadow-ban** (no body-read complete within 90s of click): try DOM-text fallback; else exit 4.
   - **Idle** (no new chunks for 12s after first): treat as terminal.
   - **Hard timeout**: `--timeout` ms, default 240000.
   - **Quota fast-fail**: if quota probe returns `ok=false` or 429, exit 5 with `wait_seconds`.
   - **Network terminal signals**: NDJSON `isSoftStop: true`, `modelResponse.message` appearance, `finalMetadata`, `loadingFinished` on chat URL, generic `done`/`final`/`completed`/`finishReason` fields.
10. **Pick text source.** Trust network text whenever the stream terminated cleanly (json-terminal, http-loadingFinished from chat URL). Fall back to DOM-scrape of the last assistant turn ONLY when network yielded nothing -- network is ground truth otherwise.
11. **Persist.** `response.md` (just the answer; thinking-trace separate in metadata if any), `metadata.json` with run_id, prompt, requested model/mode, `submitted_to_request_ms` + `body_complete_ms` timing, transport list, citations (URLs + titles + snippet ≤200 chars), image URLs with signed query params redacted, follow-up suggestions, quota snapshot. **Failure paths** (`shadowban-network.json`, `failure-network.json`) redact UUIDs and `rid=` query params from URLs (round-1 P1 fix). NO cookies, auth headers, account email, or conversation/message IDs anywhere in output.

## Failure modes (handled)

| Symptom | Exit | Action |
|---|---|---|
| Session expired / never logged in | 2 | Run `login`. |
| Cloudflare / Turnstile / captcha | 3 | Breaker tripped 24h. Run `login` headed once challenge clears. |
| Submit accepted but no stream within 30s + DOM empty | 4 | Possible shadow-ban or undetected transport. Inspect `shadowban.png` + `shadowban-network.json` in run dir. |
| Quota exhausted / 429 | 5 | Wait `wait_seconds` then retry. Caller decides. |
| Composer / send button missing | 6 | UI changed. Run `diag` to discover new selectors. |
| Stream did not terminate within timeoutMs | 7 | Inspect `failure.png` + `failure-network.json`. |

## Self-heal protocol (per learnings/2026-04-30-live-test-and-fix-browser-skills.md)

When a `chat` call breaks (composer missing, no stream, wrong model selected):

1. Run `node scripts/run.mjs diag --prompt "Hello"`. Writes 14+ artifacts to `/tmp/grok-web-diag-<ts>/`.
2. Read `03-composer-survey.json`, `04-send-button-survey.json`, `05-model-picker-survey.json`, `06-mode-toggle-survey.json`, `10-message-survey.json`, `11-network-capture.json`, `13-quota-probe.json`.
3. Update `COMPOSER_SELECTORS` / `SEND_SELECTORS` / `MODE_LABELS` in `chat.mjs`. Pin the real auth + quota URLs in `browser.mjs` / `run.mjs` (the candidate-list pattern is intentional drift-tolerance).
4. Re-test live. Codex round on the patch. Re-test once more on a different prompt + mode.
5. Update this SKILL.md if the procedure section's selectors / endpoints changed.

## Anti-detection (per Codex+Gemini P1)

- Real persistent profile, off-screen visible Chrome (not headless). `--disable-blink-features=AutomationControlled` set; `channel: 'chrome'` (not Chromium).
- **No fake jitter / mouse noise / typing-jitter.** Codex flagged this as brittle and crossing into adversarial-evasion. Patchright defaults are sufficient.
- Single browser process per profile, atomic pidfile, one chat at a time. Cross-tab interleaving on the same profile is not safe.
- Single-strike breaker on Cloudflare / Turnstile / "verify you are human". 24h cooldown.

## ToS / safety

- Driving grok.com programmatically is a grey area. xAI / X is more aggressive than OpenAI on bot mitigation (per Gemini). Read-pace use is low signal but nonzero risk.
- Account-level enforcement; an X Premium ban here is more painful than a chatgpt.com ban -- Adithya should consider whether to run this on a burner if usage scales. v1 targets the main account.
- Storage: `0700` profile dir. Cookies in the persistent Chrome profile only, never copied into `metadata.json`. Breaker file is plain JSON.

## Files

- `package.json` -- patchright dep + `postinstall: patchright install chrome`
- `scripts/run.mjs` -- CLI dispatcher (login, whoami, chat, quota, diag, status, reset-breaker)
- `scripts/browser.mjs` -- patchright launcher, atomic pidfile, breaker, multi-transport capture (`attachCapture`), session probe, challenge detect
- `scripts/login.mjs` -- visible-Chrome login flow
- `scripts/chat.mjs` -- chat verb with steering primitives + StreamAggregator wiring + DOM fallback
- `scripts/stream.mjs` -- transport-agnostic StreamAggregator (SSE / NDJSON / generic JSON), terminal-marker classification
- `scripts/quota.mjs` -- parser for `/api/rate-limits` JSON + 429 + `Retry-After`
- `scripts/diag.mjs` -- live selector + network survey, dumps screenshots + JSON
- `tests/stream.test.mjs` -- 16 unit tests for the parser
- `tests/quota.test.mjs` -- 12 unit tests for the rate-limit parser
- `tests/fixtures/` -- canned SSE / WS / quota payloads

Run `npm test` from skill root to exercise the parsers without a browser.

## Hardenings (codex+gemini reviewed, 2 rounds)

- **Drive UI, read network** (round 0 P0): hybrid pattern. Not pure DOM scraping.
- **Multi-transport capture** (round 0 P0): SSE, NDJSON, WS frames; live-discovered grok.com uses NDJSON over a single POST.
- **Multi-signal terminal** (round 0 P0): isSoftStop, finalMetadata, modelResponse.message, http-loadingFinished, NDJSON-line terminal markers (`done`/`final`/`completed`/`finishReason`).
- **POST-only chat URL filter** (round 1 P0): listing GETs (`/rest/app-chat/conversations?pageSize=...`) MUST be excluded; they return finite JSON and would falsely terminate the aggregator.
- **page.on('request') for submit timing** (round 1 P0): `onChatChunk` fires only after `response.text()` resolves (= loadingFinished), which can be >12s for Think/DeepSearch. The request listener fires at POST send time, so submit verification works for any prompt length.
- **DOM fallback** when network-text is empty: covers transports the classifier hasn't learned yet, while still surfacing the answer.
- **Distinct exit codes** for shadow-ban (4), rate-limit (5), steering failure (6), timeout (7).
- **Quota probe at chat time** captures `/rest/rate-limits` JSON in parallel; explicit fast-fail on `ok=false`.
- **No Escape after picker pick** (round 1 P2): live-observed it raced with composer focus and clipped typing. Trusted composer.click() dismisses leftover picker state safely.
- **No mouse/typing jitter** (round 0 P1): brittle and adversarial-evasion territory; patchright fingerprint hardening is sufficient.
- **Storage redaction**: `metadata.json` strips signed query params from image URLs, omits account email, cookies, auth headers, conversation/message IDs. Failure paths (`shadowban-network.json`, `failure-network.json`) ALSO redact UUIDs and `rid=` query params (round 1 P1).
- **Race-free chatRequests record** (round 1 P1): each request's record is captured in a local `const` before push; later `endedAt` mutation targets that record, not `array[length-1]`.
- **Bounded body read** (round 1 P2): `Promise.race` with 5min ceiling on `response.text()` so a future endpoint that streams indefinitely cannot lock the listener.
- **Single-strike breaker** on any challenge surface.

## Known limitations (v1)

- Selectors are loose pending the first live `diag` run. Expect to tighten `COMPOSER_SELECTORS` / `SEND_SELECTORS` / model-picker logic after empirical evidence.
- Streaming-text reconstruction relies on response-body-on-finish for HTTP transports (Playwright doesn't expose chunk-level reads from `response.body()` mid-stream). Real-time UX comes from DOM updates the user doesn't see; the network parser still gets the pristine final text. WS streaming gets per-frame capture and is preferred.
- Voice mode, image generation via Grok Imagine, and file uploads are out of scope v1. Add when a workflow needs them.
- Rate-limit endpoint is best-effort -- the candidate list will be pinned after the first diag.
- No automatic retry on rate-limit / shadow-ban -- caller decides.
