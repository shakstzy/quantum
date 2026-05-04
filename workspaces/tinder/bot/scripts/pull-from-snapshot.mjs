#!/usr/bin/env node
// Pull any tinder_only ids from the snapshot via deep-link nav, using the
// names captured in matches[] (so we don't need a sidebar walk).
//
// Reads ~/.quantum/tinder/match-snapshot.json (written by v5e).
// For each tinder_only id, deep-link nav + scrapeThread with the captured
// name. Halt-safe with caps.json pacing.

import { readFile } from "node:fs/promises";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { scrapeThread } from "../src/tinder/matches.mjs";
import { listAllEntities } from "../src/runtime/entity-store.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { logSession } from "../src/runtime/logger.mjs";
import { loadCaps } from "../src/runtime/caps.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";

const SNAP_PATH = `${process.env.HOME}/.quantum/tinder/match-snapshot.json`;

await abortIfHalted();
const caps = await loadCaps();

const snap = JSON.parse(await readFile(SNAP_PATH, "utf8"));
const matchesById = new Map((snap.matches || []).map(m => [m.id, m]));
console.log(`pull-from-snapshot: snapshot from ${snap.ts}, ${matchesById.size} matches with names`);

// Recompute tinder_only from disk (snapshot may be stale on the disk side)
const entities = await listAllEntities();
const diskIds = new Set(entities.map(e => e.meta?.match_id).filter(Boolean));
const targets = (snap.ids || []).filter(id => !diskIds.has(id));
console.log(`tinder_only against current disk: ${targets.length}`);

if (targets.length === 0) {
  console.log("nothing to pull");
  process.exit(0);
}

const limit = Math.min(targets.length, caps.scrape.thread_opens_per_session_max || 25);
console.log(`pulling ${limit}/${targets.length} (cap=${caps.scrape.thread_opens_per_session_max})`);

const { ctx, page } = await launchPersistent({ headless: false });
try {
  await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
  await sleep(jitter(2400, 4200));

  let opened = 0, succeeded = 0;
  for (const id of targets.slice(0, limit)) {
    opened++;
    const m = matchesById.get(id);
    const name = m?.name || null;
    if (!name) {
      console.warn(`[${opened}/${limit}] ${id}: no name in snapshot — skipping (need v5e to recapture)`);
      continue;
    }
    try {
      const r = await scrapeThread(page, id, { name });
      if (r?.slug) {
        succeeded++;
        console.log(`[${opened}/${limit}] ${name} -> ${r.slug} (${r.messages_new}/${r.messages_total} new)`);
      } else {
        console.log(`[${opened}/${limit}] ${name} -> NO_SLUG (skipped, possibly redirected)`);
      }
    } catch (e) {
      console.error(`[${opened}/${limit}] ${id} ${name}: ${e.message}`);
      if (/HALTED/.test(e.message)) { console.error("HALTED — bailing"); break; }
    }
  }

  await logSession({ event: "pull_from_snapshot", target: targets.length, opened, succeeded });
  console.log(`\ndone: ${succeeded}/${opened} succeeded; ${targets.length - opened} remain`);
} finally {
  await ctx.close();
}
