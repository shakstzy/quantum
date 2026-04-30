#!/usr/bin/env node
// Report rate-limit budget, halt status, last action.

import { readCounters } from "../src/runtime/caps.mjs";
import { isHalted, readHaltReason } from "../src/runtime/halt.mjs";
import { tailLog } from "../src/runtime/logger.mjs";

const halted = await isHalted();
const reason = halted ? await readHaltReason() : "";
const counters = await readCounters();
const tail = await tailLog(10);

const out = {
  halted,
  halt_reason: halted ? reason : null,
  active_hours_now: counters._active_hours_now,
  daily: Object.fromEntries(
    Object.entries(counters)
      .filter(([k]) => !k.startsWith("_"))
      .map(([k, v]) => [k, `${v.used}/${v.cap}${v.week_cap ? ` (week ${v.week_used}/${v.week_cap})` : ""}`])
  ),
  recent_actions: tail.map((r) => ({ ts: r.ts, action: r.action, target: r.target, ok: r.success !== false })),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  if (out.halted) console.log(`HALTED: ${out.halt_reason}`);
  console.log(`Active hours now: ${out.active_hours_now ? "yes" : "no"}`);
  console.log("Daily budgets:");
  for (const [k, v] of Object.entries(out.daily)) console.log(`  ${k.padEnd(28)} ${v}`);
  console.log("\nRecent actions:");
  for (const r of out.recent_actions) console.log(`  ${r.ts}  ${r.action.padEnd(20)} ${r.ok ? "OK " : "ERR"}  ${r.target ?? ""}`);
}
