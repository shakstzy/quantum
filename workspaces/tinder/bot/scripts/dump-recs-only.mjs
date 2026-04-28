#!/usr/bin/env node
// One-shot dump of /app/recs only, to refresh fixture after Tinder layout drift.
import { launchPersistent } from "../src/runtime/profile.mjs";
import { sleep } from "../src/runtime/humanize.mjs";
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, "../.dev-fixtures/recs-v2.html");

const { ctx, page } = await launchPersistent({ headless: false });
try {
  await page.goto("https://tinder.com/app/recs", { waitUntil: "domcontentloaded" });
  await sleep(5000);
  const html = await page.content();
  await writeFile(out, html);
  console.log(`saved ${html.length} chars`);
} finally {
  await ctx.close();
}
