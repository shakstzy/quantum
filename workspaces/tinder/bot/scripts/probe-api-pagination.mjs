#!/usr/bin/env node
// PARANOID pagination probe.
//
// Account is close to a ban. Hard rules:
//   - Max 3 replay attempts total in this run
//   - 90s minimum gap between every replay
//   - Hard breaker on 401 / 403 / 429 (writes ~/.quantum/tinder/.halt)
//   - Hard breaker if the same status code appears 2x in a row
//   - Stop immediately on first 200
//   - Stop immediately on any network error
//
// Each variant is meaningfully different — we are NOT spam-retrying
// the same URL.
//
// Variants (in likely-success order):
//   A: ?count=60&message=1&page_token=<token>  (drop include_conversations + is_tinder_u + locale)
//   B: ?<original-params>&page_token=<token>   (kitchen-sink, what we already tried)
//   C: ?count=60&message=1&last_activity_date=<iso-decoded>  (older API form)

import { writeFile, mkdir } from "node:fs/promises";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";
import { scanForHalts } from "../src/runtime/detection.mjs";

const OUT_PATH = "/tmp/tinder-pagination-probe.json";
const HALT_PATH = `${process.env.HOME}/.quantum/tinder/.halt`;
const INITIAL_DWELL_MIN_MS = 4000;
const INITIAL_DWELL_MAX_MS = 6500;
const INTER_REPLAY_MIN_MS = 90000;   // 90s minimum
const INTER_REPLAY_MAX_MS = 120000;  // up to 2 min
const MAX_ATTEMPTS = 3;
const BAN_STATUSES = new Set([401, 403, 429]);

async function writeHalt(reason) {
  await mkdir(`${process.env.HOME}/.quantum/tinder`, { recursive: true });
  await writeFile(HALT_PATH, `pagination-probe: ${reason} at ${new Date().toISOString()}\n`);
  console.error(`!! HALT WRITTEN: ${reason}`);
}

