#!/usr/bin/env node
import { launchPersistent } from "../src/runtime/profile.mjs";
import { swipeSession } from "../src/bumble/swipe.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { shouldSkipDay, readCounters } from "../src/runtime/caps.mjs";
import { logSession } from "../src/runtime/logger.mjs";

await abortIfHalted();
if (await shouldSkipDay()) { console.log("skip_day:true"); process.exit(0); }

const counters = await readCounters();
console.log("counters:", JSON.stringify(counters));

const { ctx, page } = await launchPersistent({ headless: false });
try {
  const result = await swipeSession(page);
  await logSession({ event: "swipe_session", ...result });
  console.log("session_done:", JSON.stringify(result));
} finally {
  await ctx.close();
}
