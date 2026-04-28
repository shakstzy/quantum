#!/usr/bin/env node
// Reads recent matches + threads from raw/, cross-refs iMessage, drafts replies, queues to outbound.
// Routing rule (matches CLAUDE.md):
//   imessage_active  -> skip Tinder (she's responsive on text)
//   tinder_reengage  -> draft re-engagement (auto if lint passes)
//   tinder_only      -> draft normal reply (HITL unless first-message + lint passes)

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { RAW_MATCHES, RAW_THREADS } from "../src/runtime/paths.mjs";
import { findPhoneByName, lastImessageActivity, summarizeImessage, recommendChannel } from "../src/runtime/imessage-xref.mjs";
import { draftMessage } from "../src/drafting/draft.mjs";
import { writeQueueItem, expireOldPending, listQueue } from "../src/runtime/queue.mjs";
import { notifySelf } from "../src/runtime/notifier.mjs";
import { logSession } from "../src/runtime/logger.mjs";

const PENDING_NOTIFY_THRESHOLD = 3;
const HITL_EXPIRY_HOURS = 6;

async function readShards(dir) {
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const shards = files.filter(f => /^\d{4}-\d{2}\.ndjson$/.test(f)).sort().reverse().slice(0, 2);
  const rows = [];
  for (const f of shards) {
    const text = await readFile(resolve(dir, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return rows;
}

async function buildMatchView() {
  const matchRows = await readShards(RAW_MATCHES);
  const threadRows = await readShards(RAW_THREADS);

  const latestByMatch = new Map();
  for (const row of matchRows) {
    if (!row.match_id) continue;
    const cur = latestByMatch.get(row.match_id);
    if (!cur || (row.ts || "") > (cur.ts || "")) latestByMatch.set(row.match_id, row);
  }

  const threadByMatch = new Map();
  for (const row of threadRows) {
    if (!row.match_id) continue;
    if (!threadByMatch.has(row.match_id)) threadByMatch.set(row.match_id, []);
    threadByMatch.get(row.match_id).push(row);
  }

  const out = [];
  for (const [matchId, profile] of latestByMatch.entries()) {
    out.push({ matchId, profile, thread: threadByMatch.get(matchId) || [] });
  }
  return out;
}

function inferIntent(thread) {
  if (!thread.length) return "opener";
  const lastOut = [...thread].reverse().find(m => m.direction === "out");
  const lastIn = [...thread].reverse().find(m => m.direction === "in");
  if (!lastIn) return "opener";
  if (!lastOut) return "first_reply_back";
  if (thread.length >= 6) return "move_toward_number_or_date";
  return "natural_reply";
}

async function main() {
  await expireOldPending();
  const views = await buildMatchView();
  const existingPending = new Set((await listQueue("pending")).map(p => p.meta.match_id));
  const existingApproved = new Set((await listQueue("approved")).map(p => p.meta.match_id));

  let queued = 0;
  let autoSent = 0;
  let hitl = 0;
  let skipped = 0;

  for (const v of views) {
    if (existingPending.has(v.matchId) || existingApproved.has(v.matchId)) { skipped += 1; continue; }
    const lastMsg = v.thread[v.thread.length - 1];
    if (lastMsg && lastMsg.direction === "out") { skipped += 1; continue; }

    const phone = await findPhoneByName(v.profile.name);
    const activity = phone ? await lastImessageActivity(phone) : null;
    const channel = recommendChannel(activity);

    if (channel === "imessage_active") {
      skipped += 1;
      continue;
    }

    const intent = channel === "tinder_reengage" ? "reengage_after_imessage_silence" : inferIntent(v.thread);
    const context = {
      name: v.profile.name,
      age: v.profile.age,
      bio: v.profile.bio,
      interests: v.profile.interests,
      schools: v.profile.schools,
      jobs: v.profile.jobs,
      thread: v.thread.map(m => ({ direction: m.direction, text: m.text })),
      imessage_summary: summarizeImessage(activity),
    };

    let drafted;
    try { drafted = await draftMessage({ context, intent }); }
    catch (e) { console.error(`draft_failed ${v.matchId}: ${e.message}`); skipped += 1; continue; }

    const autoEligibleIntent = intent === "opener" || intent === "reengage_after_imessage_silence";
    const auto = autoEligibleIntent && drafted.lint.pass;
    const stage = auto ? "approved" : "pending";
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${v.matchId}`;
    const meta = {
      match_id: v.matchId,
      person: v.profile.name || "?",
      created: new Date().toISOString(),
      draft_id: drafted.draftId,
      lint_pass: drafted.lint.pass,
      lint_issues: drafted.lint.issues,
      mode: auto ? "auto" : "hitl",
      intent,
      channel,
      expires: auto ? "" : new Date(Date.now() + HITL_EXPIRY_HOURS * 3600000).toISOString(),
    };
    const body = [
      `## Thread context (last 6 messages)`,
      ...v.thread.slice(-6).map(m => `**${m.direction === "out" ? "you" : "her"}** ${m.text}`),
      "",
      `## Side-channel`,
      context.imessage_summary,
      "",
      `## Drafted reply`,
      drafted.text,
      "",
      `## Lint`,
      `pass=${drafted.lint.pass}; issues=${(drafted.lint.issues || []).join(", ") || "none"}`,
    ].join("\n");

    await writeQueueItem({ stage, id, meta, body });
    queued += 1;
    if (auto) autoSent += 1; else hitl += 1;
  }

  const pendingCount = (await listQueue("pending")).length;
  if (pendingCount >= PENDING_NOTIFY_THRESHOLD) {
    await notifySelf(`Tinder: ${pendingCount} drafts waiting for you to approve. Run: ./bin/tinder pending`);
  }

  await logSession({ event: "decide", queued, auto: autoSent, hitl, skipped, pending_total: pendingCount });
  console.log(JSON.stringify({ queued, auto: autoSent, hitl, skipped, pending_total: pendingCount }));
}

await main().catch(e => { console.error(e); process.exit(1); });
