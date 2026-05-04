#!/usr/bin/env node
// Targeted pull of the 21 `tinder_only` match_ids identified by v5c match-delta.
// Reads ids from ~/.quantum/tinder/match-snapshot.json, scrapes the live sidebar
// to get name->matchId mapping, filters to just the tinder_only set, and runs
// scrapeThread for each one with proper pacing.
//
// Halt-safe. Halts on detection ladder. Caps respected via caps.json.

import { readFile } from "node:fs/promises";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { scrapeMatches, scrapeThread } from "../src/tinder/matches.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { logSession } from "../src/runtime/logger.mjs";
import { loadCaps } from "../src/runtime/caps.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";

const SNAP_PATH = `${process.env.HOME}/.quantum/tinder/match-snapshot.json`;

await abortIfHalted();
const caps = await loadCaps();

const snap = JSON.parse(await readFile(SNAP_PATH, "utf8"));
const targetIds = new Set(snap.tinderOnlyIds || []);
console.log(`pull-tinder-only: ${targetIds.size} target match_ids from snapshot ${snap.ts}`);
if (targetIds.size === 0) { console.log("nothing to pull"); process.exit(0); }

const { ctx, page } = await launchPersistent({ headless: false });
try {
  await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
  await sleep(jitter(2400, 4200));
  try { await page.waitForSelector("a[href^='/app/messages/']", { timeout: 15000 }); }
  catch { console.error("matches list never rendered; halting"); process.exit(1); }

  const allMatches = await scrapeMatches(page);
  console.log(`scraped ${allMatches.length} matches from sidebar`);

  // Filter to just the 21 we want
  const filtered = allMatches.filter(m => targetIds.has(m.matchId));
  console.log(`overlap with target set: ${filtered.length}/${targetIds.size}`);
  for (const m of filtered) console.log(`  ${m.matchId}  ${m.name}`);

  const missing = [...targetIds].filter(id => !filtered.find(m => m.matchId === id));
  if (missing.length > 0) {
    console.log(`\n${missing.length} target ids NOT in the sidebar scrape (may be in messages-tab beyond the visible window):`);
    for (const id of missing) console.log(`  ${id}  (will need messages-tab scroll or v5d to capture)`);
  }

  // Cap to per_session limit
  const limit = Math.min(filtered.length, caps.scrape.thread_opens_per_session_max || 25);
  console.log(`\nopening ${limit} threads (cap=${caps.scrape.thread_opens_per_session_max})`);

  let opened = 0, succeeded = 0;
  for (const m of filtered.slice(0, limit)) {
    opened++;
    try {
      const r = await scrapeThread(page, m.matchId, { name: m.name });
      if (r?.slug) {
        succeeded++;
        const diffStr = r.profile_diff
          ? ` diff(+${Object.keys(r.profile_diff.added||{}).length}/~${Object.keys(r.profile_diff.changed||{}).length}/-${Object.keys(r.profile_diff.removed||{}).length})`
          : "";
        console.log(`[${opened}/${limit}] ${m.name || "?"} -> ${r.slug} (${r.messages_new}/${r.messages_total} new)${diffStr}`);
      } else {
        console.log(`[${opened}/${limit}] ${m.name || "?"} -> NO_SLUG (skipped)`);
      }
    } catch (e) {
      console.error(`[${opened}/${limit}] thread_failed ${m.matchId}: ${e.message}`);
      if (/HALTED/.test(e.message)) { console.error("HALTED — bailing"); break; }
    }
  }

  await logSession({ event: "pull_tinder_only", target: targetIds.size, opened, succeeded });
  console.log(`\ndone: ${succeeded}/${opened} succeeded; ${targetIds.size - opened} remain (need v5d for matches-tab unmessaged)`);
} finally {
  await ctx.close();
}
