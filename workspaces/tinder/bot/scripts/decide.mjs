#!/usr/bin/env node
// Walks every entity at raw/tinder/<slug>.md, decides what to do, drafts replies,
// queues to outbound. Routing:
//   imessage_active  -> skip (she's responsive on text)
//   tinder_reengage  -> draft re-engagement (auto if lint passes)
//   tinder_only      -> draft normal reply (HITL unless first-message + lint passes)

import { listAllEntities, appendOutboundEvent, parseLatestDiffJsonBlock } from "../src/runtime/entity-store.mjs";
import { findPhoneByName, lastImessageActivity, summarizeImessage, recommendChannel } from "../src/runtime/imessage-xref.mjs";
import { draftMessage } from "../src/drafting/draft.mjs";
import { writeQueueItem, expireOldPending, listQueue } from "../src/runtime/queue.mjs";
import { notifySelf } from "../src/runtime/notifier.mjs";
import { logSession } from "../src/runtime/logger.mjs";

const PENDING_NOTIFY_THRESHOLD = 3;
const HITL_EXPIRY_HOURS = 6;

function inferIntent(entity) {
  const lines = (entity.conversation || "").split("\n").filter(l => l.startsWith("**"));
  if (lines.length === 0) return "opener";
  const last = lines[lines.length - 1];
  const lastIsOut = last.startsWith("**you**");
  const ourLines = lines.filter(l => l.startsWith("**you**")).length;
  const herLines = lines.filter(l => l.startsWith("**her**")).length;
  if (lastIsOut) return null; // she's the one we're waiting on; no draft needed
  if (ourLines === 0 && herLines === 1) return "first_reply_back";
  if (lines.length >= 6) return "move_toward_number_or_date";
  return "natural_reply";
}

function parseMessages(conversation) {
  return (conversation || "").split("\n").filter(l => l.startsWith("**")).map(line => {
    const m = line.match(/^\*\*(her|you)\*\*\s+\S+\s+\S+\s+(.*)$/);
    if (!m) return null;
    return { direction: m[1] === "you" ? "out" : "in", text: m[2] };
  }).filter(Boolean);
}

function profileFromEntity(ent) {
  const lines = (ent.profile || "").split("\n");
  const out = { name: ent.meta.first_name, basics: {}, lifestyle: {}, interests: [] };
  for (const line of lines) {
    const m = line.match(/^- ([\w.]+):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "age" || k === "distance_mi" || k === "photos_count") out[k] = parseInt(v, 10);
    else if (k === "schools" || k === "jobs" || k === "interests") out[k] = v.split(",").map(s => s.trim()).filter(Boolean);
    else if (k === "bio" || k === "looking_for" || k === "dream_job") {
      try { out[k] = JSON.parse(v); } catch { out[k] = v; }
    }
    else if (k.startsWith("basics.")) {
      try { out.basics[k.slice(7)] = JSON.parse(v); } catch { out.basics[k.slice(7)] = v; }
    }
    else if (k.startsWith("lifestyle.")) {
      try { out.lifestyle[k.slice(10)] = JSON.parse(v); } catch { out.lifestyle[k.slice(10)] = v; }
    }
    else out[k] = v;
  }
  return out;
}

// CODEX-IMP-13+14: read latest diff from JSON-fenced block (round-trip safe).
function latestProfileDiff(ent) {
  return parseLatestDiffJsonBlock(ent.profile_changes);
}

