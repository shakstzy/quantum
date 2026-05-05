#!/usr/bin/env node
// Diagnose: re-fill the form, click Continue, then DUMP everything visible
// (errors, modals, buttons, URL) before closing. Lets us learn what blocks the submit.

import { chromium } from "patchright";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".quantum/chrome-profiles/distrokid");
const OUT = join(homedir(), ".quantum/distrokid/diag");
await mkdir(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  channel: "chrome",
  viewport: { width: 1440, height: 900 },
  args: ["--disable-blink-features=AutomationControlled", "--window-size=1440,900"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto("https://distrokid.com/mymusic", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.bringToFront();
await page.waitForTimeout(3000);

console.log("[mymusic] url:", page.url());
const releases = await page.evaluate(() => {
  // try to extract release titles from the page
  const out = [];
  document.querySelectorAll("a, h1, h2, h3, h4, .album-title, .release-title, [class*=title i]").forEach((el) => {
    const t = (el.textContent || "").trim();
    if (t && t.length > 1 && t.length < 80 && !t.includes("\n") && !/^[\s\d\$]+$/.test(t)) {
      out.push(t);
    }
  });
  return [...new Set(out)].slice(0, 60);
});
console.log("[mymusic-text]");
releases.forEach((r) => console.log("  -", r));

await page.screenshot({ path: join(OUT, "mymusic.png"), fullPage: true });
console.log("[snap] mymusic.png");

await page.waitForTimeout(2000);
await ctx.close();
