// Match list scrape + per-thread upsert. Skeleton.
// Actual implementation needs the match-list anchor href shape (`/conversations/<id>`?
// `/chat/<id>`? unknown until discovery).

import { selectors, scanForHalts } from "../runtime/detection.mjs";
import { gotoMatches } from "./page.mjs";
import { humanScroll, idlePause, sleep, jitter } from "../runtime/humanize.mjs";
import { logSession } from "../runtime/logger.mjs";
import { upsertMatch, appendMessages } from "../runtime/entity-store.mjs";
import { loadCaps } from "../runtime/caps.mjs";
import { parseExpiryIndicatorText } from "../runtime/expiry.mjs";

async function pickAll(page, sel) {
  const candidates = [sel.selector, ...(sel.alt || [])].filter(Boolean);
  for (const s of candidates) {
    const els = await page.$$(s);
    if (els.length) return { sel: s, els };
  }
  return { sel: null, els: [] };
}

export async function scrapeMatches(page) {
  const sels = await selectors();
  if (!sels.matches_list_item?.selector) {
    throw new Error("pre-discovery: scrapeMatches needs matches_list_item selector. Run scripts/discover-dom.mjs.");
  }
  await gotoMatches(page);
  await scanForHalts(page);

  const seen = new Map();
  for (let pass = 0; pass < 10; pass++) {
    const { els } = await pickAll(page, sels.matches_list_item);
    const before = seen.size;
    for (const el of els) {
      const href = await el.getAttribute("href");
      if (!href) continue;
      const name = (await el.textContent())?.trim() || null;
      if (!seen.has(href)) seen.set(href, name);
    }
    if (seen.size === before) break;
    await humanScroll(page, { distance: jitter(280, 540), steps: jitter(5, 9) });
    await sleep(jitter(700, 1500));
  }

  const matches = [];
  for (const [href, name] of seen.entries()) {
    const matchId = href.split("/").pop();
    matches.push({ matchId, href, name });
  }

  await logSession({ event: "matches_list_snapshot", count: matches.length, ids: matches.map(m => m.matchId) });
  return matches;
}

export async function scrapeThread(page, matchId, { name = null } = {}) {
  // Skeleton. Full implementation requires:
  //   - thread URL shape (from discovery)
  //   - thread profile pane structure (from discovery)
  //   - expiry indicator location (probably in the thread header)
  //   - opening_move text location
  //
  // For now, throw to fail loud rather than write garbage entities.
  throw new Error("pre-discovery: scrapeThread skeleton. Wire after scripts/discover-dom.mjs runs against a real thread.");
}
