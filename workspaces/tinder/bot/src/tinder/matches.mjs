import { selectors } from "../runtime/detection.mjs";
import { gotoMatches, openThread, readThreadProfile } from "./page.mjs";
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

export async function scrapeThread(page, matchId, { name = null, profile = null } = {}) {
  const sels = await selectors();
  const caps = await loadCaps();
  await openThread(page, matchId);
  await scanForHalts(page);

  // CODEX-CRIT-1: assert URL settled on the right matchId before reading anything.
  // Tinder's SPA can silently redirect on unmatched/expired matches; without this
  // we'd attribute the previous match's profile + messages to the new matchId.
  const settledUrl = page.url();
  if (!settledUrl.endsWith(matchId)) {
    console.error(`scrapeThread: thread_redirect for ${matchId}, ended on ${settledUrl}; skipping`);
    return { matchId, slug: null, messages_total: 0, messages_new: 0, url_redirected: true };
  }

  // Name MUST be passed in (from the matches list anchor text). The thread page header
  // is unreliable — picks up "You" from the side nav, "Messages" from the heading, etc.
  if (!name) {
    console.error(`scrapeThread: no name provided for ${matchId}; skipping entity write`);
    return { matchId, slug: null, messages_total: 0, messages_new: 0 };
  }

  // Capture the profile pane (bio, age, distance, interests, basics, lifestyle).
  // If the caller already passed a profile (e.g. from card-stack swipe) prefer that.
  // CODEX-IMP-6: a failed read returns null (not {}) so we can distinguish
  // "capture failed" from "captured empty profile" downstream.
  let scraped = profile;
  if (!scraped) {
    try {
      scraped = await readThreadProfile(page);
      // Sanity check: if we got NO scalar fields AT ALL (no name, no age, no bio,
      // no distance, no basics/lifestyle/interests entries) treat as failed read.
      const nothing = !scraped.name && !scraped.age && !scraped.bio && !scraped.distance_mi
        && (!scraped.basics || !Object.keys(scraped.basics).length)
        && (!scraped.lifestyle || !Object.keys(scraped.lifestyle).length)
        && (!Array.isArray(scraped.interests) || scraped.interests.length === 0);
      if (nothing) scraped = null;
    } catch (e) { console.error(`readThreadProfile failed for ${matchId}: ${e.message}`); scraped = null; }
  }
  // CODEX-CRIT-2: profile pane name should match the matches-list name. If not,
  // refuse to persist — likely a stale pane or wrong-recipient situation.
  if (scraped?.name) {
    const paneFirst = String(scraped.name).split(/\s+/)[0]?.toLowerCase() || "";
    const expectedFirst = String(name).split(/\s+/)[0]?.toLowerCase() || "";
    if (paneFirst && expectedFirst && paneFirst !== expectedFirst) {
      console.error(`scrapeThread: pane name "${scraped.name}" != expected "${name}" for ${matchId}; refusing profile write`);
      scraped = null;
    }
  }

  // CODEX-IMP-6: pass null when capture failed; entity-store will skip diff path
  // and preserve existing stored profile rather than wiping it to "(no profile yet)".
  const entityResult = await upsertMatch({ matchId, personId: null, name, source: "tinder", profile: scraped });

  const { els } = await pickAll(page, sels.thread_messages);
  const messages = [];
  // CODEX-IMP-15: anchor banner detection on the literal "You Matched with " prefix
  // (always at start, exact case+space) rather than a broad substring regex that
  // would drop legitimate replies like "you matched with my mom haha".
  const isBanner = (text) => /^You Matched with\b/.test(text)
    || /Achievement unlocked!?$/.test(text)
    || /^Looking for/.test(text); // Tinder shows this in chat header occasionally
  for (const el of els) {
    const text = (await el.textContent())?.trim();
    if (!text) continue;
    if (isBanner(text)) continue;
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
  return {
    matchId,
    slug: entityResult?.slug || null,
    messages_total: messages.length,
    messages_new: added,
    profile_diff: entityResult?.profile_diff || null,
  };
}
