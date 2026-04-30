// Per-person markdown entity store. One file per match at raw/tinder/<slug>.md.
//
// Layout:
//   ---
//   slug, first_name, source, city, match_id, person_id, phone, status,
//   first_seen, last_activity, last_scrape, previous_slugs[]
//   ---
//
//   ## Profile         (overwrite on rescrape)
//   ## Conversation    (append-only timeline)
//   ## Outbound log    (append-only event list)
//
// Designed for graphify ingestion: stable slug, frontmatter foreign keys,
// wikilink-able cross-refs between entities (phone -> imessage workspace).

import { readFile, writeFile, readdir, rename, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { RAW_DIR } from "./paths.mjs";
import { resolveCity } from "./city.mjs";
import { firstName, buildSlug, uniqueSlug } from "./slug.mjs";

await mkdir(RAW_DIR, { recursive: true });

function fmYaml(meta) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${k}: []`);
      else { lines.push(`${k}:`); for (const item of v) lines.push(`  - ${JSON.stringify(item)}`); }
    } else if (v === null || v === undefined) lines.push(`${k}: null`);
    else if (typeof v === "string") lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  const lines = m[1].split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx < 0) { i++; continue; }
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val === "" && i + 1 < lines.length && lines[i + 1].startsWith("  - ")) {
      const arr = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith("  - ")) {
        i += 1;
        try { arr.push(JSON.parse(lines[i].slice(4))); }
        catch { arr.push(lines[i].slice(4)); }
      }
      meta[key] = arr;
    } else if (val === "[]") meta[key] = [];
    else if (val === "null") meta[key] = null;
    else if (val.startsWith('"') && val.endsWith('"')) {
      try { meta[key] = JSON.parse(val); } catch { meta[key] = val.slice(1, -1); }
    } else if (/^-?\d+(\.\d+)?$/.test(val)) meta[key] = Number(val);
    else if (val === "true" || val === "false") meta[key] = val === "true";
    else meta[key] = val;
    i += 1;
  }
  return { meta, body: m[2] };
}

function splitSections(body) {
  const sections = { profile: "", conversation: "", outbound: "", profile_changes: "" };
  const re = /##\s+(Profile changes|Profile|Conversation|Outbound log)\s*\n([\s\S]*?)(?=\n##\s+|$)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const heading = m[1].toLowerCase();
    let key;
    if (heading === "profile changes") key = "profile_changes";
    else if (heading === "outbound log") key = "outbound";
    else key = heading; // "profile" | "conversation"
    sections[key] = m[2].trim();
  }
  return sections;
}

function renderEntity({ meta, profile, conversation, outbound, profile_changes = "" }) {
  return [
    fmYaml(meta),
    "",
    "## Profile",
    "",
    profile.trim() || "(no profile yet)",
    "",
    "## Profile changes",
    "",
    profile_changes.trim() || "(none yet)",
    "",
    "## Conversation",
    "",
    conversation.trim() || "(no messages yet)",
    "",
    "## Outbound log",
    "",
    outbound.trim() || "(none)",
    "",
  ].join("\n");
}

function profileToMarkdown(profile) {
  const lines = [];
  if (profile.age != null) lines.push(`- age: ${profile.age}`);
  if (profile.distance_mi != null) lines.push(`- distance_mi: ${profile.distance_mi}`);
  if (profile.bio) lines.push(`- bio: ${JSON.stringify(profile.bio)}`);
  if (profile.looking_for) lines.push(`- looking_for: ${JSON.stringify(profile.looking_for)}`);
  if (profile.dream_job) lines.push(`- dream_job: ${JSON.stringify(profile.dream_job)}`);
  if (profile.schools?.length) lines.push(`- schools: ${profile.schools.join(", ")}`);
  if (profile.jobs?.length) lines.push(`- jobs: ${profile.jobs.join(", ")}`);
  if (profile.interests?.length) lines.push(`- interests: ${profile.interests.join(", ")}`);
  if (profile.basics && Object.keys(profile.basics).length) {
    for (const [k, v] of Object.entries(profile.basics)) lines.push(`- basics.${k.toLowerCase().replace(/\s+/g, "_")}: ${JSON.stringify(v)}`);
  }
  if (profile.lifestyle && Object.keys(profile.lifestyle).length) {
    for (const [k, v] of Object.entries(profile.lifestyle)) lines.push(`- lifestyle.${k.toLowerCase().replace(/\s+/g, "_")}: ${JSON.stringify(v)}`);
  }
  if (profile.photos_count != null) lines.push(`- photos_count: ${profile.photos_count}`);
  return lines.join("\n");
}

// Parse the markdown ## Profile section back into a structured object so we can
// diff against a freshly-scraped profile.
export function profileFromMarkdown(markdown) {
  const out = { basics: {}, lifestyle: {}, interests: [] };
  if (!markdown) return out;
  for (const line of markdown.split("\n")) {
    const m = line.match(/^- ([\w.]+):\s*(.*)$/);
    if (!m) continue;
    const [, k, vRaw] = m;
    let v = vRaw;
    if (v.startsWith('"') && v.endsWith('"')) {
      try { v = JSON.parse(v); } catch {}
    } else if (/^-?\d+$/.test(v)) v = parseInt(v, 10);
    if (k === "age" || k === "distance_mi" || k === "photos_count") out[k] = typeof v === "number" ? v : parseInt(v, 10);
    else if (k === "bio" || k === "looking_for" || k === "dream_job") out[k] = v;
    else if (k === "schools" || k === "jobs") out[k] = String(v).split(",").map(s => s.trim()).filter(Boolean);
    else if (k === "interests") out[k] = String(v).split(",").map(s => s.trim()).filter(Boolean);
    else if (k.startsWith("basics.")) out.basics[k.slice(7)] = v;
    else if (k.startsWith("lifestyle.")) out.lifestyle[k.slice(10)] = v;
  }
  return out;
}

// Lowercase basics/lifestyle keys so fresh-scraped (e.g. "Love Style") and
// markdown-parsed (e.g. "love_style") shapes diff correctly. Also lowercase + trim
// interests for set comparison stability.
function normalizeProfile(p) {
  if (!p) return {};
  const norm = { ...p, basics: {}, lifestyle: {} };
  const keyize = (k) => String(k).toLowerCase().replace(/\s+/g, "_");
  for (const [k, v] of Object.entries(p.basics || {})) norm.basics[keyize(k)] = v;
  for (const [k, v] of Object.entries(p.lifestyle || {})) norm.lifestyle[keyize(k)] = v;
  if (Array.isArray(p.interests)) norm.interests = p.interests.map(s => String(s).trim()).filter(Boolean);
  return norm;
}

// Computes a diff between previously-stored profile (from markdown) and a freshly
// scraped one. Returns null if no changes worth flagging, else { added, removed,
// changed } with field paths and from/to values.
export function computeProfileDiff(oldP, newP) {
  if (!oldP || Object.keys(oldP).length === 0) return null; // first scrape, no diff
  const a = normalizeProfile(oldP);
  const b = normalizeProfile(newP);
  const diff = { added: {}, removed: {}, changed: {} };
  const scalarKeys = ["age", "distance_mi", "bio", "looking_for", "dream_job", "photos_count"];
  for (const k of scalarKeys) {
    const av = a[k] ?? null;
    const bv = b[k] ?? null;
    if (av === bv) continue;
    if (av == null && bv != null) diff.added[k] = bv;
    else if (av != null && bv == null) diff.removed[k] = av;
    else diff.changed[k] = { from: av, to: bv };
  }
  for (const grp of ["basics", "lifestyle"]) {
    const oldG = a[grp] || {};
    const newG = b[grp] || {};
    for (const k of Object.keys(newG)) {
      if (!(k in oldG)) diff.added[`${grp}.${k}`] = newG[k];
      else if (oldG[k] !== newG[k]) diff.changed[`${grp}.${k}`] = { from: oldG[k], to: newG[k] };
    }
    for (const k of Object.keys(oldG)) {
      if (!(k in newG)) diff.removed[`${grp}.${k}`] = oldG[k];
    }
  }
  const oldI = new Set(a.interests || []);
  const newI = new Set(b.interests || []);
  const addedI = [...newI].filter(x => !oldI.has(x));
  const removedI = [...oldI].filter(x => !newI.has(x));
  if (addedI.length) diff.added.interests = addedI;
  if (removedI.length) diff.removed.interests = removedI;

  if (Object.keys(diff.added).length === 0 && Object.keys(diff.removed).length === 0 && Object.keys(diff.changed).length === 0) {
    return null;
  }
  return diff;
}

function diffToMarkdown(diff, ts) {
  if (!diff) return null;
  const lines = [`### ${ts}`];
  for (const [k, v] of Object.entries(diff.added)) lines.push(`- added ${k}: ${JSON.stringify(v)}`);
  for (const [k, v] of Object.entries(diff.removed)) lines.push(`- removed ${k}: ${JSON.stringify(v)}`);
  for (const [k, { from, to }] of Object.entries(diff.changed)) lines.push(`- changed ${k}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
  return lines.join("\n");
}

async function listExistingSlugs() {
  const files = await readdir(RAW_DIR).catch(() => []);
  return new Set(files.filter(f => f.endsWith(".md")).map(f => f.replace(/\.md$/, "")));
}

export async function findEntityByMatchId(matchId) {
  const files = (await readdir(RAW_DIR).catch(() => [])).filter(f => f.endsWith(".md"));
  for (const f of files) {
    const text = await readFile(resolve(RAW_DIR, f), "utf8");
    const { meta } = parseFrontmatter(text);
    if (meta.match_id === matchId) return { slug: f.replace(/\.md$/, ""), path: resolve(RAW_DIR, f), meta };
  }
  return null;
}

export async function loadEntity(slug) {
  const path = resolve(RAW_DIR, `${slug}.md`);
  const text = await readFile(path, "utf8");
  const { meta, body } = parseFrontmatter(text);
  const sections = splitSections(body);
  return { slug, path, meta, ...sections };
}

export async function saveEntity({ slug, meta, profile, conversation, outbound, profile_changes = "" }) {
  const path = resolve(RAW_DIR, `${slug}.md`);
  await writeFile(path, renderEntity({ meta, profile, conversation, outbound, profile_changes }));
  return path;
}

export async function upsertMatch({ matchId, personId, name, source = "tinder", profile = {}, phone = null }) {
  const existing = await findEntityByMatchId(matchId);
  // Conversation-based location wins over distance — we scan existing conversation
  // (if any) for "I'm in <city>" mentions before falling back to phone/distance.
  const conversation = existing ? (await loadEntity(existing.slug)).conversation : null;
  const city = await resolveCity({ phone, distance_mi: profile.distance_mi, conversation });
  const now = new Date().toISOString();

  if (existing) {
    const ent = await loadEntity(existing.slug);
    const oldCity = ent.meta.city;
    let slug = ent.slug;
    let previous = ent.meta.previous_slugs || [];

    if (oldCity !== city) {
      const candidate = buildSlug({ name: ent.meta.first_name || name, source: ent.meta.source || source, city });
      const existingSlugs = await listExistingSlugs();
      existingSlugs.delete(ent.slug);
      const newSlug = existingSlugs.has(candidate)
        ? await uniqueSlug({ name: ent.meta.first_name || name, source: ent.meta.source || source, city }, existingSlugs)
        : candidate;
      previous = [...new Set([...previous, ent.slug])];
      const newPath = resolve(RAW_DIR, `${newSlug}.md`);
      await rename(ent.path, newPath);
      slug = newSlug;
    }

    // Compute profile diff vs previously-stored profile.
    const oldProfile = profileFromMarkdown(ent.profile);
    const diff = computeProfileDiff(oldProfile, profile);
    const diffMd = diffToMarkdown(diff, now);
    const newChanges = diffMd
      ? [ent.profile_changes, diffMd].filter(Boolean).join("\n\n")
      : ent.profile_changes;

    const meta = {
      ...ent.meta,
      slug,
      city,
      phone: phone ?? ent.meta.phone ?? null,
      last_scrape: now,
      ...(diff ? { last_profile_diff: now } : {}),
      previous_slugs: previous,
    };
    await saveEntity({
      slug,
      meta,
      profile: profileToMarkdown(profile),
      conversation: ent.conversation,
      outbound: ent.outbound,
      profile_changes: newChanges,
    });
    return { slug, created: false, renamed: oldCity !== city, profile_diff: diff };
  }

  const existingSlugs = await listExistingSlugs();
  const slug = await uniqueSlug({ name, source, city }, existingSlugs);
  const meta = {
    slug,
    first_name: firstName(name),
    source,
    city,
    match_id: matchId,
    person_id: personId,
    phone,
    status: "new",
    first_seen: now,
    last_activity: now,
    last_scrape: now,
    previous_slugs: [],
  };
  await saveEntity({
    slug,
    meta,
    profile: profileToMarkdown(profile),
    conversation: "",
    outbound: "",
    profile_changes: "",
  });
  return { slug, created: true, renamed: false, profile_diff: null };
}

function fmtMessageLine({ direction, text, ts }) {
  const who = direction === "out" ? "you" : "her";
  const t = ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : new Date().toISOString().slice(0, 16).replace("T", " ");
  return `**${who}** ${t} ${text.replace(/\n/g, " ")}`;
}

// Pull a phone number out of message text in canonical E.164. Returns null if none.
// Conservative: only matches what plausibly looks like a US number she just typed.
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/g;
export function extractPhoneFromText(text) {
  if (!text) return null;
  PHONE_RE.lastIndex = 0;
  let m;
  while ((m = PHONE_RE.exec(text)) !== null) {
    const [, area, mid, last] = m;
    if (area[0] === "0" || area[0] === "1") continue; // not a real area code
    return `+1${area}${mid}${last}`;
  }
  return null;
}

export async function appendMessages(slug, messages) {
  const ent = await loadEntity(slug);
  const have = new Set(ent.conversation.split("\n").filter(l => l.startsWith("**")));
  const newLines = [];
  let lastTs = ent.meta.last_activity;
  let extractedPhone = null;
  for (const m of messages) {
    const line = fmtMessageLine(m);
    if (have.has(line)) continue;
    newLines.push(line);
    if (m.ts && (!lastTs || m.ts > lastTs)) lastTs = m.ts;
    if (!extractedPhone && !ent.meta.phone) {
      const found = extractPhoneFromText(m.text);
      if (found) extractedPhone = found;
    }
  }
  if (newLines.length === 0) return { added: 0 };
  const conversation = [ent.conversation, ...newLines].filter(Boolean).join("\n");
  const meta = {
    ...ent.meta,
    last_activity: lastTs || new Date().toISOString(),
    phone: ent.meta.phone || extractedPhone || null,
  };
  await saveEntity({ slug, meta, profile: ent.profile, conversation, outbound: ent.outbound, profile_changes: ent.profile_changes });
  return { added: newLines.length, phone_discovered: extractedPhone };
}

export async function appendOutboundEvent(slug, { event, mode, intent, draftId, text, lintPass }) {
  const ent = await loadEntity(slug);
  const t = new Date().toISOString().slice(0, 16).replace("T", " ");
  const line = `- ${t} ${event} (${mode}, ${intent}) [draft:${draftId.slice(0, 8)}] lint=${lintPass} ${JSON.stringify(text)}`;
  const outbound = [ent.outbound, line].filter(Boolean).join("\n");
  await saveEntity({ slug, meta: ent.meta, profile: ent.profile, conversation: ent.conversation, outbound, profile_changes: ent.profile_changes });
}

export async function setStatus(slug, status) {
  const ent = await loadEntity(slug);
  const meta = { ...ent.meta, status };
  await saveEntity({ slug, meta, profile: ent.profile, conversation: ent.conversation, outbound: ent.outbound, profile_changes: ent.profile_changes });
}

export async function listAllEntities() {
  const files = (await readdir(RAW_DIR).catch(() => [])).filter(f => f.endsWith(".md"));
  const out = [];
  for (const f of files) {
    const text = await readFile(resolve(RAW_DIR, f), "utf8");
    const { meta, body } = parseFrontmatter(text);
    const sections = splitSections(body);
    out.push({ slug: f.replace(/\.md$/, ""), meta, ...sections });
  }
  return out;
}
