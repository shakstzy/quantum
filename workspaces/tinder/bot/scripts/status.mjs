#!/usr/bin/env node
import { readCounters, loadCaps } from "../src/runtime/caps.mjs";
import { isHalted, readHaltReason } from "../src/runtime/halt.mjs";
import { listQueue } from "../src/runtime/queue.mjs";
import { listAllEntities } from "../src/runtime/entity-store.mjs";

const caps = await loadCaps();
const counters = await readCounters();
const halted = await isHalted();
const haltReason = halted ? await readHaltReason() : null;

const stages = ["drafts", "pending", "approved", "sent", "expired", "auto-sent"];
const queueCounts = {};
for (const s of stages) queueCounts[s] = (await listQueue(s)).length;

const entities = await listAllEntities();
const byCity = {};
const byStatus = {};
for (const e of entities) {
  byCity[e.meta.city || "?"] = (byCity[e.meta.city || "?"] || 0) + 1;
  byStatus[e.meta.status || "?"] = (byStatus[e.meta.status || "?"] || 0) + 1;
}

console.log("=== quantum-tinder status ===");
console.log(`halted: ${halted}${halted ? ` (${haltReason})` : ""}`);
console.log(`today swipes: ${counters.day.swipe || 0} / ${caps.swipes.per_day}`);
console.log(`hour msgs: ${counters.hour.message || 0} / ${caps.messages.per_hour}`);
console.log(`entities: ${entities.length}`);
console.log(`  by city: ${JSON.stringify(byCity)}`);
console.log(`  by status: ${JSON.stringify(byStatus)}`);
console.log(`queue:`);
for (const s of stages) console.log(`  ${s}: ${queueCounts[s]}`);
