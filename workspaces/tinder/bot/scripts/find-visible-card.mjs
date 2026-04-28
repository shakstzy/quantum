#!/usr/bin/env node
// Find the actively-displayed rec card. The recCard class is on photo containers
// (63 instances = preloaded card stack). The visible profile info (name as text,
// age, distance, bio) is rendered separately. Look for it.

import { chromium } from "patchright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(__dirname, "../.dev-fixtures/recs.html");

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto(`file://${FIX}`);

// The aria-label="Sasha" was on the first recCard photo div.
// Where else does "Sasha" appear in visible text?
const sashaText = await page.$$eval("*", (els) => {
  return els
    .filter(e => e.textContent?.includes("Sasha") && e.children.length === 0)
    .map(e => ({ tag: e.tagName, cls: e.className?.slice(0, 80), text: e.textContent.slice(0, 60), parent: e.parentElement?.tagName, parentCls: e.parentElement?.className?.slice(0, 80) }))
    .slice(0, 12);
});
console.log("=== visible text leaves containing 'Sasha' ===");
console.log(JSON.stringify(sashaText, null, 2));

// Also: where is '21' (age — common Tinder age) displayed near a name?
const ageText = await page.$$eval("h1, span, div", (els) => {
  return els
    .filter(e => /^\d{2}$/.test(e.textContent?.trim()))
    .filter(e => e.children.length === 0)
    .map(e => ({ tag: e.tagName, cls: typeof e.className === 'string' ? e.className.slice(0, 80) : '', text: e.textContent.trim(), parentCls: e.parentElement?.className?.toString().slice(0, 80) }))
    .slice(0, 8);
});
console.log("\n=== text leaves matching /^\\d{2}$/ (likely age) ===");
console.log(JSON.stringify(ageText, null, 2));

// Find the active rec profile container — it's likely a region with both name + age
const profileArea = await page.$$eval("[class*='recCard'], [class*='Profile'], main > div", (els) => {
  return els.slice(0, 5).map(e => ({
    cls: typeof e.className === "string" ? e.className.slice(0, 100) : '',
    childCount: e.children.length,
    snippet: e.outerHTML.slice(0, 250),
  }));
});
console.log("\n=== sample container outerHTML ===");
for (const c of profileArea) console.log(c);

await browser.close();
