#!/usr/bin/env node
// match-delta v5 — full enumeration via mobile-UA natural pagination.
//
// Per the live-verified breakthrough:
//   - Mobile UA + viewport (iPhone 15 Pro Safari, isMobile, hasTouch) makes
//     Tinder's React client serve a phone-style UI that paginates the
//     /v2/matches endpoint on natural scroll.
//   - The React client itself fires the paginated calls with cursor; we just
//     listen via page.on('response'). Zero header injection, zero replay.
//
// Halt-safe before/after every scroll. Hard breaker on any
// 401/403/429/Cloudflare/login-wall/Arkose. 5 consecutive zero-new-call
// scrolls (or no next_page_token) ends the run.
//
// Compares accumulated match_ids to raw/tinder/ entities and writes:
//   /tmp/tinder-match-delta-v5.json (this run)
//   ~/.quantum/tinder/match-snapshot.json (persistent latest)

import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "patchright";
import lockfile from "proper-lockfile";
import { PROFILE_DIR } from "../src/runtime/paths.mjs";
import { listAllEntities } from "../src/runtime/entity-store.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter, humanScroll } from "../src/runtime/humanize.mjs";
import { scanForHalts } from "../src/runtime/detection.mjs";

const RUN_OUT = "/tmp/tinder-match-delta-v5.json";
const SNAP_OUT = `${process.env.HOME}/.quantum/tinder/match-snapshot.json`;
const HALT_PATH = `${process.env.HOME}/.quantum/tinder/.halt`;

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_VIEWPORT = { width: 393, height: 852 };

const SCROLL_DWELL_MIN_MS = 6000;
const SCROLL_DWELL_MAX_MS = 10000;
const INITIAL_DWELL_MIN_MS = 4500;
const INITIAL_DWELL_MAX_MS = 7000;
const MAX_SCROLLS = 50;
const STABLE_NEEDED = 5;
const MAX_API_CALLS = 30;
const REVIEW_PAUSE_EVERY = 12;
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
  await writeFile(HALT_PATH, `match-delta-v5: ${reason} at ${new Date().toISOString()}\n`);
  console.error(`!! HALT WRITTEN: ${reason}`);
}

async function main() {
  await abortIfHalted();
  console.log("MATCH-DELTA v5 — full enumeration via mobile-UA natural pagination");
  console.log(`  UA: iPhone 15 Pro Safari (post-iOS 18)`);
  console.log(`  viewport: ${IPHONE_VIEWPORT.width}×${IPHONE_VIEWPORT.height} (isMobile, hasTouch)`);
  console.log(`  pacing: ${SCROLL_DWELL_MIN_MS / 1000}-${SCROLL_DWELL_MAX_MS / 1000}s between scrolls`);
  console.log(`  caps: ${MAX_SCROLLS} scrolls, ${MAX_API_CALLS} API calls, ${STABLE_NEEDED} stable to exit\n`);

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
        url: url.length > 250 ? url.slice(0, 250) + "..." : url,
        status,
        count,
        cursor: cursor ? cursor.slice(0, 28) + "..." : null,
        message_param: /[?&]message=([01])/.exec(url)?.[1] ?? null,
        cumulative_ids: allIds.size,
      };
      callLog.push(entry);
      console.log(`  [/v2/matches msg=${entry.message_param}] status=${status} +${count} (total ${allIds.size}) cursor=${entry.cursor}`);
      if (BAN_STATUSES.has(status)) {
        bannedFlag = true;
        await writeHalt(`/v2/matches returned ${status}`);
      }
    } catch (e) { console.error(`response handler: ${e.message}`); }
  });

  let scrolls = 0;
  let stable = 0;

  try {
    console.log("nav -> https://tinder.com/app/matches ...");
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    await sleep(jitter(INITIAL_DWELL_MIN_MS, INITIAL_DWELL_MAX_MS));
    await scanForHalts(page);

    if (bannedFlag) {
      console.error("ban flag set during initial load; aborting");
      process.exit(3);
    }

    console.log(`\nafter initial load: ${callLog.length} calls, ${allIds.size} unique match_ids\n`);

    // Park mouse over the matches list area for wheel events
    await page.mouse.move(
      Math.floor(IPHONE_VIEWPORT.width * 0.5),
      Math.floor(IPHONE_VIEWPORT.height * 0.6),
    );

    while (stable < STABLE_NEEDED && scrolls < MAX_SCROLLS && callLog.length < MAX_API_CALLS) {
      if (bannedFlag) break;
      await scanForHalts(page);
      const beforeCalls = callLog.length;
      const beforeIds = allIds.size;

      await humanScroll(page, { distance: jitter(280, 540), steps: jitter(5, 9) });
      scrolls++;
      await sleep(jitter(SCROLL_DWELL_MIN_MS, SCROLL_DWELL_MAX_MS));

      const newCalls = callLog.length - beforeCalls;
      const newIds = allIds.size - beforeIds;

      if (newCalls === 0 && newIds === 0) {
        stable++;
        console.log(`scroll ${scrolls}: 0 new calls (stable ${stable}/${STABLE_NEEDED}, total ${allIds.size})`);
      } else {
        stable = 0;
        console.log(`scroll ${scrolls}: +${newCalls} call(s), +${newIds} ids (total ${allIds.size})`);
      }

      // Periodic review pause — looks like real review, not bot-shape
      if (scrolls > 0 && scrolls % REVIEW_PAUSE_EVERY === 0 && stable < STABLE_NEEDED) {
        const pauseMs = jitter(REVIEW_PAUSE_MIN_MS, REVIEW_PAUSE_MAX_MS);
        console.log(`scroll ${scrolls}: review pause ${(pauseMs / 1000).toFixed(0)}s`);
        await sleep(pauseMs);
        await scanForHalts(page);
      }
    }

    if (callLog.length >= MAX_API_CALLS) {
      console.warn(`\n⚠ hit MAX_API_CALLS=${MAX_API_CALLS}; stopping for safety`);
    }
    if (scrolls >= MAX_SCROLLS) {
      console.warn(`\n⚠ hit MAX_SCROLLS=${MAX_SCROLLS}; stopping for safety`);
    }

    // Final halt scan
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

    console.log("\n=== MATCH-DELTA v5 RESULT ===");
    console.log(`/v2/matches calls fired:       ${callLog.length}`);
    console.log(`unique match_ids enumerated:   ${allIds.size}`);
    console.log(`raw/tinder/ on disk:           ${disk.size}`);
    console.log(`both (matched up):             ${both.length}`);
    console.log(`tinder_only (NEED PULL):       ${tinderOnly.length}`);
    console.log(`disk_only (off-roll, dormant): ${diskOnly.length}`);

    if (tinderOnly.length > 0) {
      console.log(`\nfirst 30 tinder_only match_ids:`);
      for (const id of tinderOnly.slice(0, 30)) console.log(`  ${id}`);
    }

    const result = {
      ts: new Date().toISOString(),
      ua: IPHONE_UA,
      viewport: IPHONE_VIEWPORT,
      scrolls,
      api_calls: callLog.length,
      unique_match_ids: allIds.size,
      disk: disk.size,
      tinder_only: tinderOnly.length,
      disk_only: diskOnly.length,
      both: both.length,
      stable_at_exit: stable,
      banned_flag: bannedFlag,
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

main().catch(e => { console.error(`match-delta v5 FAILED: ${e.stack || e.message}`); process.exit(1); });
