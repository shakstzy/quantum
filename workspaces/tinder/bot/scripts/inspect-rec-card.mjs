#!/usr/bin/env node
import { chromium } from "patchright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(__dirname, "../.dev-fixtures/recs.html");

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto(`file://${FIX}`);

// Show inner HTML of the first recCard
const cards = await page.$$("[class*='recCard']");
console.log(`recCard count: ${cards.length}`);
const html = await cards[0].innerHTML();
console.log("\n--- first recCard inner HTML (first 3000 chars) ---");
console.log(html.slice(0, 3000));

console.log("\n--- last recCard inner HTML (first 2000 chars) ---");
const lastHtml = await cards[cards.length - 1].innerHTML();
console.log(lastHtml.slice(0, 2000));

// Also show what data-testids exist anywhere
const tids = await page.$$eval("[data-testid]", els => [...new Set(els.map(e => e.getAttribute("data-testid")))]);
console.log("\n--- all data-testid values ---");
console.log(tids.join(", "));

await browser.close();
