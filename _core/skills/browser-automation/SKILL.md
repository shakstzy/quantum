---
name: browser-automation
description: Decision rule for picking between patchright (stealth Playwright fork), browser-use (LLM-driven browser agent), and plain Playwright when building or running browser automation. Use when scaffolding a new browser skill, writing a scraper, automating a login flow, or any task that involves driving a real browser. Do NOT use for one-off `curl` / `firecrawl` page fetches (use those skills) or for static HTML parsing.
---

# browser-automation

Trigger doc for routing Claude to the right browser stack. Three tools are installed; they solve different problems and are not interchangeable.

## When this fires

Trigger phrases (semantic, non-exhaustive): "scrape <site>", "automate <site>", "log into X with a browser", "fill out this form", "click through this flow", "navigate to X and do Y", "screenshot this page", "build a browser skill / scraper / bot for X", "scaffold a new browser-driven workspace", "drive the browser to X", "headless chrome for X", "I need a real browser session for X". Also fires whenever a new SKILL.md or workspace will spawn a Chromium/Firefox/WebKit instance.

Do NOT fire for:
- Single-URL clean-markdown extraction. Use `firecrawl` skill.
- Web search. Use `brave-search` skill.
- YouTube / Instagram URL summaries. Use those dedicated skills.
- Static HTML parsing where `curl` + `pup` / `BeautifulSoup` is enough.
- Anthropic-side browser tools (`mcp__Claude_in_Chrome__*`, `mcp__Claude_Preview__*`). Those are interactive aids, not skill backends.

## Decision matrix

Pick by job, not by familiarity.

| Use case | Pick | Why |
|----------|------|-----|
| Stealth-sensitive sites: Discord, Cloudflare, Datadome, PerimeterX, anti-bot vendors, login walls, captchas, ToS-sensitive surfaces | **patchright** | Stealth Playwright fork. Patches Chromium fingerprint leaks (CDP runtime detection, `navigator.webdriver`, automation flags). Drop-in Playwright API. Already used in `discord` skill and `higgsfield` workspace. |
| Brittle or fast-changing UIs where CSS selectors rot, OR low-detection sites where LLM-driven navigation beats writing selectors. Good for one-off automations and creative tools. | **browser-use + Gemma** | LLM sees the page (vision + accessibility tree) and reasons about clicks. Zero selector maintenance. Pair with the local Gemma daemon (`local-llm` skill at `127.0.0.1:8765`) to keep it free and offline. |
| Everything else: own apps, public docs, cooperative APIs, deterministic flows with stable selectors | **plain Playwright** | Lightest, best debug ergonomics, no stealth or LLM tax. Default for new skills. |

## Procedure

1. **Classify the target site first.** Is there a login wall, captcha, or anti-bot vendor in front? -> patchright. Is the DOM unstable or the flow exploratory? -> browser-use. Otherwise -> plain Playwright.
2. **Match what the workspace already uses.** If editing an existing skill, do not switch stacks mid-skill without an explicit reason and Adithya's approval.
3. **Reuse existing skill scaffolding.** `_core/skills/discord` and `workspaces/higgsfield` are the canonical patchright references (Node, npm, `postinstall: patchright install chrome`, custom fingerprint helpers in `scripts/fingerprint.mjs` / `scripts/behavior.mjs`).
4. **Persistent profiles.** Stealth skills store Chrome profiles under `~/.quantum/chrome-profiles/<skill>/`. Reuse that convention; do not invent new profile homes.
5. **Use Gemma as a tool, not a driver.** See "When to call Gemma" below. Default browser skills are deterministic; Gemma steps in only at fuzzy decision points.
6. **Audit.** Run the Audit table below before declaring done.

## When to call Gemma (LLM-as-a-tool decision rule)

Default: deterministic code drives the browser. Gemma is a helper, not a co-pilot. Every Gemma call costs ~0.5-2s of latency and pollutes timing patterns, so pay only when straight code would fail or rot fast.

**CALL Gemma when at least one is true:**

