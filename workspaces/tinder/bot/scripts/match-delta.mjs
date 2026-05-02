#!/usr/bin/env node
// One-shot delta check: tinder.com matches sidebar vs raw/tinder/*.md
//
// PARANOID MODE — account is already at risk. Hard rules:
// - NEVER call api.gotinder.com (web UI only, patchright)
// - NEVER click into a thread, NEVER type, NEVER take any action
// - Half-viewport scrolls with 5-8s jitter between (slower than human)
// - Wait for DOM stability (4 consecutive zero-new scrolls) before stopping
// - Max 80 scroll attempts as a hard cap
// - Honor halt.mjs at startup
// - Read-only enumeration of <a href='/app/messages/<id>'> in the sidebar
//
// Outputs a delta summary: how many matches exist tinder-side that we don't
// have on disk, plus a sample of those match_ids.

import { launchPersistent } from "../src/runtime/profile.mjs";
import { listAllEntities } from "../src/runtime/entity-store.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";

const SCROLL_RATIO = 0.5;          // half-viewport per scroll (extra slow)
const WAIT_MIN_MS = 5000;
const WAIT_MAX_MS = 8000;
const STABLE_NEEDED = 4;            // 4 consecutive zero-new before stop
const MAX_SCROLLS = 80;             // safety cap (~2400 matches at 30/scroll)
const INITIAL_DWELL_MIN_MS = 3500;
const INITIAL_DWELL_MAX_MS = 6500;

async function captureSidebarMatchIds(page) {
  return await page.evaluate(() => {
    const out = new Set();
    for (const a of document.querySelectorAll("a[href*='/app/messages/']")) {
      const id = a.href.split("/").pop();
      if (id && id.length >= 40) out.add(id); // tinder match_ids are 48 hex chars
    }
    return [...out];
  });
}

async function scrollSidebar(page, ratio) {
  return await page.evaluate((r) => {
    const links = document.querySelectorAll("a[href*='/app/messages/']");
    if (!links.length) return false;
    let el = links[0];
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if ((style.overflowY === "auto" || style.overflowY === "scroll")
          && el.scrollHeight > el.clientHeight + 10) {
        const before = el.scrollTop;
        el.scrollBy(0, Math.floor(el.clientHeight * r));
        return el.scrollTop !== before;
      }
      el = el.parentElement;
    }
    return false;
  }, ratio);
}

async function main() {
  await abortIfHalted();

  console.log("PARANOID MODE: one-shot match-list delta check");
  console.log("- web UI only, no api.gotinder.com");
  console.log("- read-only sidebar scrape, no clicks, no thread opens");
  console.log(`- scroll: ${SCROLL_RATIO} viewport, wait ${WAIT_MIN_MS}-${WAIT_MAX_MS}ms`);
  console.log(`- stop after ${STABLE_NEEDED} consecutive empty scrolls (max ${MAX_SCROLLS})\n`);

  const { ctx, page } = await launchPersistent({ headless: false });

  try {
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    await sleep(jitter(INITIAL_DWELL_MIN_MS, INITIAL_DWELL_MAX_MS));

    const all = new Set();
    {
      const initial = await captureSidebarMatchIds(page);
      for (const id of initial) all.add(id);
      console.log(`initial snapshot: ${all.size} match_ids visible`);
    }

    let stable = 0;
    let scrolls = 0;
    while (stable < STABLE_NEEDED && scrolls < MAX_SCROLLS) {
      const moved = await scrollSidebar(page, SCROLL_RATIO);
      scrolls++;
      if (!moved) {
        // Hit bottom of scroll container
        stable++;
        console.log(`scroll ${scrolls}: scroll did not move (bottom?) — stable ${stable}/${STABLE_NEEDED}`);
        await sleep(jitter(WAIT_MIN_MS, WAIT_MAX_MS));
        continue;
      }
      await sleep(jitter(WAIT_MIN_MS, WAIT_MAX_MS));
      const before = all.size;
      const captured = await captureSidebarMatchIds(page);
      for (const id of captured) all.add(id);
      const added = all.size - before;
      if (added === 0) {
        stable++;
        console.log(`scroll ${scrolls}: 0 new (stable ${stable}/${STABLE_NEEDED}, total ${all.size})`);
      } else {
        stable = 0;
        console.log(`scroll ${scrolls}: +${added} new (total ${all.size})`);
      }
    }

    if (scrolls >= MAX_SCROLLS) {
      console.warn(`\n⚠ hit MAX_SCROLLS=${MAX_SCROLLS} before stability — list may be longer than expected`);
    }

    // Read disk side
    const entities = await listAllEntities();
    const disk = new Map();  // match_id -> slug
    for (const ent of entities) {
      const id = ent.meta?.match_id;
      if (id) disk.set(id, ent.slug);
    }

    const tinderOnly = [...all].filter(id => !disk.has(id));
    const diskOnly = [...disk.entries()].filter(([id]) => !all.has(id));
    const both = [...all].filter(id => disk.has(id));

    console.log("\n=== DELTA ===");
    console.log(`tinder sidebar (live):     ${all.size}`);
    console.log(`raw/tinder/ on disk:       ${disk.size}`);
    console.log(`both (matched up):         ${both.length}`);
    console.log(`tinder_only (NEED PULL):   ${tinderOnly.length}`);
    console.log(`disk_only (unmatched/old): ${diskOnly.length}`);

    if (tinderOnly.length > 0) {
      console.log(`\nfirst 20 tinder_only match_ids:`);
      for (const id of tinderOnly.slice(0, 20)) console.log(`  ${id}`);
    }
    if (diskOnly.length > 0 && diskOnly.length <= 30) {
      console.log(`\ndisk_only (likely unmatched/closed since pull):`);
      for (const [id, slug] of diskOnly) console.log(`  ${slug}  (${id})`);
    } else if (diskOnly.length > 30) {
      console.log(`\ndisk_only too large to print (${diskOnly.length}); first 10 slugs:`);
      for (const [id, slug] of diskOnly.slice(0, 10)) console.log(`  ${slug}  (${id})`);
    }

    console.log("\n" + JSON.stringify({
      tinder: all.size,
      disk: disk.size,
      tinder_only: tinderOnly.length,
      disk_only: diskOnly.length,
      both: both.length,
      scrolls,
    }));
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(`match-delta FAILED: ${e.stack || e.message}`); process.exit(1); });
