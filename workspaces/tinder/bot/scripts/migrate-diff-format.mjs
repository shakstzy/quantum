#!/usr/bin/env node
// One-time migration: clear old prose-format profile-diff blocks. The next pull
// will produce JSON-fenced blocks per the new format. Old prose data was lossy
// anyway (regex-parsed) so flushing is fine.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RAW_DIR } from "../src/runtime/paths.mjs";

const files = (await readdir(RAW_DIR)).filter(f => f.endsWith(".md"));
let touched = 0;
for (const f of files) {
  const path = resolve(RAW_DIR, f);
  const text = await readFile(path, "utf8");
  // Match the entire ## Profile changes section and reset to "(none yet)"
  // ONLY if it contains old prose blocks (### timestamps) and no JSON blocks.
  const hasProse = /\n### 20\d\d-/.test(text);
  const hasJson = /```json profile-diff/.test(text);
  if (!hasProse || hasJson) continue;
  const replaced = text.replace(/(## Profile changes\n\n)([\s\S]*?)(?=\n## )/, "$1(none yet)\n");
  if (replaced !== text) {
    await writeFile(path, replaced);
    touched += 1;
    console.log(`migrated ${f}`);
  }
}
console.log(`\ntouched ${touched} files`);
