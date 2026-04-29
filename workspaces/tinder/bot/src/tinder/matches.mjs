import { selectors } from "../runtime/detection.mjs";
import { gotoMatches, openThread } from "./page.mjs";
import { humanScroll, idlePause, sleep, jitter } from "../runtime/humanize.mjs";
import { logSession } from "../runtime/logger.mjs";
import { upsertMatch, appendMessages, findEntityByMatchId } from "../runtime/entity-store.mjs";
import { scanForHalts } from "../runtime/detection.mjs";
import { loadCaps } from "../runtime/caps.mjs";

async function pickFirst(page, sel) {
  const candidates = [sel.selector, ...(sel.alt || [])];
  for (const s of candidates) {
    const el = await page.$(s);
    if (el) return s;
  }
  return null;
}

async function pickAll(page, sel) {
  const candidates = [sel.selector, ...(sel.alt || [])];
  for (const s of candidates) {
    const els = await page.$$(s);
    if (els.length) return { sel: s, els };
  }
  return { sel: null, els: [] };
}

export async function scrapeMatches(page) {
  const sels = await selectors();
  await gotoMatches(page);
  await scanForHalts(page);

  const seen = new Map(); // href -> name
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

// Upsert a match's profile snapshot into its entity file. If we don't yet know
// the person's name we can't slug them, so we skip — the next pass that opens
// their thread will discover the name from the header.
export async function upsertMatchProfile({ matchId, personId, name, profile, phone = null }) {
  if (!name) return null;
  return await upsertMatch({ matchId, personId, name, source: "tinder", profile, phone });
}

export async function scrapeThread(page, matchId, { name = null, profile = {} } = {}) {
  const sels = await selectors();
  const caps = await loadCaps();
  await openThread(page, matchId);
  await scanForHalts(page);

  // Name MUST be passed in (from the matches list anchor text). The thread page header
  // is unreliable — picks up "You" from the side nav, "Messages" from the heading, etc.
  if (!name) {
    console.error(`scrapeThread: no name provided for ${matchId}; skipping entity write`);
    return { matchId, slug: null, messages_total: 0, messages_new: 0 };
  }

  const entityResult = await upsertMatch({ matchId, personId: null, name, source: "tinder", profile });

  const { els } = await pickAll(page, sels.thread_messages);
  const messages = [];
  for (const el of els) {
    const text = (await el.textContent())?.trim();
    if (!text) continue;
    const cls = await el.getAttribute("class") || "";
    const direction = /out|sent|from-me|self/i.test(cls) ? "out" : "in";
    messages.push({ direction, text, ts: null });
  }

  let added = 0;
  if (entityResult?.slug && messages.length) {
    const result = await appendMessages(entityResult.slug, messages);
    added = result.added;
  }

  await idlePause({ min: caps.scrape.between_thread_opens_ms[0], max: caps.scrape.between_thread_opens_ms[1] });
  return { matchId, slug: entityResult?.slug || null, messages_total: messages.length, messages_new: added };
}
