#!/usr/bin/env node
// Scrape match list + per-thread snapshot.
import { launchPersistent } from "../src/runtime/profile.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { scrapeMatches, scrapeThread } from "../src/bumble/matches.mjs";
import { logSession } from "../src/runtime/logger.mjs";
import { loadCaps } from "../src/runtime/caps.mjs";

await abortIfHalted();
const caps = await loadCaps();

const { ctx, page } = await launchPersistent({ headless: false });
try {
  // assertDateMode runs INSIDE scrapeMatches after gotoMatches navigates to /app.
  const matches = await scrapeMatches(page);
  console.log(`matches: ${matches.length}`);
  // QUANTUM_BUMBLE_PULL_LIMIT env var caps how many threads to scrape this session.
  const testLimit = parseInt(process.env.QUANTUM_BUMBLE_PULL_LIMIT || "0", 10);
  const cap = testLimit > 0 ? Math.min(testLimit, matches.length) : caps.scrape.thread_opens_per_session_max;
  let opened = 0;
  for (const m of matches.slice(0, cap)) {
    try {
      const r = await scrapeThread(page, m.matchId, { name: m.name });
      console.log(`thread ${m.name} (${m.matchId.slice(0, 12)}...): slug=${r.slug} msgs=${r.messages_total} new=${r.messages_new} expires=${r.expires_at}`);
      opened += 1;
    } catch (e) {
      console.error(`thread ${m.matchId.slice(0, 16)}: ${e.message}`);
    }
  }
  await logSession({ event: "pull", matches: matches.length, opened });
} finally {
  await ctx.close();
}
