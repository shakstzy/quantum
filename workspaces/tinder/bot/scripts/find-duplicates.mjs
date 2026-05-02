#!/usr/bin/env node
// Read all raw/tinder/*.md and look for duplicate people.
// Two definitions of duplicate:
//   1) Same person_id (definitive)
//   2) Same first_name + age + similar visual identity (heuristic)
//
// Outputs counts and sample slugs.

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const RAW_DIR = "/Users/shakstzy/QUANTUM/raw/tinder";

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === "null" || v === "") v = null;
    if (v && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

async function main() {
  const files = (await readdir(RAW_DIR)).filter(f => f.endsWith(".md"));
  const entities = [];
  for (const f of files) {
    const text = await readFile(resolve(RAW_DIR, f), "utf8");
    const meta = parseFrontmatter(text);
    entities.push({
      slug: f.replace(/\.md$/, ""),
      match_id: meta.match_id || null,
      person_id: meta.person_id || null,
      first_name: meta.first_name || null,
      city: meta.city || null,
      status: meta.status || null,
    });
  }

  console.log(`total entity files: ${entities.length}`);

  // Duplicate by match_id (should be 0 unless something is broken)
  const byMatchId = new Map();
  for (const e of entities) {
    if (!e.match_id) continue;
    if (!byMatchId.has(e.match_id)) byMatchId.set(e.match_id, []);
    byMatchId.get(e.match_id).push(e.slug);
  }
  const dupMatchId = [...byMatchId.entries()].filter(([_, v]) => v.length > 1);
  console.log(`\n=== duplicate match_id (should be 0) ===`);
  console.log(`count: ${dupMatchId.length}`);
  for (const [id, slugs] of dupMatchId.slice(0, 10)) {
    console.log(`  ${id}: ${slugs.join(", ")}`);
  }

  // Duplicate by person_id (definitive — same human, two files)
  const byPersonId = new Map();
  for (const e of entities) {
    if (!e.person_id) continue;
    if (!byPersonId.has(e.person_id)) byPersonId.set(e.person_id, []);
    byPersonId.get(e.person_id).push(e);
  }
  const dupPersonId = [...byPersonId.entries()].filter(([_, v]) => v.length > 1);
  console.log(`\n=== duplicate person_id (same human, multiple match_ids) ===`);
  console.log(`distinct person_ids on disk: ${byPersonId.size}`);
  console.log(`person_ids with >1 file:     ${dupPersonId.length}`);
  console.log(`total inflated files:        ${dupPersonId.reduce((s, [_, v]) => s + v.length - 1, 0)}`);
  for (const [pid, list] of dupPersonId.slice(0, 15)) {
    console.log(`  person_id ${pid}:`);
    for (const e of list) console.log(`    ${e.slug}  (match_id ${e.match_id})`);
  }

  // person_id null counts
  const noPersonId = entities.filter(e => !e.person_id);
  console.log(`\n=== files with NO person_id (can't dedupe definitively) ===`);
  console.log(`count: ${noPersonId.length} / ${entities.length}`);

  // Heuristic: same first_name+city, same status (likely same person)
  // We also check the slug pattern <first>-<source>-<city> base + -N suffix
  const byBaseSlug = new Map();
  for (const e of entities) {
    const base = e.slug.replace(/-\d+$/, "");
    if (!byBaseSlug.has(base)) byBaseSlug.set(base, []);
    byBaseSlug.get(base).push(e);
  }
  const dupBaseSlug = [...byBaseSlug.entries()].filter(([_, v]) => v.length > 1);
  console.log(`\n=== same base-slug (first-source-city, ignoring -N suffix) ===`);
  console.log(`distinct base slugs: ${byBaseSlug.size}`);
  console.log(`base slugs with >1 file: ${dupBaseSlug.length}`);
  console.log(`total -N variants: ${dupBaseSlug.reduce((s, [_, v]) => s + v.length, 0)}`);
  console.log(`(NOTE: these may be different people sharing first name, OR the same person re-matched)`);
  for (const [base, list] of dupBaseSlug.slice(0, 15)) {
    console.log(`  ${base}: ${list.map(e => e.slug).join(", ")}`);
  }

  // Status breakdown
  const statusCounts = new Map();
  for (const e of entities) {
    const s = e.status || "(unset)";
    statusCounts.set(s, (statusCounts.get(s) || 0) + 1);
  }
  console.log(`\n=== status breakdown (frontmatter) ===`);
  for (const [s, n] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${n}`);
  }

  console.log("\n" + JSON.stringify({
    total: entities.length,
    distinct_match_ids: byMatchId.size,
    duplicate_match_ids: dupMatchId.length,
    distinct_person_ids: byPersonId.size,
    duplicate_person_ids: dupPersonId.length,
    inflation_from_person_id_dups: dupPersonId.reduce((s, [_, v]) => s + v.length - 1, 0),
    files_with_no_person_id: noPersonId.length,
    distinct_base_slugs: byBaseSlug.size,
    base_slugs_with_variants: dupBaseSlug.length,
  }));
}

main().catch(e => { console.error(e); process.exit(1); });
