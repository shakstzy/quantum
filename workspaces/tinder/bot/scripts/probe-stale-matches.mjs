#!/usr/bin/env node
// Spot-check whether match_ids on disk that DIDN'T appear in the recent
// live sidebar scrape are actually alive (just paginated out of view) or
// expired/unmatched.
//
// Picks the 5 oldest-last_scrape entities from raw/tinder/, direct-navigates
// to /app/messages/<id> for each, checks whether the URL settles on that
// match_id (alive) or redirects (expired/unmatched).
//
// Read-only, paranoid, no clicks, no scrolling, no api.gotinder.com.
// 30-45s gap between probes; scanForHalts before/after each.

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";
import { scanForHalts } from "../src/runtime/detection.mjs";

const RAW_DIR = "/Users/shakstzy/QUANTUM/raw/tinder";
const SAMPLE_SIZE = 5;
const GAP_MIN_MS = 30000;
const GAP_MAX_MS = 45000;
const NAV_DWELL_MIN_MS = 4000;
const NAV_DWELL_MAX_MS = 6500;
const INITIAL_DWELL_MIN_MS = 3500;
const INITIAL_DWELL_MAX_MS = 6000;

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === "null" || v === "") v = null;
    if (v && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

async function loadAllEntities() {
  const files = (await readdir(RAW_DIR)).filter(f => f.endsWith(".md"));
  const out = [];
  for (const f of files) {
    const text = await readFile(resolve(RAW_DIR, f), "utf8");
    const meta = parseFrontmatter(text);
    if (!meta.match_id) continue;
    out.push({
      slug: f.replace(/\.md$/, ""),
      match_id: meta.match_id,
      first_name: meta.first_name || null,
      last_scrape: meta.last_scrape || null,
      status: meta.status || null,
    });
  }
  return out;
}

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
  console.log("PARANOID SPOT-CHECK: are stale-disk matches actually alive?");
  console.log(`- sampling ${SAMPLE_SIZE} oldest-last_scrape entities`);
  console.log(`- per-probe dwell ${NAV_DWELL_MIN_MS}-${NAV_DWELL_MAX_MS}ms`);
  console.log(`- gap between probes ${GAP_MIN_MS}-${GAP_MAX_MS}ms\n`);

  const entities = await loadAllEntities();
  // Sort oldest first; null last_scrape goes to top (truly stale)
  entities.sort((a, b) => {
    const ta = a.last_scrape ? Date.parse(a.last_scrape) : 0;
    const tb = b.last_scrape ? Date.parse(b.last_scrape) : 0;
    return ta - tb;
  });

  // Pick 5 from the oldest tier, stride-sample so we're not all clustered
  const stride = Math.max(1, Math.floor(entities.length / (SAMPLE_SIZE * 4)));
  const sample = [];
  for (let i = 0; i < SAMPLE_SIZE && sample.length < SAMPLE_SIZE; i++) {
    const idx = i * stride;
    if (idx >= entities.length) break;
    sample.push(entities[idx]);
  }

  console.log("sampling these 5:");
  for (const e of sample) {
    console.log(`  ${e.slug.padEnd(30)} match_id=${e.match_id}  last_scrape=${e.last_scrape}  status=${e.status}`);
  }
  console.log();

  const { ctx, page } = await launchPersistent({ headless: false });
  try {
    // Land on /app first to initialize session, then idle briefly.
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    await sleep(jitter(INITIAL_DWELL_MIN_MS, INITIAL_DWELL_MAX_MS));
    await scanForHalts(page);

    const results = [];
    for (let i = 0; i < sample.length; i++) {
      const ent = sample[i];
      console.log(`probe ${i + 1}/${sample.length}: ${ent.slug}`);
      await scanForHalts(page);
      const r = await probe(page, ent);
      results.push({ ...ent, ...r });
      console.log(`  → ${r.alive ? "ALIVE" : "REDIRECTED"} (settled: ${r.settledUrl})`);
      if (i < sample.length - 1) {
        const gap = jitter(GAP_MIN_MS, GAP_MAX_MS);
        console.log(`  sleeping ${gap}ms before next probe...`);
        await sleep(gap);
      }
    }

    const alive = results.filter(r => r.alive);
    const redirected = results.filter(r => !r.alive);
    console.log("\n=== RESULTS ===");
    console.log(`alive: ${alive.length}/${results.length}`);
    console.log(`redirected (expired/unmatched): ${redirected.length}/${results.length}`);
    for (const r of results) {
      console.log(`  ${r.alive ? "✅" : "❌"} ${r.slug.padEnd(30)} settled=${r.settledUrl}`);
    }
    console.log("\n" + JSON.stringify({
      total: results.length,
      alive: alive.length,
      redirected: redirected.length,
    }));
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(`probe FAILED: ${e.stack || e.message}`); process.exit(1); });
