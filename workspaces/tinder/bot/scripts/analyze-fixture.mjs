#!/usr/bin/env node
// Loads .dev-fixtures/*.html via file:// in headless patchright and probes
// candidate selectors. Pure offline analysis; no Tinder traffic.

import { chromium } from "patchright";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = resolve(__dirname, "../.dev-fixtures");

async function probe(label, htmlPath, candidates) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`file://${htmlPath}`);
  console.log(`\n=== ${label} ===`);
  for (const [name, sels] of Object.entries(candidates)) {
    let hit = null;
    let count = 0;
    for (const sel of sels) {
      try {
        const els = await page.$$(sel);
        if (els.length) {
          if (!hit) { hit = sel; count = els.length; }
        }
      } catch (e) { /* invalid sel */ }
    }
    if (hit) {
      let sampleText = "";
      try {
        const el = await page.$(hit);
        sampleText = (await el.textContent())?.slice(0, 80).replace(/\s+/g, " ").trim();
      } catch {}
      console.log(`  OK   ${name.padEnd(24)} ${count.toString().padStart(3)}x  ${hit}${sampleText ? `   "${sampleText}"` : ""}`);
    } else {
      console.log(`  MISS ${name.padEnd(24)}     tried ${sels.length} candidates`);
    }
  }
  await browser.close();
}

await probe("recs.html", resolve(FIX_DIR, "recs.html"), {
  rec_card: ["[class*='recCard']", "main [role='button'][aria-label*='Profile']"],
  rec_card_name: [
    "[class*='recCard'] h1",
    "[class*='recCard'] span[itemprop='name']",
    "[data-testid='Heading'] span",
    "[class*='Name']",
    "main h1",
    "[role='heading'][aria-level='1']",
  ],
  rec_card_age: [
    "span[itemprop='age']",
    "[class*='recCard'] [data-testid='subtitle-0']",
    "[data-testid='subtitle-0']",
    "[class*='age']",
  ],
  rec_card_distance: [
    "[class*='distance']",
    "[class*='recCard'] [data-testid='subtitles']",
  ],
  rec_card_bio: [
    "div[class*='Bio'] > div",
    "[class*='aboutMe']",
    "[data-testid='aboutMe']",
  ],
  like_button: [
    "button.gamepad-button[class*='sparks-like']",
    "button.gamepad-button[class*='gamepad-sparks-like-default']",
    "button[aria-label='Like']",
  ],
  nope_button: [
    "button.gamepad-button[class*='sparks-nope']",
    "button.gamepad-button[class*='gamepad-sparks-nope-default']",
    "button[aria-label='Nope']",
  ],
  super_like_button: [
    "button.gamepad-button[class*='sparks-super-like']",
  ],
  matches_tab: [
    "a[href='/app/matches']",
    "nav a[aria-label*='Matches']",
    "a[href*='/app/matches']",
    "[role='tab'][aria-selected='true']",
  ],
});

await probe("matches.html", resolve(FIX_DIR, "matches.html"), {
  matches_tab: [
    "a[href='/app/matches']",
    "nav a[aria-label*='Matches']",
    "[role='tab'][aria-controls*='matches']",
    "button[role='tab']",
  ],
  matches_list_item: [
    "a[href^='/app/messages/']",
  ],
});

await probe("thread.html", resolve(FIX_DIR, "thread.html"), {
  thread_messages: [
    "[class*='msg']",
    "main [role='log'] [data-testid*='message']",
    "[class*='message']",
    "[class*='Message']",
    "[class*='msgRow']",
    "[role='log'] > div",
    "[data-testid*='message']",
  ],
  thread_input: [
    "textarea[placeholder*='Type a message']",
    "textarea#chatTextArea",
    "textarea",
  ],
  thread_send: [
    "button[type='submit']:has-text('Send')",
    "button[aria-label='Send message']",
    "form button[type='submit']",
  ],
});
