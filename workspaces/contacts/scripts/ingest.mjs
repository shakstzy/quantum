#!/usr/bin/env node
// macOS Contacts -> raw/contacts/<slug>.md (one file per Apple Contacts entry).
// Pulls via JXA (osascript -l JavaScript), canonicalizes, writes per-entity markdown.
// Idempotent: rescrapes rewrite frontmatter + Source mirror; preserves user-edited ## Notes.

import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(_execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const QUANTUM_ROOT = resolve(__dirname, "../../..");
const RAW_DIR = resolve(QUANTUM_ROOT, "raw/contacts");

await mkdir(RAW_DIR, { recursive: true });

// JXA script: dump every contact's full data as JSON to stdout.
// Uses a single osascript invocation (faster than per-contact round-trips).
const JXA_SCRIPT = `
const Contacts = Application("Contacts");
const people = Contacts.people();
const out = [];
for (let i = 0; i < people.length; i++) {
  const p = people[i];
  try {
    const phones = [];
    const phoneObjs = p.phones();
    for (let j = 0; j < phoneObjs.length; j++) phones.push(phoneObjs[j].value());
    const emails = [];
    const emailObjs = p.emails();
    for (let j = 0; j < emailObjs.length; j++) emails.push(emailObjs[j].value());
    const addresses = [];
    const addrObjs = p.addresses();
    for (let j = 0; j < addrObjs.length; j++) {
      const a = addrObjs[j];
      const parts = [a.street(), a.city(), a.state(), a.zip(), a.country()].filter(s => s);
      if (parts.length) addresses.push(parts.join(", "));
    }
    let birthday = null;
    try { const b = p.birthDate(); if (b) birthday = b.toISOString(); } catch (e) {}
    let modified = null;
    try { const m = p.modificationDate(); if (m) modified = m.toISOString(); } catch (e) {}
    out.push({
      id: p.id(),
      firstName: p.firstName() || null,
      lastName: p.lastName() || null,
      fullName: p.name() || null,
      organization: p.organization() || null,
      phones, emails, addresses, birthday, modified,
    });
  } catch (e) {}
}
JSON.stringify(out);
`;

function canonicalPhone(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/[a-z]/i.test(trimmed.replace(/^1-?800-?/i, ""))) return null; // mnemonic numbers (1-800-MY-APPLE)
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (digits.length >= 3 && digits.length <= 7 && !trimmed.startsWith("+")) return null; // shortcode, not E.164
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (trimmed.startsWith("+")) return `+${digits}`;
  return null;
}

function canonicalEmail(raw) {
  if (!raw) return null;
  return raw.trim().toLowerCase() || null;
}

