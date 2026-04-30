#!/usr/bin/env node
import { launchPersistent } from "../src/runtime/profile.mjs";
import { scrapeMatches, scrapeThread } from "../src/tinder/matches.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { logSession } from "../src/runtime/logger.mjs";
import { loadCaps } from "../src/runtime/caps.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";

await abortIfHalted();
const caps = await loadCaps();

const { ctx, page } = await launchPersistent({ headless: false });
try {
  await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
  await sleep(jitter(2400, 4200));
  try { await page.waitForSelector("a[href^='/app/messages/']", { timeout: 15000 }); }
  catch { console.error("matches list never rendered; halting"); process.exit(1); }
  const matches = await scrapeMatches(page);
  console.log(`matches:${matches.length}`);

  const envLimit = parseInt(process.env.QUANTUM_TINDER_PULL_LIMIT || "0", 10);
  const limit = envLimit > 0
    ? Math.min(matches.length, envLimit)
    : Math.min(matches.length, caps.scrape.thread_opens_per_session_max);
  if (envLimit > 0) console.log(`TEST MODE: pull capped at ${envLimit} threads`);
  let opened = 0;
  for (const m of matches.slice(0, limit)) {
    try {
      const r = await scrapeThread(page, m.matchId, { name: m.name });
      opened += 1;
      const diffStr = r.profile_diff ? ` diff(+${Object.keys(r.profile_diff.added||{}).length}/~${Object.keys(r.profile_diff.changed||{}).length}/-${Object.keys(r.profile_diff.removed||{}).length})` : "";
      console.log(`thread ${m.name || "?"} -> ${r.slug || "?"} (${r.messages_new}/${r.messages_total} new)${diffStr}`);
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
