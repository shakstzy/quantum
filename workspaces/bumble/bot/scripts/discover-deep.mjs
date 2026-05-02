#!/usr/bin/env node
// Deeper discovery probe targeting bumble.com/app SPA. Inspects:
//   - all buttons (tag, aria-label, data-* attrs, text, class)
//   - all anchors (href + text)
//   - thread surface when one conversation is clicked
// Output: .dev-fixtures/<ts>/deep.json + screenshots

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { sleep, jitter, idlePause } from "../src/runtime/humanize.mjs";
import { DEV_FIXTURES_DIR } from "../src/runtime/paths.mjs";

const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = resolve(DEV_FIXTURES_DIR, `deep-${TS}`);
await mkdir(OUT_DIR, { recursive: true });

const { ctx, page } = await launchPersistent({ headless: false });

async function inventory(page) {
  return await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].map(b => ({
      tag: b.tagName,
      text: (b.textContent || "").trim().slice(0, 60),
      aria: b.getAttribute("aria-label"),
      qaRole: b.getAttribute("data-qa-role"),
      cls: (b.getAttribute("class") || "").slice(0, 120),
      type: b.getAttribute("type"),
      id: b.id || null,
    })).filter(x => x.text || x.aria || x.qaRole);

    const a = [...document.querySelectorAll("a")].map(e => ({
      text: (e.textContent || "").trim().slice(0, 80),
      href: e.getAttribute("href"),
      cls: (e.getAttribute("class") || "").slice(0, 120),
      qaRole: e.getAttribute("data-qa-role"),
    })).filter(x => x.href);

    const inputs = [...document.querySelectorAll("input, textarea, [contenteditable='true']")].map(e => ({
      tag: e.tagName,
      type: e.type || null,
      placeholder: e.placeholder,
      aria: e.getAttribute("aria-label"),
      qaRole: e.getAttribute("data-qa-role"),
      cls: (e.getAttribute("class") || "").slice(0, 120),
      contenteditable: e.getAttribute("contenteditable"),
      role: e.getAttribute("role"),
    }));

    // Top-level structural tags
    const sections = [...document.querySelectorAll("section, nav, main, aside, [role='main']")].slice(0, 30).map(e => ({
      tag: e.tagName,
      cls: (e.getAttribute("class") || "").slice(0, 120),
      qaRole: e.getAttribute("data-qa-role"),
      role: e.getAttribute("role"),
      ariaLabel: e.getAttribute("aria-label"),
      childCount: e.children.length,
    }));

    return { buttons: btn.slice(0, 80), anchors: a.slice(0, 80), inputs, sections };
  });
}

const result = {};

// === Surface 1: /app (encounters + sidebar) ===
await page.goto("https://bumble.com/app", { waitUntil: "domcontentloaded", timeout: 25000 });
await sleep(4500);
result.app = {
  url: page.url(),
  title: await page.title(),
  inventory: await inventory(page),
  screenshot: resolve(OUT_DIR, "app.png"),
};
try { await page.screenshot({ path: result.app.screenshot, fullPage: false }); } catch {}
try { await writeFile(resolve(OUT_DIR, "app.html"), await page.content()); } catch {}

// === Surface 2: open one conversation (click first conversation in sidebar) ===
const convClicked = await page.evaluate(() => {
  // Find clickable conversation elements in the sidebar.
  const candidates = [
    ...document.querySelectorAll("[data-qa-role='conversation-item']"),
    ...document.querySelectorAll(".contact"),
    ...document.querySelectorAll("[class*='contact-item']"),
    ...document.querySelectorAll("[class*='conversation-item']"),
  ];
  for (const c of candidates) {
    const r = c.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) { c.click(); return { clicked: c.tagName, cls: c.getAttribute("class") }; }
  }
  return null;
});
await sleep(3500);
if (convClicked) {
  result.thread = {
    url: page.url(),
    clicked: convClicked,
    inventory: await inventory(page),
    screenshot: resolve(OUT_DIR, "thread.png"),
  };
  try { await page.screenshot({ path: result.thread.screenshot, fullPage: false }); } catch {}
  try { await writeFile(resolve(OUT_DIR, "thread.html"), await page.content()); } catch {}
}

await ctx.close();

await writeFile(resolve(OUT_DIR, "deep.json"), JSON.stringify(result, null, 2));
console.log(`done. output: ${OUT_DIR}`);
console.log(`app: ${result.app?.inventory?.buttons?.length || 0} buttons / ${result.app?.inventory?.anchors?.length || 0} anchors / ${result.app?.inventory?.inputs?.length || 0} inputs`);
console.log(`thread: ${result.thread?.inventory?.buttons?.length || 0} buttons / ${result.thread?.inventory?.inputs?.length || 0} inputs`);
