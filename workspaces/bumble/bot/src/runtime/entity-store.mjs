// Per-person markdown entity store. One file per match at raw/bumble/<slug>.md.
//
// Layout:
//   ---
//   slug, first_name, source, city, match_id, person_id, phone, status,
//   expires_at, first_seen, last_activity, last_scrape, previous_slugs[]
//   ---
//
//   ## Profile         (overwrite on rescrape)
//   ## Profile changes (append-only diff log, JSON-fenced)
//   ## Conversation    (append-only timeline)
//   ## Outbound log    (append-only event list)
//
// Designed for graphify ingestion: stable slug, frontmatter foreign keys.

import { readFile, writeFile, readdir, rename, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import { RAW_DIR } from "./paths.mjs";
import { resolveCity } from "./city.mjs";
import { firstName, buildSlug, uniqueSlug } from "./slug.mjs";

await mkdir(RAW_DIR, { recursive: true });

// One global lock. Bot loops are slow human-paced; contention is negligible.
const LOCK_PATH = resolve(RAW_DIR, ".entity-store.lock");
async function withEntityLock(fn) {
  try { await writeFile(LOCK_PATH, "", { flag: "ax" }); } catch { /* exists */ }
  const release = await lockfile.lock(LOCK_PATH, {
    retries: { retries: 50, minTimeout: 50, maxTimeout: 500, factor: 1.4 },
    stale: 30000,
  });
  try { return await fn(); }
  finally { try { await release(); } catch { /* already released */ } }
}

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
    fmYaml(meta), "",
    "## Profile", "", profile.trim() || "(no profile yet)", "",
    "## Profile changes", "", profile_changes.trim() || "(none yet)", "",
  ];
  // Visual section is optional — only render if visualize.mjs has populated it.
  if (visual && visual.trim()) {
    lines.push("## Visual", "", visual.trim(), "");
  }
  lines.push(
    "## Conversation", "", conversation.trim() || "(no messages yet)", "",
    "## Outbound log", "", outbound.trim() || "(none)", "",
  );
  return lines.join("\n");
}

// Normalize a profile object for storage. The browser-side extractors return
// `work`/`school` as single strings; the entity schema uses `jobs`/`schools`
// arrays. This shim collapses both shapes and persists the rich Bumble fields
// (lifestyle_badges, prompts, hometown) the extractors now produce.
function profileToMarkdown(profile) {
  const lines = [];
  const jobs = Array.isArray(profile.jobs) && profile.jobs.length
    ? profile.jobs
    : (profile.work ? [profile.work] : []);
  const schools = Array.isArray(profile.schools) && profile.schools.length
    ? profile.schools
    : (profile.school ? [profile.school] : []);

  if (profile.age != null) lines.push(`- age: ${profile.age}`);
  if (profile.distance_mi != null) lines.push(`- distance_mi: ${profile.distance_mi}`);
  if (profile.height) lines.push(`- height: ${JSON.stringify(profile.height)}`);
  if (profile.height_cm != null) lines.push(`- height_cm: ${profile.height_cm}`);
  if (profile.bio) lines.push(`- bio: ${JSON.stringify(profile.bio)}`);
  if (profile.looking_for) lines.push(`- looking_for: ${JSON.stringify(profile.looking_for)}`);
  if (profile.opening_move) lines.push(`- opening_move: ${JSON.stringify(profile.opening_move)}`);
  if (schools.length) lines.push(`- schools: ${schools.join(", ")}`);
  if (jobs.length) lines.push(`- jobs: ${jobs.join(", ")}`);
  if (profile.lives_in) lines.push(`- lives_in: ${JSON.stringify(profile.lives_in)}`);
  if (profile.hometown) lines.push(`- hometown: ${JSON.stringify(profile.hometown)}`);
  if (profile.pronouns) lines.push(`- pronouns: ${JSON.stringify(profile.pronouns)}`);
  if (profile.sexuality) lines.push(`- sexuality: ${JSON.stringify(profile.sexuality)}`);
  if (profile.photo_verified === true) lines.push(`- photo_verified: true`);
  if (profile.interests?.length) lines.push(`- interests: ${profile.interests.join(", ")}`);
  if (Array.isArray(profile.lifestyle_badges) && profile.lifestyle_badges.length) {
    lines.push(`- lifestyle_badges: ${JSON.stringify(profile.lifestyle_badges)}`);
  }
  if (Array.isArray(profile.prompts) && profile.prompts.length) {
    for (let i = 0; i < profile.prompts.length; i++) {
      const p = profile.prompts[i];
      lines.push(`- prompts.${i}.q: ${JSON.stringify(p.q)}`);
      lines.push(`- prompts.${i}.a: ${JSON.stringify(p.a)}`);
    }
  } else if (profile.prompts && typeof profile.prompts === "object" && Object.keys(profile.prompts).length) {
    for (const [k, v] of Object.entries(profile.prompts)) {
      lines.push(`- prompt: ${JSON.stringify(`${k} :: ${v}`)}`);
    }
  }
  if (profile.basics && Object.keys(profile.basics).length) {
    for (const [k, v] of Object.entries(profile.basics)) lines.push(`- basics.${k.toLowerCase().replace(/\s+/g, "_")}: ${JSON.stringify(v)}`);
  }
  if (profile.lifestyle && Object.keys(profile.lifestyle).length) {
    for (const [k, v] of Object.entries(profile.lifestyle)) lines.push(`- lifestyle.${k.toLowerCase().replace(/\s+/g, "_")}: ${JSON.stringify(v)}`);
  }
  if (profile.photos_count != null) lines.push(`- photos_count: ${profile.photos_count}`);
  return lines.join("\n");
}

