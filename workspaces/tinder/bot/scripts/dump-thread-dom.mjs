#!/usr/bin/env node
// Dev-only: opens a live thread, attempts to expand the profile pane, and dumps
// the full DOM (and a screenshot) to .dev-fixtures/thread-dom/. Offline selector
// discovery happens against this fixture, NOT live. Single live hit per drift.

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { launchPersistent } from "../src/runtime/profile.mjs";

const matchId = process.argv[2];
if (!matchId) {
  console.error("usage: dump-thread-dom.mjs <matchId>");
  process.exit(2);
}

const FIXTURE_DIR = resolve(process.cwd(), "bot/.dev-fixtures/thread-dom");
await mkdir(FIXTURE_DIR, { recursive: true });

const { ctx, page } = await launchPersistent({ headless: false });
try {
  await page.goto(`https://tinder.com/app/messages/${matchId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);

  // Stage 1: dump as-is (profile pane may already be open on desktop layout)
  const html1 = await page.content();
  await writeFile(resolve(FIXTURE_DIR, `${matchId}-stage1-as-is.html`), html1);
  await page.screenshot({ path: resolve(FIXTURE_DIR, `${matchId}-stage1.png`), fullPage: true });

  // Stage 2: try clicking around to find the profile pane / expand
  // Try common openers: name in chat header, profile link, photo
  const triggers = [
    "h1",
    "h2",
    "[role='button'][aria-label*='profile' i]",
    "[role='button'][aria-label*='view' i]",
    "[data-testid='matchProfileButton']",
    "button:has-text('View Profile')",
    "img[alt]",
  ];
  for (const sel of triggers) {
    try {
      const el = await page.$(sel);
      if (el) {
        console.log(`trying trigger: ${sel}`);
        await el.click({ timeout: 1500 });
        await page.waitForTimeout(2000);
        const html2 = await page.content();
        await writeFile(resolve(FIXTURE_DIR, `${matchId}-stage2-${sel.replace(/[^a-z0-9]/gi, "_")}.html`), html2);
        await page.screenshot({ path: resolve(FIXTURE_DIR, `${matchId}-stage2-${sel.replace(/[^a-z0-9]/gi, "_")}.png`), fullPage: true });
        break;
      }
    } catch (e) {
      console.log(`trigger ${sel} failed: ${e.message.slice(0, 80)}`);
    }
  }

  // Stage 3: snapshot of accessibility tree (may reveal headings/landmarks)
  const heading = await page.$$eval("h1, h2, h3", els => els.slice(0, 30).map(e => ({ tag: e.tagName, text: e.textContent?.trim() })));
  await writeFile(resolve(FIXTURE_DIR, `${matchId}-headings.json`), JSON.stringify(heading, null, 2));

  console.log(`dumped to ${FIXTURE_DIR}/${matchId}-*`);
} finally {
  await ctx.close();
}
