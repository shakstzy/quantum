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
import lockfile from "proper-lockfile";
import { RAW_DIR } from "./paths.mjs";
import { resolveCity } from "./city.mjs";
import { firstName, buildSlug, uniqueSlug } from "./slug.mjs";

await mkdir(RAW_DIR, { recursive: true });

// CODEX-CRIT-4+5: serialize all entity mutations behind a single global lock.
// Per-slug locking would be ideal but is racy when slug allocation itself depends
// on listing the dir (slug collision detection). One global lock is correct +
// dirt-cheap: bot loops are slow human-paced (seconds between operations), so
// contention is negligible.
const LOCK_PATH = resolve(RAW_DIR, ".entity-store.lock");
async function withEntityLock(fn) {
  // Ensure lock target file exists (lockfile attaches lock to a real path)
  try { await writeFile(LOCK_PATH, "", { flag: "ax" }); } catch { /* exists */ }
  const release = await lockfile.lock(LOCK_PATH, {
    retries: { retries: 50, minTimeout: 50, maxTimeout: 500, factor: 1.4 },
    stale: 30000,
  });
  try { return await fn(); }
  finally { try { await release(); } catch { /* already released */ } }
}

// Atomic file write — temp + rename so a crash mid-write doesn't truncate a
// well-formed entity file.
// GEMINI-IMP-R2-6: clean up tmp on rename failure to prevent leak.
async function atomicWrite(path, content) {
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, content);
  try {
    await rename(tmp, path);
  } catch (e) {
    try { const { unlink } = await import("node:fs/promises"); await unlink(tmp); } catch {}
    throw e;
  }
}

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
  const sections = { profile: "", conversation: "", outbound: "", profile_changes: "", visual: "" };
  const re = /##\s+(Profile changes|Profile|Conversation|Outbound log|Visual)\s*\n([\s\S]*?)(?=\n##\s+|$)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const heading = m[1].toLowerCase();
    let key;
    if (heading === "profile changes") key = "profile_changes";
    else if (heading === "outbound log") key = "outbound";
    else key = heading; // "profile" | "conversation" | "visual"
    sections[key] = m[2].trim();
  }
  return sections;
}

function renderEntity({ meta, profile, conversation, outbound, profile_changes = "", visual = "" }) {
  const lines = [
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
  ];
  // Visual section is optional — only render if there's content (visualize.mjs writes
  // it directly via raw file edit, but if it's already loaded we preserve it).
  if (visual && visual.trim()) {
    lines.push("## Visual", "", visual.trim(), "");
  }
  lines.push(
    "## Conversation",
    "",
    conversation.trim() || "(no messages yet)",
    "",
    "## Outbound log",
    "",
    outbound.trim() || "(none)",
    "",
  );
  return lines.join("\n");
}

