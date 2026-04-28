#!/usr/bin/env node
// One-shot migration: SHAKOS wiki/entities/<slug>.md + wiki/conversations/<slug>.md
//   -> QUANTUM raw/tinder/<first>-<source>-<city>.md
//
// Run once: `node scripts/migrate-shakos.mjs`. Idempotent (skips entities whose
// match_id is already present in raw/tinder/).

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { RAW_DIR } from "../src/runtime/paths.mjs";
import { resolveCity } from "../src/runtime/city.mjs";
import { firstName, buildSlug } from "../src/runtime/slug.mjs";
import { findEntityByMatchId } from "../src/runtime/entity-store.mjs";

const SHAKOS_ENTITIES = "/Users/shakstzy/SHAKOS/workspaces/relationships/wiki/entities";
const SHAKOS_CONVOS = "/Users/shakstzy/SHAKOS/workspaces/relationships/wiki/conversations";

await mkdir(RAW_DIR, { recursive: true });

function getMeta(text, key) {
  const re = new RegExp(`\\*\\*${key}:\\*\\*\\s*(.+?)\\s*$`, "m");
  const m = text.match(re);
  if (!m) return null;
  const v = m[1].trim();
  if (v === "(none)" || v === "(unknown)" || v === "—" || v === "") return null;
  return v;
}

function getSection(text, heading) {
  const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

function statusFromShakos(s) {
  if (!s) return "new";
  if (s === "awaiting-her") return "active";
  if (s === "active") return "active";
  if (s === "archived" || s === "closed") return "gone_dark";
  if (s === "new") return "new";
  return s;
}

function parseShakosConvo(convoText) {
  const lines = convoText.split("\n");
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\*\*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\*\*\s+\[(in|out)\]\s+(.*)$/);
    if (!m) continue;
    const [, date, time, dir, text] = m;
    out.push({ direction: dir === "out" ? "out" : "in", text, ts: `${date}T${time}:00Z` });
  }
  return out;
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

function fmtMessageLine({ direction, text, ts }) {
  const who = direction === "out" ? "you" : "her";
  const t = ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "—";
  return `**${who}** ${t} ${text.replace(/\n/g, " ")}`;
}

function profileMd(profile) {
  const lines = [];
  if (profile.age != null) lines.push(`- age: ${profile.age}`);
  if (profile.distance_mi != null) lines.push(`- distance_mi: ${profile.distance_mi}`);
  if (profile.bio) lines.push(`- bio: ${JSON.stringify(profile.bio)}`);
  if (profile.occupation) lines.push(`- occupation: ${JSON.stringify(profile.occupation)}`);
  if (profile.location) lines.push(`- location_at_match: ${JSON.stringify(profile.location)}`);
  if (profile.badges?.length) lines.push(`- badges: ${profile.badges.join(", ")}`);
  return lines.join("\n");
}

async function existingSlugs() {
  const files = await readdir(RAW_DIR).catch(() => []);
  return new Set(files.filter(f => f.endsWith(".md")).map(f => f.replace(/\.md$/, "")));
}

function uniqueSlugSync({ name, source, city }, slugs) {
  const base = buildSlug({ name, source, city });
  if (!slugs.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = buildSlug({ name, source, city, suffix: i });
    if (!slugs.has(candidate)) return candidate;
  }
  throw new Error(`could not generate unique slug: ${base}`);
}

async function migrateOne(filename, slugs) {
  const path = resolve(SHAKOS_ENTITIES, filename);
  const entText = await readFile(path, "utf8");

  const name = getMeta(entText, "name");
  const matchId = getMeta(entText, "thread-id");
  if (!matchId) return { skipped: "no_match_id", filename };
  if (await findEntityByMatchId(matchId)) return { skipped: "already_migrated", matchId };

  const personId = getMeta(entText, "person-id");
  const ageRaw = getMeta(entText, "age");
  const age = ageRaw ? parseInt(ageRaw, 10) : null;
  const distanceRaw = getMeta(entText, "distance-at-match");
  const distance_mi = distanceRaw && /^\d+/.test(distanceRaw) ? parseInt(distanceRaw, 10) : null;
  const bio = getSection(entText, "Profile").match(/\*\*bio:\*\*\s*(.+)/)?.[1] || null;
  const location = getMeta(entText, "location");
  const occupation = getMeta(entText, "occupation");
  const phone = getMeta(entText, "phone");
  const matchDate = getMeta(entText, "match-date");
  const lastContact = getMeta(entText, "last-contact");
  const stage = getMeta(entText, "current-stage");
  const badgesStr = getMeta(entText, "badges");
  const badges = badgesStr ? badgesStr.split(",").map(s => s.trim()) : [];
  const source = getMeta(entText, "app") || "tinder";

  if (!name) return { skipped: "no_name", matchId };

  const city = await resolveCity({ phone, distance_mi });
  const slug = uniqueSlugSync({ name, source, city }, slugs);
  slugs.add(slug);

  // load conversation
  const convoBase = filename.replace(/\.md$/, "");
  let convoLines = [];
  try {
    const convoText = await readFile(resolve(SHAKOS_CONVOS, `${convoBase}.md`), "utf8");
    convoLines = parseShakosConvo(convoText).map(fmtMessageLine);
  } catch { /* no convo file */ }

  const meta = {
    slug,
    first_name: firstName(name),
    source,
    city,
    match_id: matchId,
    person_id: personId,
    phone: phone || null,
    status: statusFromShakos(stage),
    first_seen: matchDate ? `${matchDate}T00:00:00Z` : new Date().toISOString(),
    last_activity: lastContact ? lastContact.replace(" ", "T") + ":00Z" : new Date().toISOString(),
    last_scrape: new Date().toISOString(),
    previous_slugs: [],
    migrated_from_shakos: convoBase,
  };

  const profile = profileMd({ age, distance_mi, bio, location, occupation, badges });
  const conversation = convoLines.join("\n") || "(no messages)";
  const outbound = "(none — pre-migration)";

  const body = [
    fmYaml(meta),
    "",
    "## Profile",
    "",
    profile || "(no profile)",
    "",
    "## Conversation",
    "",
    conversation,
    "",
    "## Outbound log",
    "",
    outbound,
    "",
  ].join("\n");

  await writeFile(resolve(RAW_DIR, `${slug}.md`), body);
  return { written: slug, name, city, source };
}

async function main() {
  const files = (await readdir(SHAKOS_ENTITIES)).filter(f => f.endsWith(".md"));
  const slugs = await existingSlugs();
  let written = 0, skipped = 0;
  const skipReasons = {};
  for (const f of files) {
    try {
      const r = await migrateOne(f, slugs);
      if (r.written) written += 1;
      else { skipped += 1; skipReasons[r.skipped] = (skipReasons[r.skipped] || 0) + 1; }
    } catch (e) {
      console.error(`fail ${f}: ${e.message}`);
      skipped += 1;
      skipReasons.error = (skipReasons.error || 0) + 1;
    }
  }
  console.log(JSON.stringify({ written, skipped, skipReasons, total: files.length }, null, 2));
}

await main();
