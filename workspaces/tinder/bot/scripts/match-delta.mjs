#!/usr/bin/env node
// One-shot delta check: tinder.com matches sidebar vs raw/tinder/*.md
//
// PARANOID MODE v2 — account is at risk. Hard rules:
// - NEVER call api.gotinder.com (web UI only, patchright)
// - NEVER click into a thread, NEVER type, NEVER take any action
// - Drive lazy-load via page.mouse.wheel (matches the proven cron scraper),
//   not inner-element scrollBy
// - 5-8s dwell between scrolls (way slower than cron's 0.7-1.5s)
// - Periodic small upward "review" scroll every 15 passes
// - Stop after 5 consecutive zero-new passes
// - Hard cap 150 scrolls (covers ~2k+ matches at ~15/scroll)
// - Halt-safe at startup; scanForHalts before each scroll
// - Read-only enumeration of <a href='/app/messages/<id>'> in the sidebar

import { launchPersistent } from "../src/runtime/profile.mjs";
import { listAllEntities } from "../src/runtime/entity-store.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter, humanScroll } from "../src/runtime/humanize.mjs";
import { scanForHalts } from "../src/runtime/detection.mjs";

const WAIT_MIN_MS = 5000;
const WAIT_MAX_MS = 8000;
const STABLE_NEEDED = 5;
const MAX_SCROLLS = 150;
const INITIAL_DWELL_MIN_MS = 3500;
const INITIAL_DWELL_MAX_MS = 6500;
const SCROLL_DISTANCE_MIN = 280;
const SCROLL_DISTANCE_MAX = 540;
const SCROLL_STEPS_MIN = 5;
const SCROLL_STEPS_MAX = 9;
const REVIEW_EVERY = 15;
const REVIEW_UP_MIN = 120;
const REVIEW_UP_MAX = 280;
const REVIEW_PAUSE_MIN_MS = 8000;
const REVIEW_PAUSE_MAX_MS = 14000;

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

async function focusMatchesPane(page) {
  // Park the mouse over the left-rail matches sidebar so wheel events scroll
  // the right pane. Tinder's matches list sits in the left ~30% of the
  // viewport; aim mid-rail at vertical center.
  try {
    const vp = page.viewportSize();
    const w = vp?.width || 1280;
    const h = vp?.height || 800;
    const x = Math.floor(w * 0.18);
    const y = Math.floor(h * 0.5);
    await page.mouse.move(x, y, { steps: jitter(4, 9) });
  } catch { /* ignore */ }
}

async function main() {
  await abortIfHalted();

  console.log("PARANOID MODE v2: page.mouse.wheel-driven match-list delta check");
  console.log("- web UI only, no api.gotinder.com");
  console.log("- read-only sidebar scrape, no clicks, no thread opens");
  console.log(`- wheel scrolls: ${SCROLL_DISTANCE_MIN}-${SCROLL_DISTANCE_MAX}px in ${SCROLL_STEPS_MIN}-${SCROLL_STEPS_MAX} micro-steps`);
  console.log(`- between-scroll dwell: ${WAIT_MIN_MS}-${WAIT_MAX_MS}ms`);
  console.log(`- review pause + tiny upward scroll every ${REVIEW_EVERY} passes`);
  console.log(`- stop after ${STABLE_NEEDED} consecutive zero-new (max ${MAX_SCROLLS})\n`);

  const { ctx, page } = await launchPersistent({ headless: false });

  try {
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    await sleep(jitter(INITIAL_DWELL_MIN_MS, INITIAL_DWELL_MAX_MS));
    await scanForHalts(page);
    await focusMatchesPane(page);

    const all = new Set();
    {
      const initial = await captureSidebarMatchIds(page);
      for (const id of initial) all.add(id);
      console.log(`initial snapshot: ${all.size} match_ids visible`);
    }

    let stable = 0;
    let scrolls = 0;
    while (stable < STABLE_NEEDED && scrolls < MAX_SCROLLS) {
      await scanForHalts(page);
      await humanScroll(page, {
        distance: jitter(SCROLL_DISTANCE_MIN, SCROLL_DISTANCE_MAX),
        steps: jitter(SCROLL_STEPS_MIN, SCROLL_STEPS_MAX),
      });
      scrolls++;
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

      // Periodic "review" pause + tiny upward scroll. Mimics real review
      // behavior; also nudges the scroll container in case lazy-load is
      // direction-sensitive.
      if (scrolls > 0 && scrolls % REVIEW_EVERY === 0 && stable < STABLE_NEEDED && scrolls < MAX_SCROLLS) {
        const pauseMs = jitter(REVIEW_PAUSE_MIN_MS, REVIEW_PAUSE_MAX_MS);
        console.log(`scroll ${scrolls}: review pause ${pauseMs}ms + small upward scroll`);
        await sleep(pauseMs);
        await focusMatchesPane(page);
        await page.mouse.wheel(0, -jitter(REVIEW_UP_MIN, REVIEW_UP_MAX));
        await sleep(jitter(2500, 4500));
        // Re-capture after the upward nudge — sometimes virtualization
        // re-renders new IDs above the viewport.
        const beforeReview = all.size;
        const reviewCaptured = await captureSidebarMatchIds(page);
        for (const id of reviewCaptured) all.add(id);
        const reviewAdded = all.size - beforeReview;
        if (reviewAdded > 0) {
          stable = 0;
          console.log(`  review: +${reviewAdded} new (total ${all.size})`);
        }
        await sleep(jitter(WAIT_MIN_MS, WAIT_MAX_MS));
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
      console.log(`\nfirst 30 tinder_only match_ids:`);
      for (const id of tinderOnly.slice(0, 30)) console.log(`  ${id}`);
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
