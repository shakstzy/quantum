#!/usr/bin/env node
// Interactive selector verification. Launches the chrome profile, walks through
// each critical page, reports which configured selectors resolve, stamps
// last_verified dates on success.

import { readFile, writeFile } from "node:fs/promises";
import { SELECTORS_FILE } from "../src/runtime/paths.mjs";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { sleep } from "../src/runtime/humanize.mjs";

const sels = JSON.parse(await readFile(SELECTORS_FILE, "utf8"));

async function checkOnPage(page, url, keys) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  const results = {};
  for (const key of keys) {
    const sel = sels[key];
    if (!sel) { results[key] = { ok: false, reason: "missing in selectors.json" }; continue; }
    if (!sel.selector && (!sel.alt || sel.alt.length === 0)) {
      results[key] = { ok: false, reason: "not yet discovered" };
      continue;
    }
    const candidates = [sel.selector, ...(sel.alt || [])].filter(Boolean);
    let hit = null;
    for (const s of candidates) {
      try {
        const el = await page.$(s);
        if (el) { hit = s; break; }
      } catch { /* skip */ }
    }
    results[key] = hit ? { ok: true, sel: hit } : { ok: false, reason: "no candidate matched" };
  }
  return results;
}

const { ctx, page } = await launchPersistent({ headless: false });
const today = new Date().toISOString().slice(0, 10);

try {
  const encResults = await checkOnPage(page, "https://bumble.com/app", [
    "rec_card", "rec_card_name", "like_button", "pass_button", "mode_picker",
    "matches_tab", "turnstile_iframe", "photo_verify_modal", "login_wall",
  ]);
  // Matches/threads tab needs a real conversation route to test - skip if not yet wired
  for (const [key, r] of Object.entries(encResults)) {
    if (r.ok) { sels[key].last_verified = today; console.log(`OK   ${key.padEnd(28)} ${r.sel}`); }
    else      { console.log(`FAIL ${key.padEnd(28)} ${r.reason}`); }
  }
  await writeFile(SELECTORS_FILE, JSON.stringify(sels, null, 2));
  console.log(`\nselectors.json updated with last_verified=${today} for passing entries.`);
} finally {
  await ctx.close();
}
