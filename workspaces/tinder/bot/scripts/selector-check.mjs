#!/usr/bin/env node
// Interactive selector verification. Launches the chrome profile, walks through
// each critical page, and reports which selectors resolve. Updates last_verified
// dates in selectors.json on success.

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
    const candidates = [sel.selector, ...(sel.alt || [])];
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
  const recsResults = await checkOnPage(page, "https://tinder.com/app/recs",
    ["rec_card", "rec_card_name", "rec_card_age", "rec_card_distance", "rec_card_bio", "like_button", "nope_button", "matches_tab"]);
  const matchesResults = await checkOnPage(page, "https://tinder.com/app/matches",
    ["matches_list_item"]);
  let threadResults = {};
  const firstMatch = await page.$("a[href^='/app/messages/']");
  if (firstMatch) {
    const href = await firstMatch.getAttribute("href");
    threadResults = await checkOnPage(page, `https://tinder.com${href}`,
      ["thread_messages", "thread_input", "thread_send"]);
  }
  const all = { ...recsResults, ...matchesResults, ...threadResults };

  for (const [key, r] of Object.entries(all)) {
    if (r.ok) {
      sels[key].last_verified = today;
      console.log(`OK   ${key.padEnd(24)} ${r.sel}`);
    } else {
      console.log(`FAIL ${key.padEnd(24)} ${r.reason}`);
    }
  }
  await writeFile(SELECTORS_FILE, JSON.stringify(sels, null, 2));
  console.log(`\nselectors.json updated with last_verified=${today} for passing selectors.`);
} finally {
  await ctx.close();
}
