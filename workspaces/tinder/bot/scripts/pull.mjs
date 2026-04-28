#!/usr/bin/env node
import { launchPersistent } from "../src/runtime/profile.mjs";
import { scrapeMatches, scrapeThread } from "../src/tinder/matches.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { ensureSelectorsHealthy } from "../src/runtime/detection.mjs";
import { logSession } from "../src/runtime/logger.mjs";
import { loadCaps } from "../src/runtime/caps.mjs";

await abortIfHalted();
const caps = await loadCaps();

const { ctx, page } = await launchPersistent({ headless: false });
try {
  await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
  await ensureSelectorsHealthy(page);
  const matches = await scrapeMatches(page);
  console.log(`matches:${matches.length}`);

  const limit = Math.min(matches.length, caps.scrape.thread_opens_per_session_max);
  let opened = 0;
  for (const m of matches.slice(0, limit)) {
    try {
      await scrapeThread(page, m.matchId);
      opened += 1;
    } catch (e) {
      console.error(`thread_failed ${m.matchId}: ${e.message}`);
      if (/HALTED/.test(e.message)) break;
    }
  }
  await logSession({ event: "pull_session", matches: matches.length, threads_opened: opened });
  console.log(`threads_opened:${opened}`);
} finally {
  await ctx.close();
}
