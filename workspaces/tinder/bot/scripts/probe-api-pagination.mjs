#!/usr/bin/env node
// Minimal proof-of-concept: replay ONE paginated /v2/matches call within
// the existing browser session and verify it returns more matches without
// tripping detection.
//
// Total call shape:
//   React client (natural):  GET /v2/matches?count=60&message=0 + ...&message=1
//   Us (replay, 1 call):     GET /v2/matches?count=60&message=1&page_token=<cursor>
//
// Uses page.context().request which inherits the browser's exact cookies,
// UA, TLS fingerprint — indistinguishable from the React client's own
// fetch. No raw HTTP. No new headers. No different origin.
//
// Halt-safe before + after. Single-strike breaker on any 401/403/429.

import { writeFile } from "node:fs/promises";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";
import { scanForHalts } from "../src/runtime/detection.mjs";

const OUT_PATH = "/tmp/tinder-pagination-probe.json";
const INITIAL_DWELL_MIN_MS = 4000;
const INITIAL_DWELL_MAX_MS = 6500;
const PRE_REPLAY_GAP_MIN_MS = 12000;
const PRE_REPLAY_GAP_MAX_MS = 18000;

async function main() {
  await abortIfHalted();
  console.log("MINIMAL POC: pagination via page.context().request replay");
  console.log("- 0 raw HTTP. 0 new origins. Same browser session as React client.");
  console.log(`- output: ${OUT_PATH}\n`);

  const { ctx, page } = await launchPersistent({ headless: false });

  let firstPageBody = null;
  let firstPageUrl = null;
  page.on("response", async (response) => {
    try {
      const url = response.url();
      // Match the message=1 (with-messages) initial page only — that's where
      // the cursor field is most likely to appear.
      if (!/api\.gotinder\.com\/v2\/matches\?/.test(url)) return;
      if (!url.includes("message=1")) return;
      if (firstPageBody) return; // first one only
      const text = await response.text();
      firstPageUrl = url;
      try {
        firstPageBody = JSON.parse(text);
      } catch (e) {
        firstPageBody = { _parseError: e.message, _len: text.length };
      }
      console.log(`captured initial /v2/matches?message=1 response (len=${text.length})`);
    } catch (e) {
      console.error(`response handler: ${e.message}`);
    }
  });

  try {
    console.log("nav -> /app/matches ...");
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    await sleep(jitter(INITIAL_DWELL_MIN_MS, INITIAL_DWELL_MAX_MS));
    await scanForHalts(page);

    if (!firstPageBody) {
      console.error("did not capture initial /v2/matches?message=1 response");
      process.exit(2);
    }

    const data = firstPageBody.data || {};
    console.log(`\ndata.* keys: ${Object.keys(data).join(", ")}`);
    const matches1 = Array.isArray(data.matches) ? data.matches : [];
    console.log(`page 1 match count: ${matches1.length}`);
    if (matches1.length > 0) {
      console.log(`page 1 first/last created_date: ${matches1[0].created_date} / ${matches1[matches1.length - 1].created_date}`);
    }

    // Hunt for cursor field. Tinder API historically uses `next_page_token`
    // but also supports `last_activity_date` as a cursor.
    const cursor =
      data.next_page_token
      ?? data.page_token
      ?? data.next_token
      ?? null;
    console.log(`cursor field: next_page_token=${data.next_page_token} page_token=${data.page_token} next_token=${data.next_token}`);

    if (!cursor) {
      console.warn("\nno explicit cursor field — trying last_activity_date based pagination");
    }

    const ids1 = new Set(matches1.map(m => m._id || m.id).filter(Boolean));

    // Pace the replay: wait 12-18s, scan for halts, then fire 1 paginated call
    const gap = jitter(PRE_REPLAY_GAP_MIN_MS, PRE_REPLAY_GAP_MAX_MS);
    console.log(`\nidling ${gap}ms before replay (let React client settle)...`);
    await sleep(gap);
    await scanForHalts(page);

    // Construct page-2 URL using the same param set the React client used,
    // plus page_token if found, else fall back to last_activity_date cursor.
    const url1 = new URL(firstPageUrl);
    const params = new URLSearchParams(url1.search);
    if (cursor) {
      params.set("page_token", cursor);
    } else if (matches1.length > 0) {
      // Fallback: use the oldest last_activity_date as the cursor
      const oldest = matches1[matches1.length - 1].last_activity_date;
      if (oldest) params.set("last_activity_date", oldest);
    }
    const url2 = `${url1.origin}${url1.pathname}?${params.toString()}`;
    console.log(`\nreplay GET ${url2}`);

    const t0 = Date.now();
    const resp2 = await page.context().request.get(url2);
    const elapsed = Date.now() - t0;
    const status2 = resp2.status();
    console.log(`replay response: status=${status2} elapsed=${elapsed}ms`);

    if (status2 === 401 || status2 === 403 || status2 === 429) {
      console.error(`!! BREAKER: status ${status2} on replay — DETECTION SIGNAL`);
      console.error(`   touching ~/.quantum/tinder/.halt — bot run halted`);
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(`${process.env.HOME}/.quantum/tinder`, { recursive: true });
      await writeFile(`${process.env.HOME}/.quantum/tinder/.halt`,
        `pagination-probe got status=${status2} at ${new Date().toISOString()}\n`);
      await ctx.close();
      process.exit(3);
    }

    const body2 = await resp2.json();
    const matches2 = Array.isArray(body2?.data?.matches) ? body2.data.matches : [];
    const ids2 = new Set(matches2.map(m => m._id || m.id).filter(Boolean));
    const newOnPage2 = [...ids2].filter(id => !ids1.has(id));

    console.log(`\npage 2 match count: ${matches2.length}`);
    console.log(`page 2 unique-vs-page-1: ${newOnPage2.length}`);
    if (matches2.length > 0) {
      console.log(`page 2 first/last created_date: ${matches2[0]?.created_date} / ${matches2[matches2.length - 1]?.created_date}`);
    }
    console.log(`page 2 next_page_token: ${body2?.data?.next_page_token}`);

    await scanForHalts(page);

    await writeFile(OUT_PATH, JSON.stringify({
      ts: new Date().toISOString(),
      page1: {
        url: firstPageUrl,
        count: matches1.length,
        ids: [...ids1],
        cursor_keys_present: {
          next_page_token: !!data.next_page_token,
          page_token: !!data.page_token,
          next_token: !!data.next_token,
        },
        oldest_last_activity_date: matches1[matches1.length - 1]?.last_activity_date,
      },
      page2: {
        url: url2,
        status: status2,
        elapsed_ms: elapsed,
        count: matches2.length,
        new_vs_page1: newOnPage2.length,
        next_page_token: body2?.data?.next_page_token ?? null,
      },
      union: ids1.size + newOnPage2.length,
    }, null, 2));
    console.log(`\nwrote ${OUT_PATH}`);
    console.log(`\nUNION (page1 + page2 unique): ${ids1.size + newOnPage2.length}`);
    console.log(`\n✅ pragmatic replay worked. no breaker fired.`);
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(`probe FAILED: ${e.stack || e.message}`); process.exit(1); });
