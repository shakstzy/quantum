#!/usr/bin/env node
// match-delta v5e — sequential phases, capture id+name+meta per match.
//
// Lesson from v5d: scrolling vertical+horizontal SIMULTANEOUSLY dampened the
// vertical messages-list pagination. Solution: do them one at a time.
//
//   Phase A: vertical-only on messages list until atBottom + N stable scrolls
//   Phase B: horizontal-only on new-matches carousel until atRight + N stable
//
// For each /v2/matches response, captures the FULL match objects (id + name +
// last_activity_date + person fields) into snapshot.matches[] so a follow-up
// pull script can deep-link the missing ones with names.

import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "patchright";
import lockfile from "proper-lockfile";
import { PROFILE_DIR } from "../src/runtime/paths.mjs";
import { listAllEntities } from "../src/runtime/entity-store.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter, humanScroll } from "../src/runtime/humanize.mjs";
import { scanForHalts } from "../src/runtime/detection.mjs";

const RUN_OUT = "/tmp/tinder-match-delta-v5e.json";
const SNAP_OUT = `${process.env.HOME}/.quantum/tinder/match-snapshot.json`;
const HALT_PATH = `${process.env.HOME}/.quantum/tinder/.halt`;

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_VIEWPORT = { width: 393, height: 852 };

const SCROLL_DWELL_MIN_MS = 6000;
const SCROLL_DWELL_MAX_MS = 10000;
const INITIAL_DWELL_MIN_MS = 4500;
const INITIAL_DWELL_MAX_MS = 7000;
const PHASE_A_MAX_SCROLLS = 80;
const PHASE_A_MIN_PRIME = 25;
const PHASE_A_STABLE_NEEDED = 14;
const PHASE_B_MAX_SCROLLS = 40;
const PHASE_B_MIN_PRIME = 10;
const PHASE_B_STABLE_NEEDED = 8;
const MAX_API_CALLS = 50;
const REVIEW_PAUSE_EVERY = 15;
const REVIEW_PAUSE_MIN_MS = 14000;
const REVIEW_PAUSE_MAX_MS = 22000;
const PHASE_GAP_MIN_MS = 18000;
const PHASE_GAP_MAX_MS = 28000;
const BAN_STATUSES = new Set([401, 403, 429]);

async function launchMobile() {
  await mkdir(PROFILE_DIR, { recursive: true });
  const release = await lockfile.lock(PROFILE_DIR, {
    retries: { retries: 0 }, stale: 0,
    lockfilePath: PROFILE_DIR + "/.session.lock",
  });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, channel: "chrome",
    viewport: IPHONE_VIEWPORT, userAgent: IPHONE_UA,
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    locale: "en-US", timezoneId: "America/Chicago",
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
  await writeFile(HALT_PATH, `match-delta-v5e: ${reason} at ${new Date().toISOString()}\n`);
  console.error(`!! HALT: ${reason}`);
}

// Scroll only vertical containers
async function scrollVerticalOnly(page, deltaPx) {
  return await page.evaluate((delta) => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll("a[href*='/app/messages/']")) {
      let el = a;
      while (el && el !== document.body) {
        const s = getComputedStyle(el);
        const isV = (s.overflowY === "auto" || s.overflowY === "scroll" || s.overflowY === "overlay")
                 && el.scrollHeight > el.clientHeight + 4;
        if (isV) {
          if (!seen.has(el)) {
            seen.add(el);
            const before = el.scrollTop;
            el.scrollBy({ top: delta, behavior: "auto" });
            out.push({
              scrollTop: el.scrollTop, scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight, moved: el.scrollTop !== before,
              atEnd: (el.scrollTop + el.clientHeight) >= (el.scrollHeight - 4),
            });
          }
          break;
        }
        el = el.parentElement;
      }
    }
    return out;
  }, deltaPx);
}

// Scroll only horizontal containers
async function scrollHorizontalOnly(page, deltaPx) {
  return await page.evaluate((delta) => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll("a[href*='/app/messages/']")) {
      let el = a;
      while (el && el !== document.body) {
        const s = getComputedStyle(el);
        const isH = (s.overflowX === "auto" || s.overflowX === "scroll" || s.overflowX === "overlay")
                 && el.scrollWidth > el.clientWidth + 4;
        if (isH) {
          if (!seen.has(el)) {
            seen.add(el);
            const before = el.scrollLeft;
            el.scrollBy({ left: delta, behavior: "auto" });
            out.push({
              scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth, moved: el.scrollLeft !== before,
              atEnd: (el.scrollLeft + el.clientWidth) >= (el.scrollWidth - 4),
            });
          }
          break;
        }
        el = el.parentElement;
      }
    }
    return out;
  }, deltaPx);
}

