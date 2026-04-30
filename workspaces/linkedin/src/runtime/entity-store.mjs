// Per-person markdown writer. One file per LinkedIn person at raw/linkedin/<slug>-linkedin.md.
// Frontmatter merge (preserves existing values when a fetch returns less detail). Append-only
// thread events under a "## Threads" section.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { RAW_DIR } from "./paths.mjs";
import { rawFilename } from "./slug.mjs";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

async function ensureRawDir() {
  await fs.mkdir(RAW_DIR, { recursive: true });
}

function parseFrontmatter(text) {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: text };
  const frontmatter = parseYamlFlat(m[1]);
  const body = text.slice(m[0].length);
  return { frontmatter, body };
}

// Tiny YAML-flat parser. Handles only `key: value`, `key: "string"`, `key: [a, b]`. No nesting.
// We control the writer so this is safe.
function parseYamlFlat(yaml) {
  const out = {};
  for (const line of yaml.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean);
    } else if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    } else if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (val === "null" || val === "") val = null;
    out[key] = val;
  }
  return out;
}

function renderFrontmatter(fm) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => JSON.stringify(String(x))).join(", ")}]`);
    } else if (typeof v === "boolean" || typeof v === "number") {
      lines.push(`${k}: ${v}`);
    } else if (typeof v === "string" && /[:#@\s"']|^\d/.test(v)) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

function mergeFrontmatter(existing, incoming, slug) {
  const merged = { ...existing, ...stripNulls(incoming) };
  // previous_slugs accumulates if slug changed
  const prev = Array.isArray(existing.previous_slugs) ? existing.previous_slugs : [];
  if (existing.slug && existing.slug !== slug && !prev.includes(existing.slug)) {
    merged.previous_slugs = [...prev, existing.slug];
  } else {
    merged.previous_slugs = prev;
  }
  merged.slug = slug;
  merged.first_seen = existing.first_seen ?? incoming.first_seen ?? new Date().toISOString();
  merged.last_action_at = new Date().toISOString();
  return merged;
}

function stripNulls(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

export async function upsertPerson({ slug, frontmatter = {}, profileSnapshot = null, threadEvent = null }) {
  if (!slug) throw new Error("upsertPerson: slug required");
  await ensureRawDir();
  const file = join(RAW_DIR, rawFilename(slug));

  // Lock target. proper-lockfile requires the path to exist; touch it first.
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, "", "utf8");
  }
  const release = await lockfile.lock(file, { retries: { retries: 8, minTimeout: 50 } });
  try {
    const existingText = await fs.readFile(file, "utf8");
    const { frontmatter: existingFm, body: existingBody } = existingText
      ? parseFrontmatter(existingText)
      : { frontmatter: {}, body: "" };

    const mergedFm = mergeFrontmatter(existingFm, frontmatter, slug);

    let body = existingBody.trim();
    if (profileSnapshot) {
      body = upsertSection(body, "Profile snapshot", profileSnapshot);
    }
    if (threadEvent) {
      body = appendThreadEvent(body, threadEvent);
    }
    const finalText = renderFrontmatter(mergedFm) + (body ? body + "\n" : "");
    await atomicWrite(file, finalText);
  } finally {
    await release();
  }
  return file;
}

async function atomicWrite(file, text) {
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

function upsertSection(body, heading, content) {
  const re = new RegExp(`(^|\\n)## ${escapeRegex(heading)}\\n[\\s\\S]*?(?=\\n## |$)`, "");
  const block = `\n## ${heading}\n${content.trim()}\n`;
  if (re.test(body)) return body.replace(re, block);
  return body + block;
}

function appendThreadEvent(body, event) {
  // event = { ts: ISO, direction: "outbound"|"inbound"|"system", text: string }
  // Dedupe: skip if a same-day same-direction same-text line already exists.
  // (Codex r2 P2: pull.mjs reruns on the same day duplicate system lines.)
  const heading = "## Threads";
  const ts = event.ts ?? new Date().toISOString();
  const dayBucket = ts.slice(0, 10); // YYYY-MM-DD
  const cleanText = event.text.replace(/\s+/g, " ").trim();
  const line = `### ${ts} — ${event.direction}: ${cleanText}`;
  if (body.includes(heading)) {
    // Find the Threads block.
    const re = new RegExp(`(\\n## Threads\\n[\\s\\S]*?)(?=\\n## |$)`, "");
    const match = body.match(re);
    if (match) {
      const block = match[0];
      // Dedupe key: same day + same direction + same text.
      const dupRe = new RegExp(
        `^### ${escapeRegex(dayBucket)}[^\\n]*\\s+\\u2014\\s+${escapeRegex(event.direction)}:\\s+${escapeRegex(cleanText)}\\s*$`,
        "m"
      );
      if (dupRe.test(block)) return body; // already present, no-op
    }
    return body.replace(re, (m) => m.trimEnd() + "\n" + line);
  }
  return body + `\n${heading}\n${line}\n`;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
