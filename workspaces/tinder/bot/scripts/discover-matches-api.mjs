#!/usr/bin/env node
// Discovery probe: identify the API endpoint the tinder.com web client uses
// to fetch the matches list, and the response shape (so we can capture it
// in v4 of match-delta).
//
// READ-ONLY observer. We do NOT initiate any api.gotinder.com calls — we
// only listen to the responses the legit React client makes naturally as
// we drive the UI (open /app/matches, click Messages tab, slow scroll).
//
// Same doctrine as grok-web: drive UI, read network.
//
// Outputs: /tmp/tinder-api-discovery.json with distinct API endpoints +
// sample bodies. Throwaway script — delete after wiring v4.

import { writeFile } from "node:fs/promises";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter, humanScroll, makeCursor } from "../src/runtime/humanize.mjs";
import { scanForHalts } from "../src/runtime/detection.mjs";

const OUT_PATH = "/tmp/tinder-api-discovery.json";
const SCROLL_PASSES = 4;
const SCROLL_DWELL_MIN_MS = 5000;
const SCROLL_DWELL_MAX_MS = 8000;
const INITIAL_DWELL_MIN_MS = 4000;
const INITIAL_DWELL_MAX_MS = 6500;
const POST_TAB_DWELL_MIN_MS = 3000;
const POST_TAB_DWELL_MAX_MS = 5500;

function isTinderApi(url) {
  return /(api|chat|cs)\.gotinder\.com|tinder\.com\/(api|graphql)/.test(url);
}

async function focusMatchesPane(page) {
  try {
    const vp = page.viewportSize();
    const w = vp?.width || 1280;
    const h = vp?.height || 800;
    await page.mouse.move(Math.floor(w * 0.18), Math.floor(h * 0.5), { steps: jitter(4, 9) });
  } catch { /* ignore */ }
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

async function clickTab(page, cursor, label) {
  const box = await findTabBox(page, label);
  if (!box) throw new Error(`tab "${label}" not found`);
  if (box.ariaSelected === "true") return false;
  const tx = box.x + box.w * (0.3 + Math.random() * 0.4);
  const ty = box.y + box.h * (0.3 + Math.random() * 0.4);
  await cursor.actions.move({ x: tx, y: ty });
  await sleep(jitter(120, 320));
  await cursor.actions.click();
  return true;
}

async function main() {
  await abortIfHalted();
  console.log("DISCOVERY: tinder matches-list API endpoint");
  console.log("- READ-ONLY observer; we only listen to client's own responses");
  console.log(`- output: ${OUT_PATH}\n`);

  const { ctx, page } = await launchPersistent({ headless: false });

  const captures = [];
  const seenUrls = new Set();

  // Hook BEFORE navigation
  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!isTinderApi(url)) return;
      const status = response.status();
      const method = response.request().method();
      const ct = response.headers()["content-type"] || "";
      // Only attempt to read JSON-ish bodies
      const isJson = /json|x-ndjson|text/i.test(ct);
      let bodyPreview = null;
      let bodyLen = null;
      let parseError = null;
      if (isJson) {
        try {
          const text = await response.text();
          bodyLen = text.length;
          bodyPreview = text.slice(0, 4000);
        } catch (e) {
          parseError = e.message;
        }
      }
      captures.push({
        ts: new Date().toISOString(),
        url,
        method,
        status,
        contentType: ct,
        bodyLen,
        bodyPreview,
        parseError,
      });
      // De-dupe URL family for console: log distinct path+method combos
      const u = new URL(url);
      const key = `${method} ${u.host}${u.pathname.replace(/\/[a-f0-9]{8,}/g, "/<id>")}`;
      if (!seenUrls.has(key)) {
        seenUrls.add(key);
        console.log(`  [+] ${key}  status=${status}  ct=${ct.slice(0, 40)}`);
      }
    } catch (e) {
      console.error(`response handler error: ${e.message}`);
    }
  });

  try {
    console.log("nav -> /app/matches ...");
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    await sleep(jitter(INITIAL_DWELL_MIN_MS, INITIAL_DWELL_MAX_MS));
    await scanForHalts(page);

    const cursor = await makeCursor(page);
    await focusMatchesPane(page);

    console.log(`\nslow scroll on Matches tab (${SCROLL_PASSES} passes)...`);
    for (let i = 0; i < SCROLL_PASSES; i++) {
      await humanScroll(page, { distance: jitter(280, 540), steps: jitter(5, 9) });
      await sleep(jitter(SCROLL_DWELL_MIN_MS, SCROLL_DWELL_MAX_MS));
      await scanForHalts(page);
    }

    console.log("\nclick Messages tab...");
    const clicked = await clickTab(page, cursor, "Messages");
    console.log(`  clicked=${clicked}`);
    await sleep(jitter(POST_TAB_DWELL_MIN_MS, POST_TAB_DWELL_MAX_MS));
    await scanForHalts(page);

    console.log(`\nslow scroll on Messages tab (${SCROLL_PASSES} passes)...`);
    await focusMatchesPane(page);
    for (let i = 0; i < SCROLL_PASSES; i++) {
      await humanScroll(page, { distance: jitter(280, 540), steps: jitter(5, 9) });
      await sleep(jitter(SCROLL_DWELL_MIN_MS, SCROLL_DWELL_MAX_MS));
      await scanForHalts(page);
    }

    // Brief settle for any in-flight responses
    await sleep(jitter(2500, 4500));

    console.log(`\ncaptured ${captures.length} responses across ${seenUrls.size} distinct path-shapes`);
    await writeFile(OUT_PATH, JSON.stringify({
      ts: new Date().toISOString(),
      total_captures: captures.length,
      distinct_path_shapes: [...seenUrls],
      captures,
    }, null, 2));
    console.log(`wrote ${OUT_PATH}`);
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(`discovery FAILED: ${e.stack || e.message}`); process.exit(1); });