export function profileFromMarkdown(markdown) {
  const out = { basics: {}, lifestyle: {}, interests: [], lifestyle_badges: [], prompts: [] };
  if (!markdown) return out;
  // First pass: collect prompts.<idx>.q / prompts.<idx>.a so we can assemble them.
  const promptParts = {};
  for (const line of markdown.split("\n")) {
    const m = line.match(/^- ([\w.]+):\s*(.*)$/);
    if (!m) continue;
    const [, k, vRaw] = m;
    let v = vRaw;
    if (v.startsWith('"') && v.endsWith('"')) {
      try { v = JSON.parse(v); } catch {}
    } else if (/^-?\d+$/.test(v)) v = parseInt(v, 10);
    if (k === "age" || k === "distance_mi" || k === "photos_count" || k === "height_cm") out[k] = typeof v === "number" ? v : parseInt(v, 10);
    else if (k === "bio" || k === "looking_for" || k === "opening_move" || k === "lives_in" || k === "hometown" || k === "pronouns" || k === "sexuality" || k === "height") out[k] = v;
    else if (k === "photo_verified") out[k] = vRaw === "true";
    else if (k === "schools" || k === "jobs") out[k] = String(v).split(",").map(s => s.trim()).filter(Boolean);
    else if (k === "interests") out[k] = String(v).split(",").map(s => s.trim()).filter(Boolean);
    else if (k === "lifestyle_badges") {
      try { out.lifestyle_badges = typeof v === "string" ? JSON.parse(v) : v; }
      catch { out.lifestyle_badges = String(v).split(",").map(s => s.trim()).filter(Boolean); }
    }
    else if (k.startsWith("prompts.")) {
      const parts = k.split(".");
      const idx = parseInt(parts[1], 10);
      const field = parts[2];
      if (Number.isFinite(idx) && (field === "q" || field === "a")) {
        promptParts[idx] = promptParts[idx] || {};
        promptParts[idx][field] = v;
      }
    }
    else if (k.startsWith("basics.")) out.basics[k.slice(7)] = v;
    else if (k.startsWith("lifestyle.")) out.lifestyle[k.slice(10)] = v;
  }
  // Assemble prompts in order.
  const promptIndices = Object.keys(promptParts).map(Number).sort((a, b) => a - b);
  for (const i of promptIndices) {
    const p = promptParts[i];
    if (p?.q && p?.a) out.prompts.push({ q: p.q, a: p.a });
  }
  return out;
}

function normalizeProfile(p) {
  if (!p) return {};
  const norm = { ...p, basics: {}, lifestyle: {} };
  const keyize = (k) => String(k).toLowerCase().replace(/\s+/g, "_");
  for (const [k, v] of Object.entries(p.basics || {})) norm.basics[keyize(k)] = v;
  for (const [k, v] of Object.entries(p.lifestyle || {})) norm.lifestyle[keyize(k)] = v;
  if (Array.isArray(p.interests)) norm.interests = p.interests.map(s => String(s).trim()).filter(Boolean);
  // Bridge readVisibleCard/readThreadProfile (work/school singletons) to the
  // entity schema (jobs/schools arrays). Without this, the diff function
  // saw old=jobs:["X"], new=jobs:[] and false-flagged a "removed" change
  // every scrape.
  if (p.work && (!Array.isArray(norm.jobs) || norm.jobs.length === 0)) norm.jobs = [p.work];
  if (p.school && (!Array.isArray(norm.schools) || norm.schools.length === 0)) norm.schools = [p.school];
  return norm;
}

