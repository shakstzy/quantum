// Gemma-as-a-tool helpers for patchright / playwright Node skills.
// Pattern: deterministic code drives the browser; call Gemma only at fuzzy decision points.
// Daemon contract: see _core/skills/local-llm/references/api.md

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const ENDPOINT = process.env.GEMMA_ENDPOINT || 'http://127.0.0.1:8765/v1/chat/completions';
const MODEL = process.env.GEMMA_MODEL || 'unsloth/gemma-4-26b-a4b-it-UD-MLX-4bit';
const CACHE_PATH = `${process.env.HOME}/.quantum/gemma-cache/browser-selectors.json`;
const DEFAULT_TIMEOUT_MS = 30_000;

async function gemmaCall(messages, { maxTokens = 512, temperature = 0.2, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature, stream: false }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`gemma ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(t);
  }
}

function parseJsonLoose(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function askGemma(prompt, opts = {}) {
  return gemmaCall([{ role: 'user', content: prompt }], opts);
}

export async function seeWithGemma(page, prompt, { fullPage = false, ...opts } = {}) {
  const buf = await page.screenshot({ fullPage, type: 'jpeg', quality: 70 });
  return gemmaCall([{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
    ],
  }], opts);
}

async function readCache() {
  try { return JSON.parse(await readFile(CACHE_PATH, 'utf8')); } catch { return {}; }
}

async function writeCache(obj) {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(obj, null, 2));
}

function cacheKey(url, role, description) {
  const u = new URL(url);
  const pathTemplate = u.pathname.replace(/\d+/g, ':n');
  return `${u.origin}${pathTemplate}::${role || '*'}::${description}`;
}

// findByDescription: locate an interactive element by natural-language description.
// First run hits Gemma; subsequent runs use the cached selector until it stops resolving.
// Returns a Playwright Locator (or null if nothing matched).
export async function findByDescription(page, description, { role = null, cache = true } = {}) {
  const key = cacheKey(page.url(), role, description);
  const cacheObj = cache ? await readCache() : {};

  if (cache && cacheObj[key]) {
    const loc = page.locator(cacheObj[key]).first();
    if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) return loc;
    delete cacheObj[key]; // stale, fall through
  }

  const candidates = await page.evaluate((wantedRole) => {
    const baseSel = 'button, a, input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="textbox"]';
    const els = Array.from(document.querySelectorAll(wantedRole ? `[role="${wantedRole}"], ${wantedRole === 'button' ? 'button' : wantedRole === 'link' ? 'a' : '*'}` : baseSel));
    return els
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .slice(0, 60)
      .map((e, i) => ({
        i,
        tag: e.tagName.toLowerCase(),
        role: e.getAttribute('role') || (e.tagName === 'BUTTON' ? 'button' : e.tagName === 'A' ? 'link' : e.tagName.toLowerCase()),
        text: (e.innerText || e.value || '').trim().slice(0, 80),
        aria: (e.getAttribute('aria-label') || '').trim().slice(0, 80),
        placeholder: (e.getAttribute('placeholder') || '').trim().slice(0, 60),
      }))
      .filter(c => c.text || c.aria || c.placeholder);
  }, role);

  if (candidates.length === 0) return null;

  const prompt = [
    `Pick the element best matching this description: "${description}".`,
    `Reply ONLY with JSON: {"i": <integer index from candidates>} or {"i": null} if none match.`,
    ``,
    `Candidates:`,
    JSON.stringify(candidates, null, 2),
  ].join('\n');

  const raw = await gemmaCall([{ role: 'user', content: prompt }], { maxTokens: 64, temperature: 0 });
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed.i !== 'number') return null;
  const chosen = candidates[parsed.i];
  if (!chosen) return null;

  let selector;
  if (chosen.aria) {
    selector = `${chosen.tag}[aria-label="${chosen.aria.replace(/"/g, '\\"')}"]`;
  } else if (chosen.text) {
    selector = `${chosen.tag}:has-text("${chosen.text.replace(/"/g, '\\"')}")`;
  } else if (chosen.placeholder) {
    selector = `${chosen.tag}[placeholder="${chosen.placeholder.replace(/"/g, '\\"')}"]`;
  } else {
    return null;
  }

  if (cache) {
    cacheObj[key] = selector;
    await writeCache(cacheObj);
  }
  return page.locator(selector).first();
}

// judgeState: ask Gemma a multiple-choice question about the current page.
// Returns { answer, reason } where answer is one of `options`. Returns null on parse failure.
export async function judgeState(page, question, options) {
  const prompt = [
    `Look at this page. ${question}`,
    `Reply ONLY with JSON: {"answer": "<one of: ${options.join(', ')}>", "reason": "<short reason>"}.`,
  ].join('\n');
  const raw = await seeWithGemma(page, prompt, { maxTokens: 128, temperature: 0 });
  const parsed = parseJsonLoose(raw);
  if (!parsed || !options.includes(parsed.answer)) return null;
  return parsed;
}

// extractStructured: pull structured data from the current page text.
// `schemaHint` is a plain-language description of the JSON shape you want.
export async function extractStructured(page, schemaHint, { selector = 'body', maxChars = 8000 } = {}) {
  const text = await page.locator(selector).first().innerText().catch(() => '');
  const slice = text.slice(0, maxChars);
  const prompt = [
    `Extract ${schemaHint} from the text below.`,
    `Reply ONLY with the JSON object. No prose, no fences.`,
    ``,
    `Text:`,
    slice,
  ].join('\n');
  const raw = await gemmaCall([{ role: 'user', content: prompt }], { maxTokens: 1024, temperature: 0 });
  return parseJsonLoose(raw);
}

// Cache utilities (mostly for tests / manual cache busting).
export async function clearSelectorCache() { await writeCache({}); }
export async function dumpSelectorCache() { return readCache(); }
