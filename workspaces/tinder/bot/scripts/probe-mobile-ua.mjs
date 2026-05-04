#!/usr/bin/env node
// Mobile-UA experiment: relaunch tinder.com with iPhone UA + mobile viewport,
// see if the React client switches to a mobile-flavored UI that paginates
// the matches list via natural infinite scroll.
//
// Hypothesis (per Gemini analysis): Tinder's mobile app DOES paginate fully
// via /v2/matches?page_token cursor; the desktop web client does not.
// Mobile UA on tinder.com MIGHT serve the mobile-style UI that paginates.
//
// Read-only observer. Patchright with mobile UA override on existing
// persistent profile (cookies stay, UA changes for this session only).
// Halt-safe before/after every action.

import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "patchright";
import lockfile from "proper-lockfile";
import { PROFILE_DIR } from "../src/runtime/paths.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter, humanScroll, makeCursor } from "../src/runtime/humanize.mjs";
import { scanForHalts } from "../src/runtime/detection.mjs";

const OUT_PATH = "/tmp/tinder-mobile-ua-probe.json";

// Real iPhone Safari UA (post-iOS 18). iPhone 15 Pro logical viewport.
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_VIEWPORT = { width: 393, height: 852 };
const SCROLL_PASSES = 8;
const SCROLL_DWELL_MIN_MS = 5000;
const SCROLL_DWELL_MAX_MS = 8000;
const INITIAL_DWELL_MIN_MS = 4500;
const INITIAL_DWELL_MAX_MS = 7000;

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

async function findTabBox(page, label) {
  return await page.evaluate((wantLabel) => {
    for (const btn of document.querySelectorAll("button[role='tab']")) {
      if ((btn.textContent || "").trim() === wantLabel) {
        const r = btn.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, ariaSelected: btn.getAttribute("aria-selected") };
      }
    }
    return null;
  }, label);
}

async function clickTabHuman(page, cursor, label) {
  const box = await findTabBox(page, label);
  if (!box) return { clicked: false, reason: "tab not found" };
  if (box.ariaSelected === "true") return { clicked: false, reason: "already selected" };
  const tx = box.x + box.w * (0.3 + Math.random() * 0.4);
  const ty = box.y + box.h * (0.3 + Math.random() * 0.4);
  await cursor.actions.move({ x: tx, y: ty });
  await sleep(jitter(120, 320));
  await cursor.actions.click();
  return { clicked: true };
}

async function captureSidebarMatchIds(page) {
  return await page.evaluate(() => {
    const out = new Set();
    for (const a of document.querySelectorAll("a[href*='/app/messages/']")) {
      const id = a.href.split("/").pop();
      if (id && id.length >= 40) out.add(id);
    }
    return [...out];
  });
}

