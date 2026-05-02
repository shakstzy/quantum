#!/usr/bin/env node
// Probe specifically for data-qa-role attrs (Bumble's QA selector convention)
// and role="button" divs (since most actions aren't <button> tags).

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { sleep } from "../src/runtime/humanize.mjs";
import { DEV_FIXTURES_DIR } from "../src/runtime/paths.mjs";

const OUT_DIR = resolve(DEV_FIXTURES_DIR, `qa-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
await mkdir(OUT_DIR, { recursive: true });

const { ctx, page } = await launchPersistent({ headless: false });

async function probeBoth(page) {
  return await page.evaluate(() => {
    const qaRoles = {};
    for (const el of document.querySelectorAll("[data-qa-role]")) {
      const role = el.getAttribute("data-qa-role");
      qaRoles[role] = qaRoles[role] || [];
      if (qaRoles[role].length < 3) {
        qaRoles[role].push({
          tag: el.tagName,
          text: (el.textContent || "").trim().slice(0, 80),
          aria: el.getAttribute("aria-label"),
          cls: (el.getAttribute("class") || "").slice(0, 100),
          href: el.getAttribute("href"),
        });
      }
    }
    const roleButtons = [...document.querySelectorAll("[role='button']")].slice(0, 40).map(b => ({
      tag: b.tagName,
      text: (b.textContent || "").trim().slice(0, 60),
      aria: b.getAttribute("aria-label"),
      qaRole: b.getAttribute("data-qa-role"),
      cls: (b.getAttribute("class") || "").slice(0, 120),
    }));
    // Look for elements that look like swipe buttons by class name patterns
    const encButtons = [...document.querySelectorAll("[class*='encounters-action'], [class*='encounters-button'], [class*='swipe-action']")].slice(0, 20).map(b => ({
      tag: b.tagName,
      text: (b.textContent || "").trim().slice(0, 60),
      aria: b.getAttribute("aria-label"),
      qaRole: b.getAttribute("data-qa-role"),
      cls: (b.getAttribute("class") || "").slice(0, 200),
    }));
    return { qaRoles, roleButtons, encButtons };
  });
}

await page.goto("https://bumble.com/app", { waitUntil: "domcontentloaded", timeout: 25000 });
await sleep(5000);

const r = await probeBoth(page);
await writeFile(resolve(OUT_DIR, "qa.json"), JSON.stringify(r, null, 2));
console.log(`qaRoles found: ${Object.keys(r.qaRoles).length}`);
console.log(`role=button divs: ${r.roleButtons.length}`);
console.log(`encounters-action elements: ${r.encButtons.length}`);
console.log("\n=== qaRoles (top 40) ===");
for (const role of Object.keys(r.qaRoles).slice(0, 40)) {
  const sample = r.qaRoles[role][0];
  console.log(`  ${role}  -> ${sample.tag} text=${JSON.stringify(sample.text)} aria=${sample.aria}`);
}
console.log("\n=== role=button (top 20) ===");
for (const b of r.roleButtons.slice(0, 20)) {
  console.log(`  ${b.tag} text=${JSON.stringify(b.text)} aria=${b.aria} qa=${b.qaRole}`);
}
console.log("\n=== encounters-action elements ===");
for (const b of r.encButtons) {
  console.log(`  ${b.tag} text=${JSON.stringify(b.text)} aria=${b.aria} qa=${b.qaRole} cls=${b.cls.slice(0, 80)}`);
}

await ctx.close();
