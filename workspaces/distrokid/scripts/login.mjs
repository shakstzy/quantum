#!/usr/bin/env node
// Open patchright Chrome to distrokid.com for one-time manual login.
// Profile persists at ~/.quantum/chrome-profiles/distrokid/. Close the window when done.

import { chromium } from "patchright";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".quantum/chrome-profiles/distrokid");
await mkdir(PROFILE_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  channel: "chrome",
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  timezoneId: "America/Chicago",
  args: [
    "--disable-blink-features=AutomationControlled",
    "--window-size=1440,900",
  ],
});
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto("https://distrokid.com/signin/", { waitUntil: "domcontentloaded" });
await page.bringToFront();

// Force-raise the patchright window over Adithya's other Chrome instances.
await page.evaluate(() => { try { window.focus(); } catch {} });

console.log("Chrome window: https://distrokid.com/signin/ — log in manually.");
console.log("If you don't see it, check Mission Control (F3) — it's a separate Chrome window.");
console.log("Close the browser when finished.");
console.log(`Profile dir: ${PROFILE_DIR}`);

await new Promise((resolve) => ctx.on("close", resolve));
console.log("session saved.");