1. **DOM doesn't have the answer.** Canvas-rendered UI, iframes you can't reach, image-only state, captcha questions, charts. -> `seeWithGemma(page, prompt)`
2. **Selectors will rot in <30 days.** Auto-generated class names (`css-1a2b3c`, Tailwind JIT, styled-components hashes), A/B-tested layouts, frameworks that re-render with random IDs (Next.js, parts of React), Discord/Higgsfield-class sites that ship UI weekly. -> `findByDescription(page, "primary submit button")` (selector cache makes this near-free on repeat runs)
3. **Multiple plausible matches; the right one needs meaning.** "Click the primary CTA" on a page with 5 buttons, "find the cancel-subscription link" buried in footer junk, "the Continue button vs Skip vs Maybe Later." -> `findByDescription(...)`
4. **Free-form extraction from messy text.** Receipts, dynamic article layouts, user-generated content, anything where structure varies per page. -> `extractStructured(page, "{title, author, published_at}")`
5. **Branch-decision the script can't reliably make.** "Did login succeed, or did it bounce to 2FA, or did it captcha?" "Is this a paywall, a login wall, or the real article?" "Did the upload finish, or is it still processing?" -> `judgeState(page, question, ["logged_in", "needs_2fa", "captcha", "error"])`
6. **First-time discovery on a new flow.** Use Gemma to find the right elements once, let the selector cache warm, then most subsequent runs skip Gemma entirely.

**Do NOT call Gemma when:**

1. A CSS selector exists and has been stable for 30+ days. Just use it.
2. The data is in `aria-label`, `data-testid`, or visible text. `getByRole({name})` / `getByText(...)` is faster and free.
3. You're inside a hot loop (>5 actions/sec). LLM calls don't fit.
4. The flow is already mapped and the cached selector resolves. Trust the cache.
5. Sensitive auth surfaces. Never feed Gemma session cookies, password fields, OTP codes, or full request bodies. Vision + visible text only.
6. Cost-sensitive batch jobs where you've already mapped the page once. Re-use the mapping.

**Decision tree (one-pass):**

```
Need to interact with the page?
├─ Stable selector exists?               -> use it (Playwright/patchright direct)
├─ Visible text / ARIA pins it uniquely? -> getByRole / getByText
├─ Cached selector from prior run?       -> try cache; if dead, re-discover
├─ Semantic disambiguation needed?       -> findByDescription(page, "...")
├─ Need to read the page state?          -> judgeState(page, "...", [opts])
├─ Pull structured data from messy text? -> extractStructured(page, "...")
└─ Vision-only signal (canvas/captcha)?  -> seeWithGemma(page, "...")
```

**Helper module:** `/Users/shakstzy/QUANTUM/_core/skills/local-llm/scripts/gemma-helpers.mjs`. Import directly from any Node skill, no extra deps. Selector cache lives at `~/.quantum/gemma-cache/browser-selectors.json` and is keyed by origin + path-template + role + description, so cross-run hits work and per-skill cache busting is `clearSelectorCache()`.

**Usage example (patchright + Gemma helpers):**

```js
import { chromium } from 'patchright';
import { findByDescription, judgeState, extractStructured } from '../../local-llm/scripts/gemma-helpers.mjs';

const ctx = await chromium.launchPersistentContext(/* ... */);
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://example.com/login');

// Deterministic where you can.
await page.locator('input[name=email]').fill(email);
await page.locator('input[name=password]').fill(password);
await page.locator('button[type=submit]').click();

// Fuzzy where you must.
const state = await judgeState(page, 'What state is this login flow in?', ['logged_in', 'needs_2fa', 'captcha', 'error']);
if (state?.answer === 'needs_2fa') { /* ... */ }

const cta = await findByDescription(page, 'primary call-to-action button');
await cta?.click();
```

**Python parity:** not yet built. If a browser-use (Python) skill needs the same selective-Gemma pattern, port the helpers to `gemma_helpers.py` in this same scripts dir. The OpenAI-compatible endpoint is identical.


## Anti-patterns

