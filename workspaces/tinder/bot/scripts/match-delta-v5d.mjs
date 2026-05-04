#!/usr/bin/env node
// match-delta v5d — extends v5c by also paginating the message=0 (Matches-tab
// unmessaged) bucket. v5c only paginated message=1 (Messages tab) because the
// scroll container we found was the messages list. v5d additionally walks the
// DOM to find ALL scrollable containers (vertical + horizontal) and scrolls
// each one, surfacing new-matches/grid pagination too.

import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "patchright";
import lockfile from "proper-lockfile";
import { PROFILE_DIR } from "../src/runtime/paths.mjs";
import { listAllEntities } from "../src/runtime/entity-store.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter, humanScroll } from "../src/runtime/humanize.mjs";
import { scanForHalts } from "../src/runtime/detection.mjs";

const RUN_OUT = "/tmp/tinder-match-delta-v5d.json";
const SNAP_OUT = `${process.env.HOME}/.quantum/tinder/match-snapshot.json`;
const HALT_PATH = `${process.env.HOME}/.quantum/tinder/.halt`;

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_VIEWPORT = { width: 393, height: 852 };

const SCROLL_DWELL_MIN_MS = 6000;
const SCROLL_DWELL_MAX_MS = 10000;
const INITIAL_DWELL_MIN_MS = 4500;
const INITIAL_DWELL_MAX_MS = 7000;
const MAX_SCROLLS = 120;
const MIN_SCROLLS_BEFORE_STABLE = 30;
const STABLE_NEEDED = 18;
const MAX_API_CALLS = 35;
const REVIEW_PAUSE_EVERY = 18;
const REVIEW_PAUSE_MIN_MS = 14000;
const REVIEW_PAUSE_MAX_MS = 22000;
const BAN_STATUSES = new Set([401, 403, 429]);

async function launchMobile() {
  await mkdir(PROFILE_DIR, { recursive: true });
  const release = await lockfile.lock(PROFILE_DIR, {
    retries: { retries: 0 },
    stale: 0,
    lockfilePath: PROFILE_DIR + "/.session.lock",
  });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    viewport: IPHONE_VIEWPORT,
    userAgent: IPHONE_UA,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: "en-US",
    timezoneId: "America/Chicago",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      `--window-size=${IPHONE_VIEWPORT.width + 20},${IPHONE_VIEWPORT.height + 80}`,
    ],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  ctx.on("close", async () => { try { await release(); } catch {} });
  return { ctx, page };
}

async function writeHalt(reason) {
  await mkdir(`${process.env.HOME}/.quantum/tinder`, { recursive: true });
  await writeFile(HALT_PATH, `match-delta-v5d: ${reason} at ${new Date().toISOString()}\n`);
  console.error(`!! HALT WRITTEN: ${reason}`);
}

// Scroll EVERY scrollable container that contains match anchors. For each:
//  - vertical container (overflow-y) → scrollBy(0, deltaY)
//  - horizontal container (overflow-x) → scrollBy(deltaX, 0)
// Returns array of {axis, scrollTop/Left, scrollWidth/Height, atEnd}.
async function scrollAllContainers(page, deltaPx) {
  return await page.evaluate((delta) => {
    const results = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href*='/app/messages/']")) {
      let el = a;
      while (el && el !== document.body) {
        const style = getComputedStyle(el);
        const isVScroll = (style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "overlay")
                       && el.scrollHeight > el.clientHeight + 4;
        const isHScroll = (style.overflowX === "auto" || style.overflowX === "scroll" || style.overflowX === "overlay")
                       && el.scrollWidth > el.clientWidth + 4;
        if (isVScroll || isHScroll) {
          if (seen.has(el)) break;
          seen.add(el);
          if (isVScroll) {
            const before = el.scrollTop;
            el.scrollBy({ top: delta, behavior: "auto" });
            results.push({
              axis: "y",
              tag: el.tagName,
              cls: (el.className || "").toString().slice(0, 60),
              scrollTop: el.scrollTop,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              atEnd: (el.scrollTop + el.clientHeight) >= (el.scrollHeight - 4),
              moved: el.scrollTop !== before,
            });
          }
          if (isHScroll) {
            const before = el.scrollLeft;
            el.scrollBy({ left: delta, behavior: "auto" });
            results.push({
              axis: "x",
              tag: el.tagName,
              cls: (el.className || "").toString().slice(0, 60),
              scrollLeft: el.scrollLeft,
              scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth,
              atEnd: (el.scrollLeft + el.clientWidth) >= (el.scrollWidth - 4),
              moved: el.scrollLeft !== before,
            });
          }
          break;
        }
        el = el.parentElement;
      }
    }
    return results;
  }, deltaPx);
}

