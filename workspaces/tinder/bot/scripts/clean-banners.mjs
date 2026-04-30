#!/usr/bin/env node
// One-time legacy cleanup: strip Tinder welcome banner lines from existing
// entity conversation sections. The new banner filter prevents future pulls
// from adding them, but lines already on disk persist via dedup.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RAW_DIR } from "../src/runtime/paths.mjs";

const BANNER_RE = /(you matched with|achievement unlocked|tinder gold|gold subscription|message blocked|profile blocked)/i;

const files = (await readdir(RAW_DIR)).filter(f => f.endsWith(".md"));
let touched = 0;
let stripped = 0;
for (const f of files) {
  const path = resolve(RAW_DIR, f);
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  const out = [];
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("**") && BANNER_RE.test(line)) { removed += 1; continue; }
    out.push(line);
  }
  if (removed > 0) {
    await writeFile(path, out.join("\n"));
    touched += 1;
    stripped += removed;
    console.log(`${f}: stripped ${removed}`);
  }
}
console.log(`\ntouched ${touched} files, stripped ${stripped} banner lines`);