async function runPhase(page, label, scrollFn, opts) {
  console.log(`\n=== ${label} ===`);
  let scrolls = 0, stable = 0;
  while (stable < opts.STABLE_NEEDED && scrolls < opts.MAX_SCROLLS && opts.callCount() < MAX_API_CALLS) {
    if (opts.banned()) break;
    await scanForHalts(page);
    const beforeCalls = opts.callCount();
    const beforeIds = opts.idCount();

    if (label.includes("PHASE A")) {
      // Use mouse.wheel + DOM scrollBy for vertical
      await humanScroll(page, { distance: jitter(280, 540), steps: jitter(5, 9) });
    }
    const stat = await scrollFn(page, jitter(380, 720));
    scrolls++;
    await sleep(jitter(SCROLL_DWELL_MIN_MS, SCROLL_DWELL_MAX_MS));

    const newCalls = opts.callCount() - beforeCalls;
    const newIds = opts.idCount() - beforeIds;
    const allEnd = stat.length > 0 && stat.every(s => s.atEnd);
    const tag = allEnd ? " [@end]" : "";
    const phase = scrolls < opts.MIN_PRIME ? `priming ${scrolls}/${opts.MIN_PRIME}` : `stable ${stable}/${opts.STABLE_NEEDED}`;

    if (newCalls === 0 && newIds === 0) {
      if (scrolls >= opts.MIN_PRIME) stable++;
      console.log(`  [${label}] scroll ${scrolls}: 0 new (${phase}, total ${opts.idCount()}, c=${stat.length})${tag}`);
    } else {
      stable = 0;
      console.log(`  [${label}] scroll ${scrolls}: +${newCalls} call(s), +${newIds} ids (total ${opts.idCount()}, c=${stat.length})${tag}`);
    }

    if (scrolls % REVIEW_PAUSE_EVERY === 0 && stable < opts.STABLE_NEEDED) {
      const p = jitter(REVIEW_PAUSE_MIN_MS, REVIEW_PAUSE_MAX_MS);
      console.log(`  [${label}] review pause ${(p/1000).toFixed(0)}s`);
      await sleep(p);
      await scanForHalts(page);
    }
  }
  return { scrolls, stable };
}

