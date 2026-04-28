#!/usr/bin/env node
import { readCounters, loadCaps } from "../src/runtime/caps.mjs";
import { isHalted, readHaltReason } from "../src/runtime/halt.mjs";
import { listQueue } from "../src/runtime/queue.mjs";

const caps = await loadCaps();
const counters = await readCounters();
const halted = await isHalted();
const haltReason = halted ? await readHaltReason() : null;

const stages = ["drafts", "pending", "approved", "sent", "expired", "auto-sent"];
const queueCounts = {};
for (const s of stages) queueCounts[s] = (await listQueue(s)).length;

console.log("=== quantum-tinder status ===");
console.log(`halted: ${halted}${halted ? ` (${haltReason})` : ""}`);
console.log(`today swipes: ${counters.day.swipe || 0} / ${caps.swipes.per_day}`);
console.log(`hour msgs: ${counters.hour.message || 0} / ${caps.messages.per_hour}`);
console.log(`queue:`);
for (const s of stages) console.log(`  ${s}: ${queueCounts[s]}`);
