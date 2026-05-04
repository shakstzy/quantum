#!/usr/bin/env node
// Probe a random sample of the 105 disk_only match_ids from the v5c
// enumeration to see how many are still alive (URL nav resolves to thread)
// vs expired (redirect to /app/matches).
//
// Same paranoid pacing as probe-stale-matches.mjs:
//   - Direct URL nav to /app/messages/<id>, no clicks
//   - 30-45s gap between probes
//   - Halt-safe before/after each
//   - Hard breaker on 401/403/429
//
// Reads enumerated ids from ~/.quantum/tinder/match-snapshot.json

import { readFile } from "node:fs/promises";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { listAllEntities } from "../src/runtime/entity-store.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";
import { scanForHalts } from "../src/runtime/detection.mjs";

const SNAP_PATH = `${process.env.HOME}/.quantum/tinder/match-snapshot.json`;
const SAMPLE_SIZE = 10;
const GAP_MIN_MS = 30000;
const GAP_MAX_MS = 45000;
const NAV_DWELL_MIN_MS = 4000;
const NAV_DWELL_MAX_MS = 6500;
const INITIAL_DWELL_MIN_MS = 3500;
const INITIAL_DWELL_MAX_MS = 6000;

async function probe(page, ent) {
  const target = `https://tinder.com/app/messages/${ent.match_id}`;
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await sleep(jitter(NAV_DWELL_MIN_MS, NAV_DWELL_MAX_MS));
  const settledUrl = page.url();
  let lastSegment = "";
  try {
    lastSegment = new URL(settledUrl).pathname.split("/").filter(Boolean).pop() || "";
  } catch { lastSegment = ""; }
  const alive = lastSegment === ent.match_id;
  return { alive, settledUrl, lastSegment };
}

async function main() {
  await abortIfHalted();
  console.log("DISK-ONLY PROBE: are the 105 enumerator-missing matches still alive?");
  console.log(`- sampling ${SAMPLE_SIZE} random from disk_only\n`);

  // Load enumeration snapshot
  const snap = JSON.parse(await readFile(SNAP_PATH, "utf8"));
  const enumeratedIds = new Set(snap.ids || []);
  console.log(`enumeration snapshot: ${enumeratedIds.size} ids from ${snap.ts}`);

  // Load disk entities
  const entities = await listAllEntities();
  const diskOnly = [];
  for (const ent of entities) {
    const id = ent.meta?.match_id;
    if (id && !enumeratedIds.has(id)) {
      diskOnly.push({
        slug: ent.slug,
        match_id: id,
        first_name: ent.meta?.first_name || null,
        status: ent.meta?.status || null,
        last_scrape: ent.meta?.last_scrape || null,
      });
    }
  }
  console.log(`disk_only (in raw/tinder/ but missing from v5c enum): ${diskOnly.length}`);

  if (diskOnly.length === 0) {
    console.log("nothing to probe");
    return;
  }

  // Random sample (Fisher-Yates partial shuffle)
  const shuffled = [...diskOnly];
  for (let i = shuffled.length - 1; i > shuffled.length - 1 - Math.min(SAMPLE_SIZE, shuffled.length); i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const sample = shuffled.slice(-Math.min(SAMPLE_SIZE, shuffled.length));

  console.log(`\nsampling these ${sample.length}:`);
  for (const e of sample) {
    console.log(`  ${e.slug.padEnd(36)} status=${e.status} last_scrape=${e.last_scrape}`);
  }

  const { ctx, page } = await launchPersistent({ headless: false });
  try {
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    await sleep(jitter(INITIAL_DWELL_MIN_MS, INITIAL_DWELL_MAX_MS));
    await scanForHalts(page);

    const results = [];
    for (let i = 0; i < sample.length; i++) {
      const ent = sample[i];
      console.log(`\nprobe ${i + 1}/${sample.length}: ${ent.slug}`);
      await scanForHalts(page);
      const r = await probe(page, ent);
      results.push({ ...ent, ...r });
      console.log(`  → ${r.alive ? "ALIVE" : "REDIRECTED"} (settled: ${r.settledUrl})`);
      if (i < sample.length - 1) {
        const gap = jitter(GAP_MIN_MS, GAP_MAX_MS);
        console.log(`  sleeping ${(gap / 1000).toFixed(0)}s before next probe...`);
        await sleep(gap);
      }
    }

    const alive = results.filter(r => r.alive);
    const redirected = results.filter(r => !r.alive);
    console.log("\n=== RESULTS ===");
    console.log(`total disk_only:                     ${diskOnly.length}`);
    console.log(`sampled:                             ${results.length}`);
    console.log(`alive (still messageable):           ${alive.length}/${results.length}`);
    console.log(`redirected (truly expired/unmatched): ${redirected.length}/${results.length}`);
    console.log(`\nextrapolated alive count: ~${Math.round(diskOnly.length * (alive.length / results.length))} of ${diskOnly.length}`);
    for (const r of results) {
      console.log(`  ${r.alive ? "✅" : "❌"} ${r.slug.padEnd(36)} status=${r.status} → ${r.settledUrl}`);
    }
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(`probe FAILED: ${e.stack || e.message}`); process.exit(1); });