async function main() {
  await abortIfHalted();
  console.log("PARANOID PAGINATION PROBE");
  console.log(`- max ${MAX_ATTEMPTS} attempts, ≥90s between each, hard breaker on 401/403/429`);
  console.log(`- output: ${OUT_PATH}\n`);

  const { ctx, page } = await launchPersistent({ headless: false });

  let firstPageBody = null;
  let firstPageUrl = null;
  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!/api\.gotinder\.com\/v2\/matches\?/.test(url)) return;
      if (!url.includes("message=1")) return;
      if (firstPageBody) return;
      const text = await response.text();
      firstPageUrl = url;
      try { firstPageBody = JSON.parse(text); }
      catch (e) { firstPageBody = { _parseError: e.message }; }
      console.log(`captured initial /v2/matches?message=1 response (len=${text.length})`);
    } catch (e) { console.error(`response handler: ${e.message}`); }
  });

  const attempts = [];
  let lastStatus = null;

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
    const matches1 = Array.isArray(data.matches) ? data.matches : [];
    const ids1 = new Set(matches1.map(m => m._id || m.id).filter(Boolean));
    const cursor = data.next_page_token ?? null;
    const oldestLAD = matches1[matches1.length - 1]?.last_activity_date ?? null;

    console.log(`page 1: ${matches1.length} matches`);
    console.log(`  next_page_token: ${cursor}`);
    console.log(`  oldest last_activity_date: ${oldestLAD}`);

    if (!cursor && !oldestLAD) {
      console.error("no cursor and no last_activity_date — cannot paginate");
      process.exit(2);
    }

    // Build variants
    const url1 = new URL(firstPageUrl);
    const variants = [];
    if (cursor) {
      // A: minimal — just count, message, page_token
      const a = new URL(url1.origin + url1.pathname);
      a.searchParams.set("count", "60");
      a.searchParams.set("message", "1");
      a.searchParams.set("page_token", cursor);
      variants.push({ label: "A_minimal_page_token", url: a.toString() });

      // B: kitchen-sink — original params + page_token (what we tried)
      const b = new URL(url1);
      b.searchParams.set("page_token", cursor);
      variants.push({ label: "B_full_page_token", url: b.toString() });
    }
    if (oldestLAD) {
      // C: legacy last_activity_date form
      const c = new URL(url1.origin + url1.pathname);
      c.searchParams.set("count", "60");
      c.searchParams.set("message", "1");
      c.searchParams.set("last_activity_date", oldestLAD);
      variants.push({ label: "C_last_activity_date", url: c.toString() });
    }

    let success = null;
    let pagedMatches = [];
    let pagedNewIds = new Set();

    for (let i = 0; i < Math.min(MAX_ATTEMPTS, variants.length); i++) {
      const v = variants[i];
      const gap = jitter(INTER_REPLAY_MIN_MS, INTER_REPLAY_MAX_MS);
      console.log(`\nidling ${(gap / 1000).toFixed(0)}s before attempt ${i + 1}/${variants.length} (${v.label})...`);
      await sleep(gap);
      await scanForHalts(page);

      console.log(`attempt ${i + 1}: ${v.label}`);
      console.log(`  GET ${v.url}`);

      let status, body, parseErr, networkErr;
      const t0 = Date.now();
      try {
        const resp = await page.context().request.get(v.url);
        status = resp.status();
        try { body = await resp.json(); }
        catch (e) {
          parseErr = e.message;
          try { body = await resp.text(); }
          catch { /* ignore */ }
        }
      } catch (e) {
        networkErr = e.message;
      }
      const elapsed = Date.now() - t0;

      const a = { ...v, status, elapsed_ms: elapsed, parseErr, networkErr };
      attempts.push(a);
      console.log(`  -> status=${status} elapsed=${elapsed}ms${parseErr ? ` parseErr=${parseErr}` : ""}${networkErr ? ` net=${networkErr}` : ""}`);

      // Hard breakers
      if (networkErr) {
        console.error("network error — stopping immediately, NOT writing halt (no signal from server)");
        break;
      }
      if (BAN_STATUSES.has(status)) {
        await writeHalt(`got ${status} on ${v.label}`);
        break;
      }
      if (status >= 500) {
        console.error(`server 5xx (${status}) — stopping, NOT writing halt (server-side issue)`);
        break;
      }
      if (status === lastStatus && i > 0) {
        console.error(`same status ${status} as previous attempt — stopping (avoid look-bot-spam)`);
        break;
      }
      lastStatus = status;

      if (status === 200) {
        const m = Array.isArray(body?.data?.matches) ? body.data.matches : [];
        pagedMatches = m;
        pagedNewIds = new Set(m.map(x => x._id || x.id).filter(Boolean));
        const newCount = [...pagedNewIds].filter(id => !ids1.has(id)).length;
        console.log(`  ✅ 200 with ${m.length} matches (${newCount} new vs page 1)`);
        success = v.label;
        a.matchCount = m.length;
        a.newVsPage1 = newCount;
        a.nextPageToken = body?.data?.next_page_token ?? null;
        break;
      }

      // 400 = malformed; safe to try next variant after the 90s+ gap above
      console.log(`  status ${status} — will try next variant`);
    }

    await scanForHalts(page);

    const result = {
      ts: new Date().toISOString(),
      page1: {
        url: firstPageUrl,
        count: matches1.length,
        cursor,
        oldestLAD,
      },
      attempts,
      success_variant: success,
      pagedCount: pagedMatches.length,
      newVsPage1: [...pagedNewIds].filter(id => !ids1.has(id)).length,
      union: ids1.size + [...pagedNewIds].filter(id => !ids1.has(id)).length,
    };
    await writeFile(OUT_PATH, JSON.stringify(result, null, 2));
    console.log(`\nwrote ${OUT_PATH}`);
    if (success) {
      console.log(`\n✅ pagination works via variant: ${success}`);
      console.log(`   page1=${matches1.length} + page2=${pagedMatches.length} (${result.newVsPage1} new) → union ${result.union}`);
    } else {
      console.log(`\n❌ no variant returned 200; cap stays at page-1 size`);
    }
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(`probe FAILED: ${e.stack || e.message}`); process.exit(1); });
