// DOM navigation helpers. Used by the connect-button flow when Voyager isn't enough.

import { promises as fs } from "node:fs";
import { SELECTORS_FILE } from "../../runtime/paths.mjs";
import { sleep, jitter } from "../../runtime/humanize.mjs";

let _selectors = null;
async function selectors() {
  if (_selectors) return _selectors;
  _selectors = JSON.parse(await fs.readFile(SELECTORS_FILE, "utf8"));
  return _selectors;
}

export async function findFirstMatching(page, chain, { timeoutMs = 5000 } = {}) {
  for (const sel of chain) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: "attached", timeout: timeoutMs });
      return { locator: loc, selector: sel };
    } catch { /* try next */ }
  }
  return null;
}

export async function findTopCard(page, { timeoutMs = 8000 } = {}) {
  const sel = await selectors();
  const hit = await findFirstMatching(page, sel.connect.top_card, { timeoutMs });
  if (!hit) throw new Error("findTopCard: no top card matched");
  return hit;
}

export async function gotoProfile(page, publicId) {
  const url = `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(jitter(900, 1800));
  return url;
}