async function main() {
  await abortIfHalted();
  console.log("MOBILE-UA EXPERIMENT");
  console.log(`- UA: iPhone 15 Pro Safari (post-iOS 18)`);
  console.log(`- viewport: ${IPHONE_VIEWPORT.width}×${IPHONE_VIEWPORT.height} (isMobile=true, hasTouch=true)`);
  console.log(`- profile: main persistent (cookies preserved)`);
  console.log(`- output: ${OUT_PATH}\n`);

  const matchesCalls = [];
  const allMatchIds = new Set();
  const responseLog = [];

  const { ctx, page } = await launchMobile();

  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!/api\.gotinder\.com\/v2\/matches\?/.test(url)) return;
      const status = response.status();
      const isInitial = matchesCalls.length < 2;
      let parsedCount = null;
      let nextToken = null;
      try {
        const text = await response.text();
        const json = JSON.parse(text);
        const m = Array.isArray(json?.data?.matches) ? json.data.matches : [];
        parsedCount = m.length;
        nextToken = json?.data?.next_page_token ?? null;
        for (const x of m) {
          const id = x._id || x.id;
          if (id) allMatchIds.add(id);
        }
      } catch (e) { /* ignore parse */ }
      const entry = { url, status, parsedCount, nextToken, isInitial };
      matchesCalls.push(entry);
      responseLog.push(entry);
      console.log(`  [/v2/matches] status=${status} count=${parsedCount} cursor=${nextToken ? nextToken.slice(0,20)+"..." : "null"}`);
    } catch (e) { console.error(`response handler: ${e.message}`); }
  });

  try {
    console.log("nav -> https://tinder.com/app/matches ...");
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    await sleep(jitter(INITIAL_DWELL_MIN_MS, INITIAL_DWELL_MAX_MS));
    await scanForHalts(page);

    // Confirm we landed on the right page
    const currentUrl = page.url();
    console.log(`landed url: ${currentUrl}`);

    const initialIds = await captureSidebarMatchIds(page);
    console.log(`initial DOM match anchors: ${initialIds.length}`);

    const cursor = await makeCursor(page);

    // Park the mouse over the matches list area so wheel events scroll the right pane
    await page.mouse.move(Math.floor(IPHONE_VIEWPORT.width * 0.5), Math.floor(IPHONE_VIEWPORT.height * 0.6));

    console.log(`\nslow scroll on Matches tab (${SCROLL_PASSES} passes)...`);
    for (let i = 0; i < SCROLL_PASSES; i++) {
      const beforeCalls = matchesCalls.length;
      await humanScroll(page, { distance: jitter(280, 540), steps: jitter(5, 9) });
      await sleep(jitter(SCROLL_DWELL_MIN_MS, SCROLL_DWELL_MAX_MS));
      await scanForHalts(page);
      const newCalls = matchesCalls.length - beforeCalls;
      if (newCalls > 0) console.log(`  scroll ${i+1}: +${newCalls} /v2/matches call(s)`);
    }

    console.log(`\nclick Messages tab via ghost-cursor...`);
    const tabResult = await clickTabHuman(page, cursor, "Messages");
    console.log(`  ${JSON.stringify(tabResult)}`);
    await sleep(jitter(2500, 4500));
    await scanForHalts(page);

    console.log(`\nslow scroll on Messages tab (${SCROLL_PASSES} passes)...`);
    await page.mouse.move(Math.floor(IPHONE_VIEWPORT.width * 0.5), Math.floor(IPHONE_VIEWPORT.height * 0.6));
    for (let i = 0; i < SCROLL_PASSES; i++) {
      const beforeCalls = matchesCalls.length;
      await humanScroll(page, { distance: jitter(280, 540), steps: jitter(5, 9) });
      await sleep(jitter(SCROLL_DWELL_MIN_MS, SCROLL_DWELL_MAX_MS));
      await scanForHalts(page);
      const newCalls = matchesCalls.length - beforeCalls;
      if (newCalls > 0) console.log(`  scroll ${i+1}: +${newCalls} /v2/matches call(s)`);
    }

    await sleep(jitter(2000, 4000));
    await scanForHalts(page);

    console.log("\n=== RESULT ===");
    console.log(`/v2/matches calls captured: ${matchesCalls.length}`);
    console.log(`unique match_ids accumulated: ${allMatchIds.size}`);
    console.log(`final DOM anchor count: ${(await captureSidebarMatchIds(page)).length}`);

    await writeFile(OUT_PATH, JSON.stringify({
      ts: new Date().toISOString(),
      ua: IPHONE_UA,
      viewport: IPHONE_VIEWPORT,
      landed_url: currentUrl,
      matchesCalls: responseLog,
      total_calls: matchesCalls.length,
      unique_match_ids: allMatchIds.size,
      ids_sample: [...allMatchIds].slice(0, 10),
    }, null, 2));
    console.log(`\nwrote ${OUT_PATH}`);
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(`mobile-ua probe FAILED: ${e.stack || e.message}`); process.exit(1); });
