#!/usr/bin/env node
// Self-heal entry point. Run when something breaks (selector miss, unexpected
// halt, login wall, discovery drift). Opens the persistent profile and dumps:
//   - URL of every surface we navigate to
//   - innerText sample
//   - Selector survey for every key we have configured (which ones still resolve)
//   - Screenshots
// Output: .dev-fixtures/<ts>/diag-*.json + .png
//
// Per learnings/2026-04-30-live-test-and-fix-browser-skills.md: when a browser
// skill breaks, run diag, read output, patch selectors, re-test. Don't ask the
// operator to debug.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { sleep, idlePause } from "../src/runtime/humanize.mjs";
import { DEV_FIXTURES_DIR, SELECTORS_FILE } from "../src/runtime/paths.mjs";

const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = resolve(DEV_FIXTURES_DIR, `diag-${TS}`);
await mkdir(OUT_DIR, { recursive: true });

const sels = JSON.parse(await readFile(SELECTORS_FILE, "utf8"));

const SURFACES = [
  { label: "encounters", url: "https://bumble.com/app/encounters", relevant_keys: ["rec_card", "rec_card_name", "like_button", "pass_button", "mode_picker", "turnstile_iframe", "photo_verify_modal", "login_wall"] },
  { label: "matches",   url: "https://bumble.com/app/matches",   relevant_keys: ["matches_tab", "matches_list_item", "match_expiry_indicator", "extend_match_button"] },
  // Thread URL is per-match; diag does NOT open a real thread (would need a real
  // match id and is invasive). Operator can run discover-dom.mjs against a real
  // thread when needed.
];

const { ctx, page } = await launchPersistent({ headless: false });
const result = {};
try {
  for (const surface of SURFACES) {
    try {
      await page.goto(surface.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await idlePause({ min: 2000, max: 4000 });
    } catch (e) {
      result[surface.label] = { url: surface.url, error: e.message };
      continue;
    }
    const url_after = page.url();
    const text = (await page.evaluate(() => document.body?.innerText || "")).slice(0, 4000);
    const screenshot = resolve(OUT_DIR, `${surface.label}.png`);
    try { await page.screenshot({ path: screenshot, fullPage: false }); } catch {}

    // Test each configured selector on this surface.
    const tested = {};
    for (const key of surface.relevant_keys) {
      const sel = sels[key];
      if (!sel?.selector && (!sel?.alt || sel.alt.length === 0)) {
        tested[key] = { configured: false };
        continue;
      }
      const candidates = [sel.selector, ...(sel.alt || [])].filter(Boolean);
      let firstHit = null;
      let counts = {};
      for (const q of candidates) {
        try {
          const n = await page.$$eval(q, els => els.length);
          counts[q] = n;
          if (n > 0 && firstHit == null) firstHit = q;
        } catch (e) { counts[q] = `ERR:${e.message.slice(0, 40)}`; }
      }
      tested[key] = { configured: true, firstHit, counts, last_verified: sel.last_verified };
    }
    result[surface.label] = { url: surface.url, url_after, title: await page.title(), text_first_4kb: text, screenshot, tested };
  }
} finally {
  await ctx.close();
}

const summaryPath = resolve(OUT_DIR, "diag.json");
await writeFile(summaryPath, JSON.stringify(result, null, 2));
console.log(`diag complete. summary: ${summaryPath}`);
for (const [label, r] of Object.entries(result)) {
  if (r.error) { console.log(`${label}: ERROR ${r.error}`); continue; }
  const broken = Object.entries(r.tested).filter(([k, v]) => v.configured && !v.firstHit);
  const ok = Object.entries(r.tested).filter(([k, v]) => v.configured && v.firstHit);
  console.log(`${label}: ${ok.length} ok / ${broken.length} broken / ${Object.entries(r.tested).filter(([k,v]) => !v.configured).length} unconfigured`);
  for (const [k] of broken) console.log(`  BROKEN: ${k}`);
}
