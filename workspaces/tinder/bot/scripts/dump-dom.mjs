#!/usr/bin/env node
// One-shot DOM dump for selector-drift recovery. Saves /app/recs, /app/matches,
// and (if a match exists) the first thread to .dev-fixtures/. Local iteration
// thereafter does NOT hit Tinder again.
//
// Per the scraper-cache learning: one live hit per shape, then iterate offline.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { sleep } from "../src/runtime/humanize.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = resolve(__dirname, "../.dev-fixtures");
await mkdir(FIX_DIR, { recursive: true });

const { ctx, page } = await launchPersistent({ headless: false });

try {
  console.log("-> /app/recs");
  await page.goto("https://tinder.com/app/recs", { waitUntil: "domcontentloaded" });
  await sleep(4000);
  const recsHtml = await page.content();
  await writeFile(resolve(FIX_DIR, "recs.html"), recsHtml);
  console.log(`   saved recs.html (${recsHtml.length} chars)`);

  console.log("-> /app/matches");
  await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
  await sleep(3000);
  const matchesHtml = await page.content();
  await writeFile(resolve(FIX_DIR, "matches.html"), matchesHtml);
  console.log(`   saved matches.html (${matchesHtml.length} chars)`);

  const firstMatch = await page.$("a[href^='/app/messages/']");
  if (firstMatch) {
    const href = await firstMatch.getAttribute("href");
    console.log(`-> ${href}`);
    await page.goto(`https://tinder.com${href}`, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    const threadHtml = await page.content();
    await writeFile(resolve(FIX_DIR, "thread.html"), threadHtml);
    console.log(`   saved thread.html (${threadHtml.length} chars)`);
  } else {
    console.log("no match link found, skipping thread dump");
  }
} finally {
  await ctx.close();
}
console.log("done. iterate against .dev-fixtures/ — do not re-hit Tinder.");