function profileToMarkdown(profile) {
  const lines = [];
  if (profile.age != null) lines.push(`- age: ${profile.age}`);
  if (profile.distance_mi != null) lines.push(`- distance_mi: ${profile.distance_mi}`);
  if (profile.height_cm != null) lines.push(`- height_cm: ${profile.height_cm}`);
  if (profile.bio) lines.push(`- bio: ${JSON.stringify(profile.bio)}`);
  if (profile.looking_for) lines.push(`- looking_for: ${JSON.stringify(profile.looking_for)}`);
  if (profile.dream_job) lines.push(`- dream_job: ${JSON.stringify(profile.dream_job)}`);
  if (profile.schools?.length) lines.push(`- schools: ${profile.schools.join(", ")}`);
  if (profile.jobs?.length) lines.push(`- jobs: ${profile.jobs.join(", ")}`);
  if (profile.lives_in) lines.push(`- lives_in: ${JSON.stringify(profile.lives_in)}`);
  if (profile.pronouns) lines.push(`- pronouns: ${JSON.stringify(profile.pronouns)}`);
  if (profile.sexuality) lines.push(`- sexuality: ${JSON.stringify(profile.sexuality)}`);
  if (profile.photo_verified === true) lines.push(`- photo_verified: true`);
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
    if (k === "age" || k === "distance_mi" || k === "photos_count" || k === "height_cm") out[k] = typeof v === "number" ? v : parseInt(v, 10);
    else if (k === "bio" || k === "looking_for" || k === "dream_job" || k === "lives_in" || k === "pronouns" || k === "sexuality") out[k] = v;
    else if (k === "photo_verified") out[k] = vRaw === "true";
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
  const scalarKeys = ["age", "distance_mi", "height_cm", "bio", "looking_for", "dream_job",
                      "lives_in", "pronouns", "sexuality", "photo_verified", "photos_count"];
  for (const k of scalarKeys) {
    const av = a[k] ?? null;
    const bv = b[k] ?? null;
    if (av === bv) continue;
    if (av == null && bv != null) diff.added[k] = bv;
    else if (av != null && bv == null) diff.removed[k] = av;
    else diff.changed[k] = { from: av, to: bv };
  }
  // Set-shape diffs for jobs + schools (multi-value lists)
  for (const grp of ["jobs", "schools"]) {
    const oldS = new Set(a[grp] || []);
    const newS = new Set(b[grp] || []);
    const addedItems = [...newS].filter(x => !oldS.has(x));
    const removedItems = [...oldS].filter(x => !newS.has(x));
    if (addedItems.length) diff.added[grp] = addedItems;
    if (removedItems.length) diff.removed[grp] = removedItems;
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

// CODEX-IMP-13+14: profile diffs stored as JSON fenced code blocks. Regex-prose
// format wasn't round-trip safe (values containing "->" or "added " corrupted parse).
function diffToJsonBlock(diff, ts) {
  if (!diff) return null;
  const payload = { ts, ...diff };
  return ["```json profile-diff", JSON.stringify(payload, null, 2), "```"].join("\n");
}

// Parses the most recent profile-diff JSON block out of the ## Profile changes
// section. Returns null if none present.
export function parseLatestDiffJsonBlock(profileChangesMd) {
  if (!profileChangesMd) return null;
  const re = /```json profile-diff\n([\s\S]*?)\n```/g;
  let last = null;
  let m;
  while ((m = re.exec(profileChangesMd)) !== null) last = m[1];
  if (!last) return null;
  try { return JSON.parse(last); } catch { return null; }
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

export async function saveEntity({ slug, meta, profile, conversation, outbound, profile_changes = "", visual = "" }) {
  const path = resolve(RAW_DIR, `${slug}.md`);
  await atomicWrite(path, renderEntity({ meta, profile, conversation, outbound, profile_changes, visual }));
  return path;
}

// CODEX-IMP-6+7+12: profile=null means "capture failed/skipped"; preserve existing
// stored profile and skip the diff path entirely. profile={} or {sparse fields} means
// "captured but empty" → still diff.
export async function upsertMatch({ matchId, personId, name, source = "tinder", profile = null, phone = null }) {
  return await withEntityLock(async () => {
    const existing = await findEntityByMatchId(matchId);
    // Conversation-based location wins over distance.
    const conversation = existing ? (await loadEntity(existing.slug)).conversation : null;
    const distanceForCity = profile?.distance_mi ?? null;
    const city = await resolveCity({ phone, distance_mi: distanceForCity, conversation });
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
        // GEMINI-BUG-R2-4: only record previous_slug + rename if slug actually changed.
        // Otherwise we'd add ent.slug to its own previous_slugs (self-reference) and
        // rename foo.md -> foo.md (no-op but burns an FS op).
        if (newSlug !== ent.slug) {
          previous = [...new Set([...previous, ent.slug])];
          const newPath = resolve(RAW_DIR, `${newSlug}.md`);
          await rename(ent.path, newPath);
          slug = newSlug;
        }
      }

      // Decide what to write into ## Profile and ## Profile changes.
      let nextProfileMd = ent.profile;       // default: keep existing
      let nextChanges = ent.profile_changes; // default: keep existing
      let diff = null;
      if (profile) {
        // Capture succeeded — diff against stored.
        const oldProfile = profileFromMarkdown(ent.profile);
        // CODEX-IMP-12: if oldProfile has no meaningful captured fields (parsed from
        // "(no profile yet)"), treat as no prior data and skip diff (avoids fake "added
        // every field" event on first real capture). Meaningful = any scalar OR any
        // basics/lifestyle entry OR any interest.
        const hasOld = !!(oldProfile.age || oldProfile.bio || oldProfile.distance_mi
          || oldProfile.looking_for || oldProfile.dream_job
          || (oldProfile.basics && Object.keys(oldProfile.basics).length)
          || (oldProfile.lifestyle && Object.keys(oldProfile.lifestyle).length)
          || (oldProfile.interests && oldProfile.interests.length));
        diff = hasOld ? computeProfileDiff(oldProfile, profile) : null;
        nextProfileMd = profileToMarkdown(profile);
        if (diff) {
          // CODEX-IMP-13+14: store diffs as JSON-fenced blocks for round-trip safety.
          const block = diffToJsonBlock(diff, now);
          nextChanges = [ent.profile_changes, block].filter(s => s && s.trim() && s.trim() !== "(none yet)").join("\n\n");
        }
      }

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
        profile: nextProfileMd,
        conversation: ent.conversation,
        outbound: ent.outbound,
        profile_changes: nextChanges,
        visual: ent.visual || "",
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
      profile: profile ? profileToMarkdown(profile) : "",
      conversation: "",
      outbound: "",
      profile_changes: "",
      visual: "",
    });
    return { slug, created: true, renamed: false, profile_diff: null };
  });
}

