#!/usr/bin/env node
// One-shot: open Neha's thread and re-scrape her profile so the rich
// extraction lands in her entity file. Throwaway after smoke test.

import { launchPersistent } from "../src/runtime/profile.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { scrapeThread } from "../src/bumble/matches.mjs";

const NEHA_MATCH_ID = "zAhMACjIzNjkxNjA2MDgIe-K7hQAAAAAgiSu1SzK_cg-cL8re0K1Bu-K6WKVPnO95ba0zq3OJF68";

await abortIfHalted();

const { ctx, page } = await launchPersistent({ headless: false });
try {
  const r = await scrapeThread(page, NEHA_MATCH_ID, { name: "Neha" });
  console.log(JSON.stringify(r, null, 2));
} finally {
  await ctx.close();
}
