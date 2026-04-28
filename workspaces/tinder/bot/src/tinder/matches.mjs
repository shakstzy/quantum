import { selectors } from "../runtime/detection.mjs";
import { gotoMatches, openThread } from "./page.mjs";
import { humanScroll, idlePause, sleep, jitter } from "../runtime/humanize.mjs";
import { logMatch, logThreadMessage } from "../runtime/logger.mjs";
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

  await logMatch({ event: "list_snapshot", count: matches.length, ids: matches.map(m => m.matchId) });
  return matches;
}

export async function scrapeThread(page, matchId, { maxThreads } = {}) {
  const sels = await selectors();
  const caps = await loadCaps();
  await openThread(page, matchId);
  await scanForHalts(page);

  const { els } = await pickAll(page, sels.thread_messages);
  const messages = [];
  for (const el of els) {
    const text = (await el.textContent())?.trim();
    if (!text) continue;
    const cls = await el.getAttribute("class") || "";
    const direction = /out|sent|from-me|self/i.test(cls) ? "out" : "in";
    messages.push({ direction, text });
  }

  for (const m of messages) {
    await logThreadMessage({ match_id: matchId, ...m });
  }

  await idlePause({ min: caps.scrape.between_thread_opens_ms[0], max: caps.scrape.between_thread_opens_ms[1] });
  return { matchId, messages };
}