async function main() {
  await abortIfHalted();
  console.log("MATCH-DELTA v5d — paginate BOTH message=1 AND message=0 buckets");
  console.log(`  scrolls every scrollable container (vertical + horizontal)`);
  console.log(`  caps: ${MAX_SCROLLS} scrolls, ${MAX_API_CALLS} API calls, ${MIN_SCROLLS_BEFORE_STABLE} prime, ${STABLE_NEEDED} stable\n`);

  const allIds = new Set();
  const callLog = [];
  let bannedFlag = false;

  const { ctx, page } = await launchMobile();

  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!/api\.gotinder\.com\/v2\/matches\?/.test(url)) return;
      const status = response.status();
      let count = null, cursor = null;
      try {
        const text = await response.text();
        const json = JSON.parse(text);
        const m = Array.isArray(json?.data?.matches) ? json.data.matches : [];
        count = m.length;
        cursor = json?.data?.next_page_token ?? null;
        for (const x of m) {
          const id = x._id || x.id;
          if (id) allIds.add(id);
        }
      } catch {}
      const entry = {
        ts: new Date().toISOString(),
        status,
        count,
        cursor: cursor ? cursor.slice(0, 28) + "..." : null,
        message_param: /[?&]message=([01])/.exec(url)?.[1] ?? null,
        page_token_present: /[?&]page_token=/.test(url),
        cumulative_ids: allIds.size,
      };
      callLog.push(entry);
      console.log(`  [/v2/matches msg=${entry.message_param}${entry.page_token_present ? "+pt" : ""}] status=${status} +${count} (total ${allIds.size})`);
      if (BAN_STATUSES.has(status)) { bannedFlag = true; await writeHalt(`/v2/matches returned ${status}`); }
    } catch (e) { console.error(`response handler: ${e.message}`); }
  });

  let scrolls = 0;
  let stable = 0;
  let lastContainerStats = null;

  try {
    console.log("nav -> https://tinder.com/app/matches ...");
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    await sleep(jitter(INITIAL_DWELL_MIN_MS, INITIAL_DWELL_MAX_MS));
    await scanForHalts(page);

    if (bannedFlag) { console.error("ban during initial load; aborting"); process.exit(3); }

    console.log(`\nafter initial load: ${callLog.length} calls, ${allIds.size} unique ids\n`);

    await page.mouse.move(
      Math.floor(IPHONE_VIEWPORT.width * 0.5),
      Math.floor(IPHONE_VIEWPORT.height * 0.6),
    );

    while (stable < STABLE_NEEDED && scrolls < MAX_SCROLLS && callLog.length < MAX_API_CALLS) {
      if (bannedFlag) break;
      await scanForHalts(page);
      const beforeCalls = callLog.length;
      const beforeIds = allIds.size;

      // Mechanism 1: humanScroll mouse.wheel (page-level)
      await humanScroll(page, { distance: jitter(280, 540), steps: jitter(5, 9) });

      // Mechanism 2: DOM scrollBy on EVERY scrollable container (vertical + horizontal)
      const stats = await scrollAllContainers(page, jitter(380, 720));
      lastContainerStats = stats;

      scrolls++;
      await sleep(jitter(SCROLL_DWELL_MIN_MS, SCROLL_DWELL_MAX_MS));

      const newCalls = callLog.length - beforeCalls;
      const newIds = allIds.size - beforeIds;
      const allAtEnd = stats.length > 0 && stats.every(s => s.atEnd);
      const tag = allAtEnd ? " [all@end]" : "";
      const phase = scrolls < MIN_SCROLLS_BEFORE_STABLE
        ? `priming ${scrolls}/${MIN_SCROLLS_BEFORE_STABLE}`
        : `stable ${stable}/${STABLE_NEEDED}`;

      if (newCalls === 0 && newIds === 0) {
        if (scrolls >= MIN_SCROLLS_BEFORE_STABLE) stable++;
        console.log(`scroll ${scrolls}: 0 new (${phase}, total ${allIds.size}, containers=${stats.length})${tag}`);
      } else {
        stable = 0;
        console.log(`scroll ${scrolls}: +${newCalls} call(s), +${newIds} ids (total ${allIds.size}, containers=${stats.length})${tag}`);
      }

      if (scrolls > 0 && scrolls % REVIEW_PAUSE_EVERY === 0 && stable < STABLE_NEEDED) {
        const pauseMs = jitter(REVIEW_PAUSE_MIN_MS, REVIEW_PAUSE_MAX_MS);
        console.log(`scroll ${scrolls}: review pause ${(pauseMs / 1000).toFixed(0)}s`);
        await sleep(pauseMs);
        await scanForHalts(page);
      }
    }

    if (callLog.length >= MAX_API_CALLS) console.warn(`\n⚠ hit MAX_API_CALLS=${MAX_API_CALLS}`);
    if (scrolls >= MAX_SCROLLS) console.warn(`\n⚠ hit MAX_SCROLLS=${MAX_SCROLLS}`);

    await scanForHalts(page);

    // === Compare to disk ===
    const entities = await listAllEntities();
    const disk = new Map();
    for (const ent of entities) {
      const id = ent.meta?.match_id;
      if (id) disk.set(id, ent.slug);
    }
    const diskIds = new Set(disk.keys());
    const tinderOnly = [...allIds].filter(id => !diskIds.has(id));
    const diskOnly = [...diskIds].filter(id => !allIds.has(id));
    const both = [...allIds].filter(id => diskIds.has(id));

    // Per-bucket call breakdown
    const msg0Calls = callLog.filter(c => c.message_param === "0").length;
    const msg1Calls = callLog.filter(c => c.message_param === "1").length;

    console.log("\n=== MATCH-DELTA v5d RESULT ===");
    console.log(`/v2/matches calls fired:       ${callLog.length} (msg=0: ${msg0Calls}, msg=1: ${msg1Calls})`);
    console.log(`unique match_ids enumerated:   ${allIds.size}`);
    console.log(`raw/tinder/ on disk:           ${disk.size}`);
    console.log(`both (matched up):             ${both.length}`);
    console.log(`tinder_only (NEW):             ${tinderOnly.length}`);
    console.log(`disk_only (off-roll):          ${diskOnly.length}`);

    const result = {
      ts: new Date().toISOString(),
      ua: IPHONE_UA,
      viewport: IPHONE_VIEWPORT,
      scrolls,
      api_calls: callLog.length,
      msg0_calls: msg0Calls,
      msg1_calls: msg1Calls,
      unique_match_ids: allIds.size,
      disk: disk.size,
      tinder_only: tinderOnly.length,
      disk_only: diskOnly.length,
      both: both.length,
      stable_at_exit: stable,
      banned_flag: bannedFlag,
      last_container_stats: lastContainerStats,
      callLog,
      ids: [...allIds],
      tinderOnlyIds: tinderOnly,
    };

    await writeFile(RUN_OUT, JSON.stringify(result, null, 2));
    await mkdir(`${process.env.HOME}/.quantum/tinder`, { recursive: true });
    await writeFile(SNAP_OUT, JSON.stringify(result, null, 2));
    console.log(`\nwrote ${RUN_OUT}`);
    console.log(`wrote ${SNAP_OUT}`);
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(`match-delta v5d FAILED: ${e.stack || e.message}`); process.exit(1); });
