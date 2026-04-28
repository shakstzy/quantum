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
5. **Audit.** Run the Audit table below before declaring done.

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
# Confirm Gemma is up (lifecycle managed by launchd `com.shakos.local-llm`)
curl -s http://127.0.0.1:8765/v1/models | head

# One-shot via CLI, point browser-use at the OpenAI-compatible local endpoint
OPENAI_API_KEY=local OPENAI_BASE_URL=http://127.0.0.1:8765/v1 \
  bu --headed -- "<task description>"
```

For Python lib usage, build a `ChatOpenAI`-compatible client with `base_url=http://127.0.0.1:8765/v1` and pass it into `Agent(...)`. See `local-llm` skill for daemon details.

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