- **Do NOT mix browser-use with patchright.** browser-use has no first-class patchright backend (Codex confirmed 2026-04). Connecting via `cdp_url` to a separately launched patchright Chromium is possible but fragile and unsupported. If a target needs BOTH stealth AND LLM navigation, ask Adithya before going that route.
- **Do NOT default to browser-use for Discord, Higgsfield, or anything ToS-sensitive.** LLM-driven actions add unusual timing patterns AND inherit vanilla Playwright's fingerprint, which is *worse* on detection than plain patchright.
- **Do NOT add `playwright` as a Node dep when patchright is already in `package.json`.** Patchright's API is identical; just `import { chromium } from 'patchright'`.
- **Do NOT pay for browser-use Cloud.** Their stealth story is the cloud product; the OSS local version is plain Playwright. For stealth, switch to patchright instead.

## Install state

| Tool | Where | How installed | Notes |
|------|-------|---------------|-------|
| `patchright` | Per-skill npm dep | `npm i patchright && npx patchright install chrome` (canonical: `_core/skills/discord/package.json`, `workspaces/higgsfield/package.json`) | Chromium-only. Drop-in for `playwright`. Add to any new Node skill that needs stealth. |
| `browser-use` | Globally exposed via `uv tool install browser-use` (v0.12.6, 2026-04-28) | CLIs on PATH: `browser-use`, `bu`, `browser`, `browser-use-tui`, `browseruse`. Python lib usable from any project. | Defaults to vanilla Playwright underneath. Pair with `local-llm` skill (Gemma at `127.0.0.1:8765`) for the LLM brain. |
| `playwright` | Globally installed | `/opt/homebrew/bin/playwright` | Default for new non-stealth skills. |

## Quick-start: browser-use + Gemma (local, free)

When the decision lands on browser-use, default to the local Gemma daemon as the LLM. No cloud cost, no API key.

```bash
# Source the canonical endpoint vars (LOCAL_LLM_URL, LOCAL_LLM_BASE_URL, LOCAL_LLM_MODEL, ...).
# This is the shell parallel to local-llm/client.py — never hardcode the host/port.
source /Users/shakstzy/QUANTUM/_core/skills/local-llm/scripts/endpoint.sh

# Confirm Gemma is up (lifecycle managed by launchd `com.quantum.local-llm`)
curl -s "$LOCAL_LLM_BASE_URL/v1/models" | head

# One-shot via CLI, point browser-use at the OpenAI-compatible local endpoint
OPENAI_API_KEY=local OPENAI_BASE_URL="$LOCAL_LLM_BASE_URL/v1" \
  bu --headed -- "<task description>"
```

For Python lib usage, build a `ChatOpenAI`-compatible client whose `base_url` comes from the `local-llm` skill's `client.py` (`from client import URL` then strip the `/v1/chat/completions` suffix, or just import `MODEL` and reuse the same `URL` host) and pass it into `Agent(...)`. See `local-llm` skill for daemon details. Do NOT hardcode the host/port.

## Quick-start: patchright skeleton

```js
// scripts/browser.mjs
import { chromium } from 'patchright';

const ctx = await chromium.launchPersistentContext(
  process.env.HOME + '/.quantum/chrome-profiles/<skill>',
  { channel: 'chrome', headless: false, viewport: null }
);
const page = ctx.pages()[0] ?? await ctx.newPage();
// ... drive the page
```

Mirror the existing helpers in `workspaces/higgsfield/scripts/` (`fingerprint.mjs`, `behavior.mjs`) for human-like timing and fingerprint hardening.

## Audit (run before declaring done)

| Check | Pass condition |
|-------|----------------|
| Right tool for the target | Stealth-sensitive -> patchright. LLM-needed -> browser-use. Else -> playwright. |
| No mixed stacks | One skill uses one stack. No browser-use-over-patchright unless approved. |
| Profile path | Persistent profiles live under `~/.quantum/chrome-profiles/<skill>/`. |
| Secrets | No tokens, cookies, or session blobs committed to the repo. |
| Stealth skills only | If patchright: confirm `channel: 'chrome'` (real Chrome binary, not Chromium) and `launchPersistentContext` (not `launch`). |
| Headless flag | Default headed for stealth (Cloudflare flags pure-headless). Headless OK for plain Playwright on cooperative sites. |
