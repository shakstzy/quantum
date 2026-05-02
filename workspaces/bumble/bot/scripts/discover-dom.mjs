#!/usr/bin/env node
// THROWAWAY discovery script. Run ONCE after manual login to map Bumble's
// post-auth surface. Dumps:
//   - URL, title, full innerText (first ~6kb) for each page we land on
//   - Survey of plausible selectors for: rec card, like/pass buttons, mode picker,
//     match list, thread input/send, expiry indicator, photo-verify modal.
//   - One full screenshot per surface
//   - One HTML dump of the swipe surface to .dev-fixtures/<ts>/swipe.html for
//     offline selector iteration (per learnings/2026-04-28-cache-html-during-scraper-dev.md)
//
// AFTER this script populates the answers, we wire them into config/selectors.json
// and src/bumble/*.mjs by hand. Then DELETE THIS SCRIPT — diag.mjs is the durable
// self-heal entry point.
//
// Gemini P1 #3: discovery runs through the same patchright stealth context as
// production (humanize is imported just to hold timing patterns even if we don't
// click anything; we only navigate + observe).

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { launchPersistent, gotoBumble } from "../src/runtime/profile.mjs";
import { sleep, jitter, idlePause } from "../src/runtime/humanize.mjs";
import { DEV_FIXTURES_DIR } from "../src/runtime/paths.mjs";

const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = resolve(DEV_FIXTURES_DIR, TS);
await mkdir(OUT_DIR, { recursive: true });

// Candidate URLs to probe. Order matters - start at the safest (root) and
// work outward. If a URL 404s or redirects, log it and continue.
const CANDIDATE_URLS = [
  { label: "root", url: "https://bumble.com/" },
  { label: "app", url: "https://bumble.com/app" },
  { label: "encounters", url: "https://bumble.com/app/encounters" },
  { label: "people", url: "https://bumble.com/app/people" },
  { label: "matches", url: "https://bumble.com/app/matches" },
  { label: "inbox", url: "https://bumble.com/app/inbox" },
  { label: "chat", url: "https://bumble.com/app/chat" },
  { label: "profile", url: "https://bumble.com/app/profile" },
  { label: "me", url: "https://bumble.com/app/me" },
];

// Selector candidate groups to survey on each surface.
const SURVEY = [
  { key: "rec_card", queries: [
    "[class*='card']", "[class*='profile-card']", "[data-qa-role*='card']",
    "[role='article']", "div[class*='swipe']",
  ]},
  { key: "like_button", queries: [
    "button[aria-label*='Like']", "button[aria-label*='like']",
    "button[data-qa-role*='like']", "button[class*='like']",
    "[role='button'][aria-label*='Yes']", "div[role='button'][class*='heart']",
  ]},
  { key: "pass_button", queries: [
    "button[aria-label*='Pass']", "button[aria-label*='No']", "button[aria-label*='Nope']",
    "button[data-qa-role*='pass']", "button[class*='pass']",
    "[role='button'][aria-label*='Skip']",
  ]},
  { key: "super_like_button", queries: [
    "button[aria-label*='SuperSwipe']", "button[aria-label*='super']",
    "button[data-qa-role*='superswipe']",
  ]},
  { key: "mode_picker", queries: [
    "button[aria-label*='Date']", "button[aria-label*='BFF']", "button[aria-label*='Bizz']",
    "[role='tablist']", "nav[aria-label*='mode']",
  ]},
  { key: "matches_tab", queries: [
    "a[href*='matches']", "a[href*='inbox']", "a[href*='chat']",
    "[role='tab']", "nav button[role='tab']",
  ]},
  { key: "matches_list_item", queries: [
    "a[href*='/conversations/']", "a[href*='/chat/']", "a[href*='/inbox/']",
    "[data-qa-role*='conversation']", "[role='listitem']",
  ]},
  { key: "thread_messages", queries: [
    "[role='log']", "[class*='message-list']", "[data-qa-role*='message-list']",
    "[class*='conversation']",
  ]},
  { key: "thread_input", queries: [
    "textarea[placeholder*='message']", "textarea[placeholder*='Message']",
    "textarea[aria-label*='message']", "div[contenteditable='true']",
    "[data-qa-role*='message-input']",
  ]},
  { key: "thread_send", queries: [
    "button[aria-label*='Send']", "button[type='submit']",
    "button[data-qa-role*='send']",
  ]},
  { key: "extend_match_button", queries: [
    "button[aria-label*='Extend']", "button[data-qa-role*='extend']",
  ]},
  { key: "match_expiry_indicator", queries: [
    "[class*='expir']", "[class*='timer']", "[class*='countdown']",
    "[aria-label*='expire']", "[aria-label*='hours left']",
  ]},
  { key: "photo_verify_modal", queries: [
    "[role='dialog'][aria-label*='Verif']",
    "[class*='verification']", "[class*='photo-verify']",
  ]},
  { key: "turnstile_iframe", queries: [
    "iframe[src*='challenges.cloudflare.com']", "iframe[src*='turnstile']",
  ]},
];