// Parse the ## Visual section's `- key: value` bullets into a structured object.
// Skips comment lines like `<!-- engine=... -->` and (none observed) entries.
function visualFromEntity(ent) {
  const md = ent.visual || "";
  if (!md.trim()) return null;
  const out = {};
  for (const line of md.split("\n")) {
    const m = line.match(/^[-*]\s+([\w_]+):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!v || v.trim().toLowerCase() === "(none observed)") continue;
    out[k] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

async function main() {
  await expireOldPending();
  const entities = await listAllEntities();
  const existingPending = new Set((await listQueue("pending")).map(p => p.meta.match_id));
  const existingApproved = new Set((await listQueue("approved")).map(p => p.meta.match_id));

  const testLimit = parseInt(process.env.QUANTUM_TINDER_DECIDE_LIMIT || "0", 10);
  if (testLimit > 0) console.log(`TEST MODE: decide capped at ${testLimit} drafts`);
  let queued = 0, autoQueued = 0, hitlQueued = 0, skipped = 0, draftCount = 0;

  for (const ent of entities) {
    if (testLimit > 0 && draftCount >= testLimit) { skipped += 1; continue; }
    if (ent.meta.status === "unmatched" || ent.meta.status === "gone_dark") { skipped += 1; continue; }
    if (existingPending.has(ent.meta.match_id) || existingApproved.has(ent.meta.match_id)) { skipped += 1; continue; }

    const intent = inferIntent(ent);
    if (!intent) { skipped += 1; continue; }

    // C4 fix: only look up phone if we have BOTH first AND last name (or already-known phone).
    // Without last name, fuzzy first-name match is catastrophic across 2000+ contacts.
    const phone = ent.meta.phone || (ent.meta.last_name ? await findPhoneByName(ent.meta.first_name, ent.meta.last_name) : null);
    const activity = phone ? await lastImessageActivity(phone) : null;
    const channel = recommendChannel(activity);
    if (channel === "imessage_active") { skipped += 1; continue; }

    const finalIntent = channel === "tinder_reengage" ? "reengage_after_imessage_silence" : intent;
    const profile = profileFromEntity(ent);
    const profileDiff = latestProfileDiff(ent);
    const visual = visualFromEntity(ent);
    const context = {
      ...profile,
      thread: parseMessages(ent.conversation),
      imessage_summary: summarizeImessage(activity),
      profile_diff: profileDiff,
      visual,
    };

    let drafted;
    try { drafted = await draftMessage({ context, intent: finalIntent }); }
    catch (e) { console.error(`draft_failed ${ent.slug}: ${e.message}`); skipped += 1; continue; }
    draftCount += 1;

    const autoEligible = (finalIntent === "opener" || finalIntent === "reengage_after_imessage_silence") && drafted.lint.pass;
    const stage = autoEligible ? "approved" : "pending";
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${ent.slug}`;
    const meta = {
      slug: ent.slug,
      match_id: ent.meta.match_id,
      person: ent.meta.first_name,
      created: new Date().toISOString(),
      draft_id: drafted.draftId,
      lint_pass: drafted.lint.pass,
      lint_issues: drafted.lint.issues,
      mode: autoEligible ? "auto" : "hitl",
      intent: finalIntent,
      channel,
      expires: autoEligible ? "" : new Date(Date.now() + HITL_EXPIRY_HOURS * 3600000).toISOString(),
    };
    const body = [
      `## Entity`,
      `[[${ent.slug}]]`,
      "",
      `## Thread context (last 6)`,
      ...parseMessages(ent.conversation).slice(-6).map(m => `**${m.direction === "out" ? "you" : "her"}** ${m.text}`),
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
    await appendOutboundEvent(ent.slug, {
      event: autoEligible ? "queued_auto" : "queued_hitl",
      mode: meta.mode,
      intent: finalIntent,
      draftId: drafted.draftId,
      text: drafted.text,
      lintPass: drafted.lint.pass,
    });
    queued += 1;
    if (autoEligible) autoQueued += 1; else hitlQueued += 1;
  }

  const pendingCount = (await listQueue("pending")).length;
  if (pendingCount >= PENDING_NOTIFY_THRESHOLD) {
    await notifySelf(`Tinder: ${pendingCount} drafts waiting. cd workspaces/tinder/04-outbound/pending && ls`);
  }

  await logSession({ event: "decide", queued, auto: autoQueued, hitl: hitlQueued, skipped, pending_total: pendingCount });
  console.log(JSON.stringify({ queued, auto: autoQueued, hitl: hitlQueued, skipped, pending_total: pendingCount }));
}

await main().catch(e => { console.error(e); process.exit(1); });