function fmtMessageLine({ direction, text, ts }) {
  const who = direction === "out" ? "you" : "her";
  const t = ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : new Date().toISOString().slice(0, 16).replace("T", " ");
  return `**${who}** ${t} ${text.replace(/\n/g, " ")}`;
}

// CODEX-IMP-17: dedupe identity = {direction, normalized text}. Without this,
// a message scraped twice (no real ts from DOM) gets two stamped-now lines.
// GEMINI-IMP-R2-7: normalize NFC + lowercase + collapse whitespace to be robust
// to Unicode normalization differences and case oscillation in the DOM.
function messageIdentity(direction, text) {
  const norm = String(text || "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  return `${direction}::${norm}`;
}
function existingIdentities(conversationMd) {
  const out = new Set();
  for (const line of (conversationMd || "").split("\n")) {
    const m = line.match(/^\*\*(her|you)\*\*\s+\S+\s+\S+\s+(.*)$/);
    if (!m) continue;
    out.add(messageIdentity(m[1] === "you" ? "out" : "in", m[2]));
  }
  return out;
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
  return await withEntityLock(async () => {
    const ent = await loadEntity(slug);
    const have = existingIdentities(ent.conversation);
    const newLines = [];
    let lastTs = ent.meta.last_activity;
    let extractedPhone = null;
    for (const m of messages) {
      const ident = messageIdentity(m.direction, m.text);
      if (have.has(ident)) continue;
      have.add(ident); // also dedupe within the incoming batch
      newLines.push(fmtMessageLine(m));
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
    await saveEntity({ slug, meta, profile: ent.profile, conversation, outbound: ent.outbound, profile_changes: ent.profile_changes, visual: ent.visual });
    return { added: newLines.length, phone_discovered: extractedPhone };
  });
}

export async function appendOutboundEvent(slug, { event, mode, intent, draftId, text, lintPass }) {
  return await withEntityLock(async () => {
    const ent = await loadEntity(slug);
    const t = new Date().toISOString().slice(0, 16).replace("T", " ");
    const line = `- ${t} ${event} (${mode}, ${intent}) [draft:${draftId.slice(0, 8)}] lint=${lintPass} ${JSON.stringify(text)}`;
    const outbound = [ent.outbound, line].filter(Boolean).join("\n");
    await saveEntity({ slug, meta: ent.meta, profile: ent.profile, conversation: ent.conversation, outbound, profile_changes: ent.profile_changes, visual: ent.visual });
  });
}

export async function setStatus(slug, status) {
  return await withEntityLock(async () => {
    const ent = await loadEntity(slug);
    const meta = { ...ent.meta, status };
    await saveEntity({ slug, meta, profile: ent.profile, conversation: ent.conversation, outbound: ent.outbound, profile_changes: ent.profile_changes, visual: ent.visual });
  });
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
