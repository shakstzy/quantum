#!/usr/bin/env node
// resume.mjs — pick up an in-progress upload draft and click through any remaining
// post-submit steps (Mixea upsell, final review, etc) until /mymusic or terminal page.
// Usage: node scripts/resume.mjs --albumuuid <uuid> [--mode mixea|continue]

import { chromium } from "patchright";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, a) => {
    if (v.startsWith("--")) acc.push([v.slice(2), a[i + 1]]);
    return acc;
  }, [])
);
const UUID = args.albumuuid;
const START = args.mode === "mixea" ? `https://distrokid.com/new/mixea/?albumuuid=${UUID}` : `https://distrokid.com/new/?albumuuid=${UUID}`;
if (!UUID) { console.error("usage: --albumuuid <uuid> [--mode mixea|continue]"); process.exit(2); }

const PROFILE_DIR = join(homedir(), ".quantum/chrome-profiles/distrokid");
const RUN_DIR = join(homedir(), ".quantum/distrokid/runs", new Date().toISOString().replace(/[:.]/g, "-") + "-resume");
await mkdir(RUN_DIR, { recursive: true });
console.log(`[resume] albumuuid=${UUID}`);
console.log(`[resume] start=${START}`);
console.log(`[resume] runDir=${RUN_DIR}`);

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  channel: "chrome",
  viewport: { width: 1440, height: 900 },
  args: ["--disable-blink-features=AutomationControlled", "--window-size=1440,900"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

async function snap(name) {
  const p = join(RUN_DIR, `${Date.now()}-${name}.png`);
  try { await page.screenshot({ path: p, fullPage: true }); console.log(`[snap] ${name}`); } catch {}
}

await page.goto(START, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.bringToFront();
await page.waitForTimeout(3000);
console.log(`[url] ${page.url()}`);
await snap("loaded");

// Loop: at each step, pick the cheapest option ($0 / "use my originals" / decline) and click Continue.
// Stop when URL leaves /new/ tree or we hit the same URL twice.
const seen = new Set();
for (let i = 0; i < 6; i++) {
  const url = page.url();
  console.log(`[iter ${i}] url=${url}`);
  if (!/distrokid\.com\/new\//.test(url)) {
    console.log(`[done] left /new/ tree`);
    break;
  }
  if (seen.has(url)) {
    console.log(`[stuck] same URL twice — bailing`);
    break;
  }
  seen.add(url);

  // 1. Click the "Use my originals" card. It's a styled radio: clicking the card
  //    text propagates to the underlying input. Try multiple strategies.
  let picked = null;
  // Strategy A: text-targeted click on visible "Use my originals" card.
  try {
    const card = page.getByText(/use my originals/i).first();
    if (await card.count()) {
      await card.click({ timeout: 5000 });
      picked = { strategy: "text-click", label: "Use my originals" };
    }
  } catch {}
  // Strategy B: programmatic radio.
  if (!picked) {
    picked = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[type=radio]'));
      for (const r of radios) {
        // walk DOM up looking for any text containing "originals" or "$0"
        let p = r;
        for (let i = 0; i < 6 && p; i++) {
          const t = (p.textContent || "").toLowerCase();
          if (/use my originals/.test(t) || (t.includes("$0") && !t.includes("$10"))) {
            r.checked = true;
            r.dispatchEvent(new Event("change", { bubbles: true }));
            r.click();
            return { strategy: "ancestor-radio", id: r.id || r.name };
          }
          p = p.parentElement;
        }
      }
      return null;
    });
  }
  console.log(`  picked:`, picked);

  await page.waitForTimeout(1500);
  await snap(`iter${i}-picked`);

  // 2. Click Continue / Submit / Place Order. Wait for it to be enabled.
  let clicked = null;
  try {
    const btn = page.getByRole("button", { name: /^(continue|submit|place order|complete|finish|distribute|finalize)$/i }).first();
    if (await btn.count()) {
      await btn.waitFor({ state: "visible", timeout: 5000 });
      // wait for enabled
      for (let attempt = 0; attempt < 10; attempt++) {
        const enabled = await btn.isEnabled();
        if (enabled) break;
        await page.waitForTimeout(500);
      }
      const txt = (await btn.innerText()).trim();
      await btn.click({ force: true });
      clicked = { strategy: "role-button", txt };
    }
  } catch (e) {
    console.log(`  role-button click failed: ${e.message.slice(0, 80)}`);
  }
  if (!clicked) {
    clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type=button], input[type=submit], a.button'));
      const visible = btns.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !b.disabled;
      });
      for (const b of visible) {
        const txt = ((b.value || b.textContent || "").trim()).toLowerCase();
        if (/^(continue|submit|place order|complete|finish|distribute|finalize)$/i.test(txt)) {
          b.click();
          return { strategy: "evaluate", txt };
        }
      }
      return null;
    });
  }
  console.log(`  clicked:`, clicked);
  if (!clicked) {
    console.log(`  no continue button — bailing`);
    await snap(`iter${i}-no-button`);
    break;
  }

  await page.waitForTimeout(5000);
  await snap(`iter${i}-after-click`);
}

console.log(`[final] url=${page.url()}`);
await snap("final");
await writeFile(join(RUN_DIR, "metadata.json"), JSON.stringify({ albumuuid: UUID, finalUrl: page.url(), at: new Date().toISOString() }, null, 2));

await ctx.close();
console.log(`[done] ${RUN_DIR}`);