async function main() {
  await abortIfHalted();
  console.log("MATCH-DELTA v5e — sequential phases (vertical then horizontal)\n");

  const allIds = new Set();
  const matchesDb = new Map();   // id → {id, name, message_count, last_activity_date}
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
          if (!id) continue;
          allIds.add(id);
          if (!matchesDb.has(id)) {
            matchesDb.set(id, {
              id,
              name: x.person?.name || x.name || null,
              message_count: x.message_count ?? null,
              last_activity_date: x.last_activity_date || null,
              created_date: x.created_date || null,
            });
          }
        }
      } catch {}
      const entry = {
        ts: new Date().toISOString(), status, count,
        cursor: cursor ? cursor.slice(0, 28) + "..." : null,
        message_param: /[?&]message=([01])/.exec(url)?.[1] ?? null,
        page_token_present: /[?&]page_token=/.test(url),
        cumulative_ids: allIds.size,
      };
      callLog.push(entry);
      console.log(`  [/v2/matches msg=${entry.message_param}${entry.page_token_present ? "+pt" : ""}] status=${status} +${count} (total ${allIds.size})`);
      if (BAN_STATUSES.has(status)) { bannedFlag = true; await writeHalt(`/v2/matches ${status}`); }
    } catch (e) { console.error(`response: ${e.message}`); }
  });

  try {
    console.log("nav -> https://tinder.com/app/matches ...");
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    await sleep(jitter(INITIAL_DWELL_MIN_MS, INITIAL_DWELL_MAX_MS));
    await scanForHalts(page);
    if (bannedFlag) { console.error("ban during init"); process.exit(3); }
    console.log(`after init: ${callLog.length} calls, ${allIds.size} ids\n`);

    await page.mouse.move(
      Math.floor(IPHONE_VIEWPORT.width * 0.5),
      Math.floor(IPHONE_VIEWPORT.height * 0.6),
    );

    const ctxOpts = { callCount: () => callLog.length, idCount: () => allIds.size, banned: () => bannedFlag };

    // Phase A: vertical-only (messages list pagination)
    const A = await runPhase(page, "PHASE A vertical msg=1", scrollVerticalOnly, {
      ...ctxOpts,
      MAX_SCROLLS: PHASE_A_MAX_SCROLLS,
      MIN_PRIME: PHASE_A_MIN_PRIME,
      STABLE_NEEDED: PHASE_A_STABLE_NEEDED,
    });

    if (!bannedFlag && callLog.length < MAX_API_CALLS) {
      const gap = jitter(PHASE_GAP_MIN_MS, PHASE_GAP_MAX_MS);
      console.log(`\n--- inter-phase pause ${(gap/1000).toFixed(0)}s (look like real user reviewing) ---`);
      await sleep(gap);
      await scanForHalts(page);

      // Phase B: horizontal-only (new-matches carousel pagination)
      // Park mouse over the carousel area (top of page)
      await page.mouse.move(
        Math.floor(IPHONE_VIEWPORT.width * 0.5),
        Math.floor(IPHONE_VIEWPORT.height * 0.18),
      );
      const B = await runPhase(page, "PHASE B horizontal msg=0", scrollHorizontalOnly, {
        ...ctxOpts,
        MAX_SCROLLS: PHASE_B_MAX_SCROLLS,
        MIN_PRIME: PHASE_B_MIN_PRIME,
        STABLE_NEEDED: PHASE_B_STABLE_NEEDED,
      });
      console.log(`\nPhase A: ${A.scrolls} scrolls. Phase B: ${B.scrolls} scrolls.`);
    }

    await scanForHalts(page);

    // === Compare to disk ===
    const entities = await listAllEntities();
    const disk = new Map();
    for (const e of entities) { const id = e.meta?.match_id; if (id) disk.set(id, e.slug); }
    const diskIds = new Set(disk.keys());
    const tinderOnly = [...allIds].filter(id => !diskIds.has(id));
    const both = [...allIds].filter(id => diskIds.has(id));
    const diskOnly = [...diskIds].filter(id => !allIds.has(id));

    const msg0Calls = callLog.filter(c => c.message_param === "0").length;
    const msg1Calls = callLog.filter(c => c.message_param === "1").length;

    console.log("\n=== MATCH-DELTA v5e RESULT ===");
    console.log(`/v2/matches calls:           ${callLog.length} (msg=0: ${msg0Calls}, msg=1: ${msg1Calls})`);
    console.log(`unique match_ids:            ${allIds.size}`);
    console.log(`disk:                        ${disk.size}`);
    console.log(`both:                        ${both.length}`);
    console.log(`tinder_only (NEW):           ${tinderOnly.length}`);
    console.log(`disk_only:                   ${diskOnly.length}`);

    if (tinderOnly.length > 0) {
      console.log(`\nfirst 30 tinder_only with names:`);
      for (const id of tinderOnly.slice(0, 30)) {
        const m = matchesDb.get(id);
        console.log(`  ${id}  ${m?.name || "(no name)"}  msg_count=${m?.message_count ?? "?"}`);
      }
    }

    const result = {
      ts: new Date().toISOString(),
      ua: IPHONE_UA, viewport: IPHONE_VIEWPORT,
      api_calls: callLog.length, msg0_calls: msg0Calls, msg1_calls: msg1Calls,
      unique_match_ids: allIds.size, disk: disk.size,
      tinder_only: tinderOnly.length, disk_only: diskOnly.length, both: both.length,
      banned_flag: bannedFlag,
      callLog, ids: [...allIds], tinderOnlyIds: tinderOnly,
      matches: [...matchesDb.values()],   // full id+name+meta for downstream pull
    };

    await writeFile(RUN_OUT, JSON.stringify(result, null, 2));
    await writeFile(SNAP_OUT, JSON.stringify(result, null, 2));
    console.log(`\nwrote ${RUN_OUT}\nwrote ${SNAP_OUT}`);
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(`v5e FAILED: ${e.stack || e.message}`); process.exit(1); });
