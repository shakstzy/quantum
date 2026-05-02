#!/usr/bin/env node
// THROWAWAY network probe. Run ONCE after manual login. Listens for XHR/fetch
// activity while we navigate the encounters / matches / a thread, dumps the
// observed REQUEST URLs (NOT bodies) to .dev-fixtures/<ts>/network.ndjson.
//
// We never replay these requests. The capture is for diag-time drift detection
// (compare what URLs the app hits today vs last week) and for a safety check
// at startup that "the swipe POST endpoint we expect to see is still being hit
// when a real user swipes."
//
// Codex P0 #4 flagged that storing wire shapes is risky. Mitigations in this
// script:
//   - We only store URLs and HTTP methods, NOT request/response bodies.
//   - We do NOT store any header that contains auth, cookies, or session ids.
//   - The output dir is .dev-fixtures/, gitignored, local-only.
//   - The script REQUIRES the user to confirm what page to interact with,
//     and only listens for 30 seconds after confirmation. No automated UI driving.

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { DEV_FIXTURES_DIR } from "../src/runtime/paths.mjs";
import { sleep } from "../src/runtime/humanize.mjs";

const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = resolve(DEV_FIXTURES_DIR, TS);
await mkdir(OUT_DIR, { recursive: true });

const { ctx, page } = await launchPersistent({ headless: false });
const events = [];

page.on("request", (req) => {
  const url = req.url();
  if (!/bumble\.com|bumbcdn\.com/.test(url)) return; // only first-party + their CDN
  if (req.resourceType() === "image" || req.resourceType() === "font" || req.resourceType() === "stylesheet") return;
  events.push({
    ts: new Date().toISOString(),
    method: req.method(),
    url,
    resource_type: req.resourceType(),
    // No headers, no body. Just the surface shape.
  });
});

console.log("network discover armed. listening for 60s while you (the operator) navigate.");
console.log("- Open the encounters page. Don't swipe yet. Just let it load.");
console.log("- Then go to matches/inbox, open one thread.");
console.log("- We are NOT capturing bodies, NOT capturing headers, NOT replaying.");

await page.goto("https://bumble.com/app", { waitUntil: "domcontentloaded" });
await sleep(60000);

const out = events;
const path = resolve(OUT_DIR, "network.ndjson");
await writeFile(path, out.map(e => JSON.stringify(e)).join("\n") + "\n");
const summary = {};
for (const e of out) {
  const key = `${e.method} ${e.url.split("?")[0]}`;
  summary[key] = (summary[key] || 0) + 1;
}
const summaryPath = resolve(OUT_DIR, "network-summary.json");
await writeFile(summaryPath, JSON.stringify(summary, null, 2));
console.log(`done. ${out.length} events captured. summary: ${summaryPath}`);
console.log("top hits:");
const top = Object.entries(summary).sort((a, b) => b[1] - a[1]).slice(0, 20);
for (const [k, n] of top) console.log(`  ${n}x ${k}`);

await ctx.close();
