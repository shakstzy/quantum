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

  // CODEX-R1-P1-12 + R2-P0-1: only queue when role-eligible. If she hasn't
  // messaged AND there's no opening_move, we cannot send through Bumble UI.
  // Skip the entity entirely. (Future: off-platform reengage via iMessage
  // workspace, NOT through bumble's send.mjs.)
  const sheJustSpoke = (ent.conversation || "").includes("**her**");
  const hasOpeningMove = /^- opening_move:\s*/m.test(ent.profile || "");
  if (!sheJustSpoke && !hasOpeningMove) continue; // role-ineligible
  const intent = sheJustSpoke ? "reply" : "opening_move_response";

  // Skeleton: queue a placeholder pending item. Real drafting wired below but
  // commented out until we've live-tested send.mjs at least once.
  // const { draftId, text, lint } = await draftMessage({ context: { ...parsed, imessage_summary }, intent });
  const draftId = randomUUID();
  const text = "(draft placeholder - decide.mjs full body wires after first live send)";
  const meta = {
    id: draftId,
    slug: ent.slug,
    match_id: ent.meta.match_id,
    intent,
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
