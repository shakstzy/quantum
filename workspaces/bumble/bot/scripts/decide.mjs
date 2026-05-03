#!/usr/bin/env node
// Walk every entity, triage by 24h expiry, draft replies via `claude -p`,
// queue to 04-outbound/.
//
// CODEX-R7-P2-5: previously a placeholder ("decide.mjs full body wires after
// first live send"). Now wired end-to-end: builds context from the entity
// markdown, calls draftMessage(), runs the voice-lint, and writes the real
// drafted text to drafts/. send.mjs's placeholder guard still trips if a draft
// somehow lacks `placeholder: false`, so we explicitly mark drafts here.

import { abortIfHalted } from "../src/runtime/halt.mjs";
import { listAllEntities, profileFromMarkdown, parseLatestDiffJsonBlock } from "../src/runtime/entity-store.mjs";
import { sortByExpiry, expiryTriage } from "../src/runtime/expiry.mjs";
import { lastImessageActivity, summarizeImessage } from "../src/runtime/imessage-xref.mjs";
import { draftMessage } from "../src/drafting/draft.mjs";
import { writeQueueItem } from "../src/runtime/queue.mjs";
import { listQueue } from "../src/runtime/queue.mjs";

await abortIfHalted();

// Best-effort cleanup of stale pending drafts (>6h old).
const { expireOldPending } = await import("../src/runtime/queue.mjs");
await expireOldPending();

const entities = await listAllEntities();
const triaged = sortByExpiry(entities);

// GEMINI-P0: include "ambiguous" stage in the in-flight set. Otherwise a
// quarantined post-click failure (clicked send but verification failed) would
// be re-drafted on the next decide cron AND get re-sent on the next send cron,
// causing a double-text. Ambiguous items must be operator-resolved before
// re-drafting; treat them as in-flight so decide skips them.
// Also walk OUTBOUND_DIR for the legacy ambiguous/ directory directly,
// since it may not be a registered queue stage yet.
import { readdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { OUTBOUND_DIR } from "../src/runtime/paths.mjs";

const inFlight = new Set();
for (const stage of ["drafts", "pending", "approved"]) {
  for (const item of await listQueue(stage)) {
    if (item.meta.slug) inFlight.add(item.meta.slug);
  }
}
// Walk 04-outbound/ambiguous/ directly (not yet a first-class stage in queue.mjs).
try {
  const ambDir = resolvePath(OUTBOUND_DIR, "ambiguous");
  const ambFiles = await readdir(ambDir).catch(() => []);
  for (const f of ambFiles) {
    if (!f.endsWith(".md")) continue;
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(resolvePath(ambDir, f), "utf8").catch(() => "");
    const slugM = text.match(/^slug:\s*(\S+)/m);
    if (slugM) inFlight.add(slugM[1]);
  }
} catch { /* skip */ }

console.log(`decide: ${entities.length} entities; expiry buckets:`);
const counts = {};
for (const e of entities) {
  const b = expiryTriage(e.meta.expires_at).bucket;
  counts[b] = (counts[b] || 0) + 1;
}
console.log(JSON.stringify(counts, null, 2));

// CLI flags: --slug=<x> drafts only that entity; --max=<n> limits drafts/run.
const argv = process.argv.slice(2);
const flag = (k) => {
  const f = argv.find(a => a.startsWith(`--${k}=`));
  return f ? f.slice(k.length + 3) : null;
};
const onlySlug = flag("slug");
const maxDrafts = parseInt(flag("max") || "5", 10);

function parseThread(conversationMd) {
  const out = [];
  for (const line of (conversationMd || "").split("\n")) {
    const m = line.match(/^\*\*(her|you)\*\*\s+\S+\s+\S+\s+(.*)$/);
    if (!m) continue;
    out.push({ direction: m[1] === "you" ? "out" : "in", text: m[2] });
  }
  return out;
}

function lastDirection(thread) {
  if (!thread.length) return null;
  return thread[thread.length - 1].direction === "out" ? "out" : "in";
}

let drafted = 0;
for (const ent of triaged) {
  if (drafted >= maxDrafts) break;
  if (onlySlug && ent.slug !== onlySlug) continue;

  const triage = expiryTriage(ent.meta.expires_at);
  if (triage.bucket === "expired") continue;
  if (ent.meta.status === "expired" || ent.meta.status === "unmatched") continue;
  if (inFlight.has(ent.slug)) continue;

  // Role eligibility: last message must be hers, or thread empty + opening_move set.
  const thread = parseThread(ent.conversation);
  const lastDir = lastDirection(thread);
  const profile = profileFromMarkdown(ent.profile);
  const hasOpening = !!profile.opening_move;
  const isReply = lastDir === "in";
  const isOpening = lastDir == null && hasOpening;
  if (!isReply && !isOpening) continue;
  const intent = isReply ? "reply" : "opening_move_response";

  // Side-channel iMessage check (best-effort).
  let imessage_summary = null;
  if (ent.meta.phone) {
    try {
      const act = await lastImessageActivity(ent.meta.phone);
      imessage_summary = summarizeImessage(act);
    } catch { /* skip */ }
  }

  const profile_diff = parseLatestDiffJsonBlock(ent.profile_changes);
  const context = {
    name: ent.meta.first_name || null,
    age: profile.age ?? null,
    bio: profile.bio || null,
    looking_for: profile.looking_for || null,
    opening_move: profile.opening_move || null,
    interests: profile.interests || [],
    basics: profile.basics || {},
    lifestyle: profile.lifestyle || {},
    lifestyle_badges: profile.lifestyle_badges || [],
    schools: profile.schools || [],
    jobs: profile.jobs || [],
    height: profile.height || null,
    lives_in: profile.lives_in || null,
    hometown: profile.hometown || null,
    prompts: profile.prompts || [],
    visual: ent.visual || null,
    thread,
    imessage_summary,
    profile_diff,
  };

  console.log(`drafting for ${ent.slug} (intent=${intent}, hours_left=${triage.hoursLeft?.toFixed(2) ?? "?"})...`);
  let draft;
  try {
    draft = await draftMessage({ context, intent });
  } catch (e) {
    console.error(`draftMessage failed for ${ent.slug}: ${e.message}`);
    continue;
  }

  const meta = {
    id: draft.draftId,
    slug: ent.slug,
    match_id: ent.meta.match_id,
    intent,
    placeholder: false,
    lint_pass: !!draft.lint?.pass,
    lint_issues: JSON.stringify(draft.lint?.issues || []),
    expires: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    created: new Date().toISOString(),
    triage: triage.bucket,
    hours_left: triage.hoursLeft?.toFixed(2) ?? null,
  };

  await writeQueueItem({
    stage: "drafts",
    id: draft.draftId,
    meta,
    body: `## Drafted reply\n${draft.text}\n\n## Lint\n- pass: ${draft.lint?.pass}\n- issues: ${(draft.lint?.issues || []).join(", ") || "none"}\n`,
  });
  drafted += 1;
  console.log(`  drafted: ${JSON.stringify(draft.text)} (lint=${draft.lint?.pass ? "pass" : draft.lint.issues.join(",")})`);
}

console.log(`queued: ${drafted} drafts`);
