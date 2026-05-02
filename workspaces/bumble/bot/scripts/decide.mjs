#!/usr/bin/env node
// Walk every entity, triage by 24h expiry, draft replies via `claude -p`,
// queue to 04-outbound/. Sketch.

import { abortIfHalted } from "../src/runtime/halt.mjs";
import { listAllEntities } from "../src/runtime/entity-store.mjs";
import { sortByExpiry, expiryTriage } from "../src/runtime/expiry.mjs";
import { findPhoneByName, lastImessageActivity, summarizeImessage, recommendChannel } from "../src/runtime/imessage-xref.mjs";
import { draftMessage } from "../src/drafting/draft.mjs";
import { writeQueueItem, expireOldPending } from "../src/runtime/queue.mjs";
import { randomUUID } from "node:crypto";

await abortIfHalted();
await expireOldPending();

const entities = await listAllEntities();
const triaged = sortByExpiry(entities);

// CODEX-R1-P1-13: dedupe guard. Don't queue a new draft if there's already a
// drafts/, pending/, or approved/ item for this slug. Otherwise repeated cron
// runs accumulate duplicate drafts.
const { listQueue } = await import("../src/runtime/queue.mjs");
const inFlight = new Set();
for (const stage of ["drafts", "pending", "approved"]) {
  for (const item of await listQueue(stage)) {
    if (item.meta.slug) inFlight.add(item.meta.slug);
  }
}

console.log(`decide: ${entities.length} entities; expiry buckets:`);
const counts = {};
for (const e of entities) {
  const b = expiryTriage(e.meta.expires_at).bucket;
  counts[b] = (counts[b] || 0) + 1;
}
console.log(JSON.stringify(counts, null, 2));

let drafted = 0;
for (const ent of triaged) {
  const triage = expiryTriage(ent.meta.expires_at);
  if (triage.bucket === "expired") continue;
  if (ent.meta.status === "expired" || ent.meta.status === "unmatched") continue;
  if (inFlight.has(ent.slug)) continue; // already has a pending draft

  // Side-channel cross-ref (best-effort; only fires if last name is known)
  let imessage_summary = null;
  if (ent.meta.phone) {
    try {
      const act = await lastImessageActivity(ent.meta.phone);
      imessage_summary = summarizeImessage(act);
    } catch { /* skip */ }
  }

  // CODEX-R3-P0-3: role-eligibility = LAST message is from her, or thread is
  // empty AND opening_move recorded. The previous "any historical **her**" check
  // was true forever after first inbound and permitted re-drafting after each
  // queued item left the in-flight set.
  const lines = (ent.conversation || "").split("\n").filter(l => l.startsWith("**her**") || l.startsWith("**you**"));
  const lastDir = lines.length ? (lines[lines.length - 1].startsWith("**her**") ? "in" : "out") : null;
  const hasOpening = /^- opening_move:\s*/m.test(ent.profile || "");
  const isReply = lastDir === "in";
  const isOpening = lastDir == null && hasOpening;
  if (!isReply && !isOpening) continue; // role-ineligible
  const intent = isReply ? "reply" : "opening_move_response";

  // CODEX-R3-P1: draft placeholder is dangerous if anything ever moves it to
  // approved/. Mark it with `placeholder: true` so send.mjs (and any HITL UI)
  // can refuse to send placeholder drafts.
  const draftId = randomUUID();
  const text = "(draft placeholder - decide.mjs full body wires after first live send)";
  const meta = {
    id: draftId,
    slug: ent.slug,
    match_id: ent.meta.match_id,
    intent,
    placeholder: true,
    expires: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    created: new Date().toISOString(),
    triage: triage.bucket,
    hours_left: triage.hoursLeft?.toFixed(2) ?? null,
  };
  await writeQueueItem({
    stage: "drafts",
    id: draftId,
    meta,
    body: `## Drafted reply\n${text}\n`,
  });
  drafted += 1;
}
console.log(`queued: ${drafted} drafts`);
