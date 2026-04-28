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

  const matchLinks = new Set();
  for (let pass = 0; pass < 10; pass++) {
    const { els } = await pickAll(page, sels.matches_list_item);
    const before = matchLinks.size;
    for (const el of els) {
      const href = await el.getAttribute("href");
      if (href) matchLinks.add(href);
    }
    if (matchLinks.size === before) break;
    await humanScroll(page, { distance: jitter(280, 540), steps: jitter(5, 9) });
    await sleep(jitter(700, 1500));
  }

  const matches = [];
  for (const href of matchLinks) {
    const matchId = href.split("/").pop();
    matches.push({ matchId, href });
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

  // Try to read the displayed name from the thread header if not provided.
  let displayName = name;
  if (!displayName) {
    const headerCandidates = ["h1", "header h1", "[class*='matchName']", "[class*='name']"];
    for (const sel of headerCandidates) {
      try {
        const t = (await page.textContent(sel))?.trim();
        if (t && t.length < 60 && !/messages?$/i.test(t)) { displayName = t; break; }
      } catch { /* skip */ }
    }
  }

  let entityResult = null;
  if (displayName) {
    entityResult = await upsertMatch({ matchId, personId: null, name: displayName, source: "tinder", profile });
  }

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
