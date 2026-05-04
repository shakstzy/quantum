#!/usr/bin/env node
// Quick desktop sidebar walk: confirm that everyone visible in the user's
// Matches tab is already on disk. NO clicks, NO thread opens, just scroll
// the sidebar (paranoid pace) and check ids against raw/tinder/.

import { launchPersistent } from "../src/runtime/profile.mjs";
import { scrapeMatches } from "../src/tinder/matches.mjs";
import { listAllEntities } from "../src/runtime/entity-store.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";

await abortIfHalted();
const { ctx, page } = await launchPersistent({ headless: false });
try {
  await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
  await sleep(jitter(3000, 5000));
  await page.waitForSelector("a[href^='/app/messages/']", { timeout: 15000 }).catch(() => {});

  const matches = await scrapeMatches(page);
  console.log(`scraped ${matches.length} anchors from desktop sidebar`);

  const entities = await listAllEntities();
  const diskIds = new Set(entities.map(e => e.meta?.match_id).filter(Boolean));

  const onDisk = matches.filter(m => diskIds.has(m.matchId));
  const missing = matches.filter(m => !diskIds.has(m.matchId));

  console.log(`\n=== VERIFY ===`);
  console.log(`scraped:    ${matches.length}`);
  console.log(`on disk:    ${onDisk.length}`);
  console.log(`MISSING:    ${missing.length}`);

  if (missing.length > 0) {
    console.log(`\nmissing ids (need pulling):`);
    for (const m of missing) console.log(`  ${m.matchId}  ${m.name || "(no name)"}`);
  } else {
    console.log(`\n✅ everything visible in your Matches tab is already on disk`);
  }
} finally {
  await ctx.close();
}
