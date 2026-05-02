#!/usr/bin/env node
// Scrape match list + per-thread snapshot. Skeleton until scrapeThread is wired.
import { launchPersistent } from "../src/runtime/profile.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { scrapeMatches, scrapeThread } from "../src/bumble/matches.mjs";
import { logSession } from "../src/runtime/logger.mjs";
import { loadCaps } from "../src/runtime/caps.mjs";

await abortIfHalted();
const caps = await loadCaps();

const { ctx, page } = await launchPersistent({ headless: false });
try {
  const matches = await scrapeMatches(page);
  console.log(`matches: ${matches.length}`);
  let opened = 0;
  for (const m of matches.slice(0, caps.scrape.thread_opens_per_session_max)) {
    try {
      const r = await scrapeThread(page, m.matchId, { name: m.name });
      console.log(`thread ${m.matchId}: ${JSON.stringify(r)}`);
      opened += 1;
    } catch (e) {
      console.error(`thread ${m.matchId}: ${e.message}`);
      break; // pre-discovery skeleton stops here
    }
  }
  await logSession({ event: "pull", matches: matches.length, opened });
} finally {
  await ctx.close();
}
