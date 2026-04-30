#!/usr/bin/env node
// Focused test: force decide.mjs's drafting path on a single entity (slug from arg).
// Prints the prompt that would be sent + the resulting draft. No queue write.

import { listAllEntities } from "../src/runtime/entity-store.mjs";
import { draftMessage } from "../src/drafting/draft.mjs";

const slug = process.argv[2];
if (!slug) { console.error("usage: test-draft-with-bio.mjs <slug>"); process.exit(2); }

const entities = await listAllEntities();
const ent = entities.find(e => e.slug === slug);
if (!ent) { console.error(`entity not found: ${slug}`); process.exit(1); }

// Replicate decide.mjs's profile + diff reads
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

function latestProfileDiff(ent) {
  const md = ent.profile_changes || "";
  if (!md.trim() || md.trim() === "(none yet)") return null;
  const blocks = md.split(/\n\n(?=### )/);
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  const out = { added: {}, removed: {}, changed: {} };
  for (const line of last.split("\n")) {
    let m = line.match(/^- added (\S+):\s*(.*)$/);
    if (m) { try { out.added[m[1]] = JSON.parse(m[2]); } catch { out.added[m[1]] = m[2]; } continue; }
    m = line.match(/^- removed (\S+):\s*(.*)$/);
    if (m) { try { out.removed[m[1]] = JSON.parse(m[2]); } catch { out.removed[m[1]] = m[2]; } continue; }
    m = line.match(/^- changed (\S+):\s*(.*?)\s*->\s*(.*)$/);
    if (m) {
      let from, to;
      try { from = JSON.parse(m[2]); } catch { from = m[2]; }
      try { to = JSON.parse(m[3]); } catch { to = m[3]; }
      out.changed[m[1]] = { from, to };
    }
  }
  if (!Object.keys(out.added).length && !Object.keys(out.removed).length && !Object.keys(out.changed).length) return null;
  return out;
}

function parseMessages(conversation) {
  return (conversation || "").split("\n").filter(l => l.startsWith("**")).map(line => {
    const m = line.match(/^\*\*(her|you)\*\*\s+\S+\s+\S+\s+(.*)$/);
    if (!m) return null;
    return { direction: m[1] === "you" ? "out" : "in", text: m[2] };
  }).filter(Boolean);
}

const profile = profileFromEntity(ent);
const profile_diff = latestProfileDiff(ent);
const thread = parseMessages(ent.conversation);

console.log("== Context for", slug, "==");
console.log("name:", profile.name);
console.log("bio:", profile.bio);
console.log("interests:", profile.interests);
console.log("basics:", profile.basics);
console.log("lifestyle:", profile.lifestyle);
console.log("looking_for:", profile.looking_for);
console.log("dream_job:", profile.dream_job);
console.log("profile_diff added:", profile_diff?.added);
console.log("profile_diff changed:", profile_diff?.changed);
console.log("thread:", thread);

const intent = thread.length === 0 ? "opener" : (thread.at(-1)?.direction === "in" ? "natural_reply" : null);
if (!intent) { console.log("\n(intent=null, would skip in decide)"); process.exit(0); }

console.log("\n== Drafting (intent=" + intent + ") ==");
const ctx = {
  ...profile,
  thread,
  imessage_summary: "(none)",
  profile_diff,
};
const drafted = await draftMessage({ context: ctx, intent });
console.log("\n== DRAFT ==");
console.log(drafted.text);
console.log("\nlint:", drafted.lint);
