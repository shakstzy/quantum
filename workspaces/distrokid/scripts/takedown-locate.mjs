#!/usr/bin/env node
// Step 1 of the takedown flow: open /mymusic, find the Superdrugs release row,
// extract its detail-page URL/albumuuid, and take a screenshot. Closes after.
// HITL: Adithya confirms the located release before I proceed to open it.

import { chromium } from "patchright";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TARGET = (process.argv[2] || "superdrugs").toLowerCase();

const PROFILE_DIR = join(homedir(), ".quantum/chrome-profiles/distrokid");
const RUN_DIR = join(homedir(), ".quantum/distrokid/takedown", new Date().toISOString().replace(/[:.]/g, "-") + "-locate");
await mkdir(RUN_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false, channel: "chrome",
  viewport: { width: 1440, height: 900 },
  args: ["--disable-blink-features=AutomationControlled", "--window-size=1440,900"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto("https://distrokid.com/mymusic", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.bringToFront();
await page.waitForTimeout(3500);

// Find the row whose visible title matches TARGET.
const hits = await page.evaluate((target) => {
  const out = [];
  // Each release row has a link or clickable element with the title text.
  // Walk all anchor + clickable rows, capture (text, href, albumuuid query, parent text).
  const candidates = document.querySelectorAll("a, [class*='release' i], [class*='album' i], tr, li");
  for (const el of candidates) {
    const t = (el.textContent || "").toLowerCase();
    if (!t.includes(target)) continue;
    const a = el.tagName === "A" ? el : el.querySelector("a[href]");
    if (a) {
      const href = a.getAttribute("href") || "";
      const r = a.getBoundingClientRect();
      out.push({
        text: (a.textContent || el.textContent || "").trim().slice(0, 120),
        href,
        absUrl: new URL(href, location.href).toString(),
        visible: r.width > 0 && r.height > 0,
      });
    }
  }
  // dedupe by absUrl
  const seen = new Set();
  return out.filter((h) => h.visible && !seen.has(h.absUrl) && (seen.add(h.absUrl), true));
}, TARGET);

console.log(`[target] "${TARGET}"`);
console.log(`[hits] ${hits.length}`);
hits.slice(0, 10).forEach((h, i) => {
  console.log(`  ${i}: text="${h.text.slice(0, 60)}" href="${h.href}"`);
});

await page.screenshot({ path: join(RUN_DIR, "mymusic.png"), fullPage: true });
console.log(`[snap] mymusic.png`);

await writeFile(join(RUN_DIR, "hits.json"), JSON.stringify({ target: TARGET, hits, runDir: RUN_DIR, at: new Date().toISOString() }, null, 2));
console.log(`[done] ${RUN_DIR}`);

await ctx.close();