export function computeProfileDiff(oldP, newP) {
  if (!oldP || Object.keys(oldP).length === 0) return null;
  const a = normalizeProfile(oldP);
  const b = normalizeProfile(newP);
  const diff = { added: {}, removed: {}, changed: {} };
  const scalarKeys = ["age", "distance_mi", "height_cm", "bio", "looking_for", "opening_move",
                      "lives_in", "pronouns", "sexuality", "photo_verified", "photos_count"];
  for (const k of scalarKeys) {
    const av = a[k] ?? null;
    const bv = b[k] ?? null;
    if (av === bv) continue;
    if (av == null && bv != null) diff.added[k] = bv;
    else if (av != null && bv == null) diff.removed[k] = av;
    else diff.changed[k] = { from: av, to: bv };
  }
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

function diffToJsonBlock(diff, ts) {
  if (!diff) return null;
  const payload = { ts, ...diff };
  return ["```json profile-diff", JSON.stringify(payload, null, 2), "```"].join("\n");
}

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

export async function upsertMatch({ matchId, personId, name, source = "bumble", profile = null, phone = null, expires_at = null }) {
  return await withEntityLock(async () => {
    const existing = await findEntityByMatchId(matchId);
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
        if (newSlug !== ent.slug) {
          previous = [...new Set([...previous, ent.slug])];
          const newPath = resolve(RAW_DIR, `${newSlug}.md`);
          await rename(ent.path, newPath);
          slug = newSlug;
        }
      }

      let nextProfileMd = ent.profile;
      let nextChanges = ent.profile_changes;
      let diff = null;
      if (profile) {
        const oldProfile = profileFromMarkdown(ent.profile);
        const hasOld = !!(oldProfile.age || oldProfile.bio || oldProfile.distance_mi
          || oldProfile.looking_for || oldProfile.opening_move
          || (oldProfile.basics && Object.keys(oldProfile.basics).length)
          || (oldProfile.lifestyle && Object.keys(oldProfile.lifestyle).length)
          || (oldProfile.interests && oldProfile.interests.length));
        diff = hasOld ? computeProfileDiff(oldProfile, profile) : null;
        nextProfileMd = profileToMarkdown(profile);
        if (diff) {
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
        ...(expires_at ? { expires_at } : {}),
        ...(diff ? { last_profile_diff: now } : {}),
        previous_slugs: previous,
      };
      await saveEntity({
        slug, meta,
        profile: nextProfileMd,
        conversation: ent.conversation,
        outbound: ent.outbound,
        profile_changes: nextChanges,
        visual: ent.visual || "",
      });
      return { slug, created: false, renamed: oldCity !== city, profile_diff: diff, priorStatus: String(ent.meta.status || "").replace(/^"|"$/g, "") };
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
      expires_at: expires_at || null,
      first_seen: now,
      last_activity: now,
      last_scrape: now,
      previous_slugs: [],
    };
    await saveEntity({
      slug, meta,
      profile: profile ? profileToMarkdown(profile) : "",
      conversation: "",
      outbound: "",
      profile_changes: "",
    });
    return { slug, created: true, renamed: false, profile_diff: null };
  });
}

// CODEX-R7-fix: stub-leak. renderEntity writes "(no messages yet)" / "(none)"
// for empty sections, which then leaked into the conversation/outbound buffers
// on the next append. Treat the stub literals as empty.
function cleanStub(s, stubLiteral) {
  const trimmed = (s || "").trim();
  return trimmed === stubLiteral ? "" : trimmed;
}

function fmtMessageLine({ direction, text, ts }) {
  const who = direction === "out" ? "you" : "her";
  const t = ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : new Date().toISOString().slice(0, 16).replace("T", " ");
  return `**${who}** ${t} ${text.replace(/\n/g, " ")}`;
}

