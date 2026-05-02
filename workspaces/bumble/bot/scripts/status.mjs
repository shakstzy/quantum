#!/usr/bin/env node
// Counters, queue sizes, halt state, entity counts.
import { readCounters } from "../src/runtime/caps.mjs";
import { isHalted, readHaltReason } from "../src/runtime/halt.mjs";
import { listQueue } from "../src/runtime/queue.mjs";
import { listAllEntities } from "../src/runtime/entity-store.mjs";
import { expiryTriage } from "../src/runtime/expiry.mjs";

const counters = await readCounters();
const halt = await isHalted();
const haltReason = halt ? await readHaltReason() : null;

const stages = ["drafts", "pending", "approved", "sent", "expired", "auto-sent"];
const queueCounts = {};
for (const s of stages) queueCounts[s] = (await listQueue(s)).length;

const entities = await listAllEntities();
const byCity = {};
const byStatus = {};
const expiryBuckets = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, expired: 0 };
for (const e of entities) {
  const city = e.meta.city || "unknown";
  byCity[city] = (byCity[city] || 0) + 1;
  const status = e.meta.status || "unknown";
  byStatus[status] = (byStatus[status] || 0) + 1;
  const bucket = expiryTriage(e.meta.expires_at).bucket;
  expiryBuckets[bucket] = (expiryBuckets[bucket] || 0) + 1;
}

const out = {
  halt: halt ? { halted: true, reason: haltReason } : { halted: false },
  counters_today: counters,
  queue: queueCounts,
  entities: { total: entities.length, by_city: byCity, by_status: byStatus, by_expiry: expiryBuckets },
};
console.log(JSON.stringify(out, null, 2));
