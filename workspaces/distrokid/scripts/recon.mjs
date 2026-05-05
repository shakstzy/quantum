#!/usr/bin/env node
// Recon: open /new/ on the persisted DistroKid profile, dump every form control
// (inputs, selects, textareas, buttons, radios, checkboxes) with selectors so
// upload.mjs can reference them. Writes JSON to ~/.quantum/distrokid/form-recon.json.

import { chromium } from "patchright";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".quantum/chrome-profiles/distrokid");
const OUT_DIR = join(homedir(), ".quantum/distrokid");
await mkdir(OUT_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  channel: "chrome",
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  timezoneId: "America/Chicago",
  args: ["--disable-blink-features=AutomationControlled", "--window-size=1440,900"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

console.log("navigating to /new/...");
await page.goto("https://distrokid.com/new/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.bringToFront();

// give React + lazy-loaded chunks time to mount
await page.waitForTimeout(5000);

const formData = await page.evaluate(() => {
  const out = { url: location.href, title: document.title, controls: [] };

  function nearestLabel(el) {
    if (el.id) {
      const lab = document.querySelector(`label[for="${el.id}"]`);
      if (lab) return lab.textContent.trim().slice(0, 100);
    }
    const wrap = el.closest("label");
    if (wrap) return wrap.textContent.trim().slice(0, 100);
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++) {
      const heading = p.querySelector("h1,h2,h3,h4,h5,legend,strong,b");
      if (heading) return heading.textContent.trim().slice(0, 100);
      p = p.parentElement;
    }
    return null;
  }

  const sel = "input, select, textarea, button, [role=checkbox], [role=radio], [role=button]";
  document.querySelectorAll(sel).forEach((el, i) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && el.type !== "hidden") return;
    out.controls.push({
      idx: i,
      tag: el.tagName,
      type: el.type || el.getAttribute("type") || null,
      role: el.getAttribute("role") || null,
      id: el.id || null,
      name: el.name || el.getAttribute("name") || null,
      value: (el.value || "").toString().slice(0, 80),
      placeholder: el.placeholder || null,
      ariaLabel: el.getAttribute("aria-label") || null,
      label: nearestLabel(el),
      text: (el.textContent || "").trim().slice(0, 80) || null,
      checked: el.checked === undefined ? null : el.checked,
      visible: r.width > 0 && r.height > 0,
      classes: (el.className || "").toString().slice(0, 80),
    });
  });

  // also dump all visible heading text in document order so we know section breaks
  out.headings = [];
  document.querySelectorAll("h1,h2,h3,h4,h5,h6,legend").forEach((h) => {
    const t = h.textContent.trim().slice(0, 100);
    if (t) out.headings.push({ tag: h.tagName, text: t });
  });

  return out;
});

await writeFile(join(OUT_DIR, "form-recon.json"), JSON.stringify(formData, null, 2));
console.log(`saved ${formData.controls.length} controls to ${OUT_DIR}/form-recon.json`);
console.log(`headings: ${formData.headings.length}`);
console.log(`url: ${formData.url}`);

await ctx.close();