function slugifyName(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveSlug({ firstName, lastName, phones }) {
  const f = slugifyName(firstName);
  const l = slugifyName(lastName);
  if (f && l) return `${f}-${l}`;
  const last4 = (phones[0] || "").replace(/\D/g, "").slice(-4);
  if (f && last4) return `${f}-${last4}`;
  if (last4) return `unnamed-${last4}`;
  if (f) return f;
  return `unnamed-${Date.now().toString(36).slice(-6)}`;
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
  return { rawFm: m[1], body: m[2] };
}

function extractSection(body, heading) {
  const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`);
  const m = body.match(re);
  return m ? m[1].trim() : "";
}

function readManualOverride(rawFm, key) {
  // Quick check: does the existing frontmatter set this key explicitly?
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = rawFm.match(re);
  if (!m) return null;
  const v = m[1].trim();
  if (v === "null") return null;
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

async function existingByIcId() {
  const files = (await readdir(RAW_DIR).catch(() => [])).filter(f => f.endsWith(".md"));
  const byIcId = new Map();
  const slugs = new Set();
  for (const f of files) {
    slugs.add(f.replace(/\.md$/, ""));
    const text = await readFile(resolve(RAW_DIR, f), "utf8");
    const { rawFm } = parseFrontmatter(text);
    if (!rawFm) continue;
    const m = rawFm.match(/^ic_id:\s*"?([^"\n]+)"?$/m);
    if (m) byIcId.set(m[1], { file: f, slug: f.replace(/\.md$/, ""), text });
  }
  return { byIcId, slugs };
}

async function main() {
  const start = Date.now();
  console.log("dumping macOS Contacts via JXA...");
  const { stdout } = await execFile("osascript", ["-l", "JavaScript", "-e", JXA_SCRIPT], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300000,
  });
  const dumped = JSON.parse(stdout);
  console.log(`dumped ${dumped.length} contacts in ${Math.round((Date.now() - start) / 1000)}s`);

  const { byIcId, slugs: existingSlugs } = await existingByIcId();
  let created = 0, updated = 0, renamed = 0;

  for (const c of dumped) {
    const phonesCanonical = [...new Set(c.phones.map(canonicalPhone).filter(Boolean))];
    const emailsCanonical = [...new Set(c.emails.map(canonicalEmail).filter(Boolean))];

    // skip entries with no usable identifier at all (no name, no phone, no email)
    if (!c.firstName && !c.lastName && phonesCanonical.length === 0 && emailsCanonical.length === 0) continue;

    let slug;
    let prevSlugs = [];
    let preservedNotes = "(empty)";
    let preservedCategory = null;
    let preservedTags = null;

    const existing = byIcId.get(c.id);
    if (existing) {
      const { rawFm, body } = parseFrontmatter(existing.text);
      const oldSlug = existing.slug;
      slug = deriveSlug({ firstName: c.firstName, lastName: c.lastName, phones: phonesCanonical });
      if (slug !== oldSlug) {
        // collision-safe rename
        let candidate = slug;
        for (let i = 2; existingSlugs.has(candidate) && candidate !== oldSlug; i++) {
          candidate = `${slug}-${i}`;
        }
        slug = candidate;
        prevSlugs = JSON.parse((rawFm.match(/^previous_slugs:\s*(\[.*?\])/m) || [, "[]"])[1] || "[]");
        if (!prevSlugs.includes(oldSlug)) prevSlugs.push(oldSlug);
        await rename(resolve(RAW_DIR, `${oldSlug}.md`), resolve(RAW_DIR, `${slug}.md`));
        existingSlugs.delete(oldSlug);
        existingSlugs.add(slug);
        renamed += 1;
      }
      preservedNotes = extractSection(body, "Notes") || "(empty)";
      preservedCategory = readManualOverride(rawFm, "category");
      preservedTags = readManualOverride(rawFm, "tags");
      updated += 1;
    } else {
      slug = deriveSlug({ firstName: c.firstName, lastName: c.lastName, phones: phonesCanonical });
      let candidate = slug;
      for (let i = 2; existingSlugs.has(candidate); i++) candidate = `${slug}-${i}`;
      slug = candidate;
      existingSlugs.add(slug);
      created += 1;
    }

    const now = new Date().toISOString();
    const meta = {
      slug,
      first_name: c.firstName,
      last_name: c.lastName,
      full_name: c.fullName,
      phones: phonesCanonical,
      emails: emailsCanonical,
      organization: c.organization,
      birthday: c.birthday,
      addresses: c.addresses,
      ic_id: c.id,
      category: preservedCategory || "person",
      tags: [],
      first_seen: existing ? null : now,
      last_seen: now,
      previous_slugs: prevSlugs,
    };
    if (existing) {
      const { rawFm } = parseFrontmatter(existing.text);
      const fs = (rawFm.match(/^first_seen:\s*"?([^"\n]+)"?$/m) || [])[1];
      if (fs) meta.first_seen = fs;
    }

    const sourceMirror = [
      `- raw_phones: ${JSON.stringify(c.phones)}`,
      `- raw_emails: ${JSON.stringify(c.emails)}`,
      `- last_modified: ${c.modified || "null"}`,
    ].join("\n");

    const out = [
      fmYaml(meta),
      "",
      "## Notes",
      "",
      preservedNotes,
      "",
      "## Source mirror",
      "",
      sourceMirror,
      "",
    ].join("\n");

    await writeFile(resolve(RAW_DIR, `${slug}.md`), out);
  }

  console.log(JSON.stringify({ dumped: dumped.length, created, updated, renamed, elapsed_sec: Math.round((Date.now() - start) / 1000) }, null, 2));
}

await main();
