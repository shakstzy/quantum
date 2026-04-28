#!/usr/bin/env node
import { launchPersistent } from "../src/runtime/profile.mjs";
import { sleep } from "../src/runtime/humanize.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, "../.dev-fixtures/recs-state.png");

const { ctx, page } = await launchPersistent({ headless: false });
try {
  await page.goto("https://tinder.com/app/recs", { waitUntil: "domcontentloaded" });
  await sleep(5000);
  await page.screenshot({ path: out, fullPage: false });
  console.log(`saved ${out}`);
  console.log(`url: ${page.url()}`);
  console.log(`title: ${await page.title()}`);
  // Try to read any visible "empty state" text
  const visibleText = await page.$$eval("h1, h2, h3, p, button", els => els.slice(0, 20).map(e => e.textContent?.trim()).filter(Boolean));
  console.log(`visible headings/buttons:`, visibleText);
} finally {
  await ctx.close();
}