// CODEX-R8-P1 / GEMINI-P1: position-aware dedup. The previous identity was
// `${direction}::${normText}` only, which collapsed legitimate repeats like
// "haha" / "lol" / "same". Including the running ordinal (occurrence index of
// this direction+text in the existing thread) lets repeated identical text
// stay distinct as long as the new scrape has at least one MORE occurrence
// than the local file.
function messageIdentity(direction, text, occurrence = 0) {
  const norm = String(text || "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  return `${direction}::${norm}::${occurrence}`;
}

function existingIdentities(conversationMd) {
  const out = new Set();
  const counts = new Map();
  for (const line of (conversationMd || "").split("\n")) {
    const m = line.match(/^\*\*(her|you)\*\*\s+\S+\s+\S+\s+(.*)$/);
    if (!m) continue;
    const direction = m[1] === "you" ? "out" : "in";
    const norm = String(m[2] || "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
    const key = `${direction}::${norm}`;
    const occ = counts.get(key) || 0;
    out.add(`${direction}::${norm}::${occ}`);
    counts.set(key, occ + 1);
  }
  return { idents: out, counts };
}

const PHONE_RE = /(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/g;
export function extractPhoneFromText(text) {
  if (!text) return null;
  PHONE_RE.lastIndex = 0;
  let m;
  while ((m = PHONE_RE.exec(text)) !== null) {
    const [, area, mid, last] = m;
    if (area[0] === "0" || area[0] === "1") continue;
    return `+1${area}${mid}${last}`;
  }
  return null;
}

export async function appendMessages(slug, messages) {
  return await withEntityLock(async () => {
    const ent = await loadEntity(slug);
    // CODEX-R8 / GEMINI-P1 + repull-bug fix: dedup must walk LIVE messages in
    // order, comparing each (direction, text, occurrence-in-live) tuple
    // against the LOCAL occurrence-in-file. The previous attempt pre-populated
    // a counter from the local file, so the very first live "hi" got ordinal
    // = local_count, and never matched local's ordinal-0 entry — every re-pull
    // double-appended.
    const { idents: localIdents } = existingIdentities(ent.conversation);
    const liveCounts = new Map();
    const newLines = [];
    let lastTs = ent.meta.last_activity;
    let extractedPhone = null;
    for (const m of messages) {
      const norm = String(m.text || "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
      const key = `${m.direction}::${norm}`;
      const occ = liveCounts.get(key) || 0;
      liveCounts.set(key, occ + 1);
      const ident = `${key}::${occ}`;
      if (localIdents.has(ident)) continue; // already in local (matched by ordinal position)
      newLines.push(fmtMessageLine(m));
      if (m.ts && (!lastTs || m.ts > lastTs)) lastTs = m.ts;
      if (!extractedPhone && !ent.meta.phone) {
        const found = extractPhoneFromText(m.text);
        if (found) extractedPhone = found;
      }
    }
    if (newLines.length === 0) return { added: 0 };
    const baseConvo = cleanStub(ent.conversation, "(no messages yet)");
    const conversation = [baseConvo, ...newLines].filter(Boolean).join("\n");
    // GEMINI-P1: appendMessages used to leave last_activity stuck at first_seen
    // when scrape sets ts=null on every message. New messages mean activity
    // happened NOW; bump last_activity to current time when at least one new
    // line was appended. This fixes expiry triage.
    const finalLastActivity = lastTs && lastTs > (ent.meta.last_activity || "")
      ? lastTs
      : new Date().toISOString();
    const meta = {
      ...ent.meta,
      last_activity: finalLastActivity,
      phone: ent.meta.phone || extractedPhone || null,
    };
    await saveEntity({ slug, meta, profile: ent.profile, conversation, outbound: ent.outbound, profile_changes: ent.profile_changes, visual: ent.visual || "" });
    return { added: newLines.length, phone_discovered: extractedPhone };
  });
}

export async function appendOutboundEvent(slug, { event, mode, intent, draftId, text, lintPass }) {
  return await withEntityLock(async () => {
    const ent = await loadEntity(slug);
    const t = new Date().toISOString().slice(0, 16).replace("T", " ");
    const line = `- ${t} ${event} (${mode}, ${intent}) [draft:${draftId.slice(0, 8)}] lint=${lintPass} ${JSON.stringify(text)}`;
    const baseOutbound = cleanStub(ent.outbound, "(none)");
    const outbound = [baseOutbound, line].filter(Boolean).join("\n");
    await saveEntity({ slug, meta: ent.meta, profile: ent.profile, conversation: ent.conversation, outbound, profile_changes: ent.profile_changes, visual: ent.visual || "" });
  });
}

export async function setStatus(slug, status) {
  return await withEntityLock(async () => {
    const ent = await loadEntity(slug);
    const meta = { ...ent.meta, status };
    await saveEntity({ slug, meta, profile: ent.profile, conversation: ent.conversation, outbound: ent.outbound, profile_changes: ent.profile_changes, visual: ent.visual || "" });
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
