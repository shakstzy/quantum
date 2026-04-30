#!/usr/bin/env node
// Test helper: forces a single bio-anchored opener draft for a chosen slug,
// runs it through draftMessage (real claude -p), and queues to approved/.
// Used to set up a known target for the live send dry-run test.

import { listAllEntities, parseLatestDiffJsonBlock } from "../src/runtime/entity-store.mjs";
import { writeQueueItem } from "../src/runtime/queue.mjs";
import { draftMessage } from "../src/drafting/draft.mjs";

const slug = process.argv[2];
if (!slug) { console.error("usage: test-queue-approved-draft.mjs <slug>"); process.exit(2); }

const ents = await listAllEntities();
const ent = ents.find(e => e.slug === slug);
if (!ent) { console.error(`not found: ${slug}`); process.exit(1); }

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
    } else if (k.startsWith("basics.")) { try { out.basics[k.slice(7)] = JSON.parse(v); } catch { out.basics[k.slice(7)] = v; } }
    else if (k.startsWith("lifestyle.")) { try { out.lifestyle[k.slice(10)] = JSON.parse(v); } catch { out.lifestyle[k.slice(10)] = v; } }
    else out[k] = v;
  }
  return out;
}

const profile = profileFromEntity(ent);
const profile_diff = parseLatestDiffJsonBlock(ent.profile_changes);
const ctx = { ...profile, thread: [], imessage_summary: "(none)", profile_diff };
const drafted = await draftMessage({ context: ctx, intent: "opener" });

console.log("DRAFT:", drafted.text);
console.log("LINT:", JSON.stringify(drafted.lint));

const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}`;
const meta = {
  slug,
  match_id: ent.meta.match_id,
  person: ent.meta.first_name,
  created: new Date().toISOString(),
  draft_id: drafted.draftId,
  lint_pass: drafted.lint.pass,
  lint_issues: drafted.lint.issues,
  mode: "auto",
  intent: "opener",
  channel: "tinder_only",
  expires: "",
};
const body = [
  `## Entity\n[[${slug}]]`,
  `## Drafted reply\n${drafted.text}`,
  `## Lint\npass=${drafted.lint.pass}; issues=${(drafted.lint.issues || []).join(", ") || "none"}`,
].join("\n\n");
await writeQueueItem({ stage: "approved", id, meta, body });
console.log(`queued -> 04-outbound/approved/${id}.md`);