const { ctx, page } = await launchPersistent({ headless: false });

// CODEX-R6-P0-10: discover-dom is one of the riskiest moments. Hit Turnstile/
// photo-verify/login-wall checks after every navigation. Halt loudly instead
// of barreling through the mitigation surface.
async function bailOnMitigation(page, label) {
  const checks = [
    { kind: "turnstile_iframe", q: "iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile']" },
    { kind: "photo_verify_modal_text", q: "text=verify your photos" },
    { kind: "login_wall_text", q: "text=Sign in" },
  ];
  for (const c of checks) {
    try {
      const el = await page.$(c.q);
      if (el) {
        console.error(`discover-dom: bailing at ${label} - mitigation ${c.kind} present`);
        return c.kind;
      }
    } catch { /* skip */ }
  }
  return null;
}

const result = {};
try {
  for (const { label, url } of CANDIDATE_URLS) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await idlePause({ min: 2000, max: 4000 });
    } catch (e) {
      result[label] = { url, error: e.message };
      continue;
    }
    const mitigation = await bailOnMitigation(page, label);
    if (mitigation) {
      result[label] = { url, error: `mitigation_present:${mitigation}` };
      // Don't proceed to other URLs once a mitigation is up. Operator clears, re-runs.
      break;
    }
    const url_after = page.url();
    const title = await page.title();
    const text = (await page.evaluate(() => document.body?.innerText || "")).slice(0, 6000);
    const screenshot = resolve(OUT_DIR, `${label}.png`);
    try { await page.screenshot({ path: screenshot, fullPage: false }); } catch {}

    const surveyResult = {};
    for (const { key, queries } of SURVEY) {
      const hits = [];
      for (const q of queries) {
        const found = await page.evaluate((sel) => {
          try {
            const els = [...document.querySelectorAll(sel)];
            return els.slice(0, 5).map(e => ({
              tag: e.tagName,
              text: (e.textContent || "").trim().slice(0, 80),
              aria: e.getAttribute("aria-label"),
              cls: (e.getAttribute("class") || "").slice(0, 120),
              id: e.id || null,
              dataQa: e.getAttribute("data-qa-role"),
            }));
          } catch { return []; }
        }, q);
        if (found.length) hits.push({ query: q, count: found.length, sample: found });
      }
      surveyResult[key] = hits;
    }

    // Save HTML for offline iteration on the encounter surface only.
    if (label === "encounters" || label === "people" || label === "app") {
      try {
        const html = await page.content();
        await writeFile(resolve(OUT_DIR, `${label}.html`), html);
      } catch {}
    }

    result[label] = { url, url_after, title, text_first_6kb: text, screenshot, survey: surveyResult };
  }
} finally {
  await ctx.close();
}

const summaryPath = resolve(OUT_DIR, "discover-dom.json");
await writeFile(summaryPath, JSON.stringify(result, null, 2));
console.log(`done. summary written to ${summaryPath}`);
console.log(`screenshots + html in ${OUT_DIR}`);
for (const [label, r] of Object.entries(result)) {
  if (r.error) { console.log(`${label}: ERROR ${r.error}`); continue; }
  const hits = Object.entries(r.survey || {}).filter(([_, v]) => v.length > 0);
  console.log(`${label}: ${r.url_after} | ${hits.length} selector groups have hits`);
}
