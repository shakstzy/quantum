// Match list scrape + per-thread snapshot.
// Bumble web shape: ALL conversations live in the sidebar at /app. There is no
// per-thread URL; opening a thread = clicking the contact row. matchId is the
// `data-qa-uid` attribute on each row (stable opaque Bumble identifier).

import { selectors, scanForHalts } from "../runtime/detection.mjs";
import { gotoMatches, openThread, readThreadProfile } from "./page.mjs";
import { humanScroll, idlePause, sleep, jitter } from "../runtime/humanize.mjs";
import { logSession } from "../runtime/logger.mjs";
import { upsertMatch, appendMessages } from "../runtime/entity-store.mjs";
import { loadCaps } from "../runtime/caps.mjs";
import { assertDateMode } from "../runtime/mode-guard.mjs";
import { parseExpiryIndicatorText } from "../runtime/expiry.mjs";

// Read all contact rows from the sidebar. Returns one entry per row with the
// stable matchId, the clean name, and any visible expiry signal.
export async function scrapeMatches(page) {
  const sels = await selectors();
  if (!sels.matches_list_item?.selector) {
    throw new Error("missing_selector: matches_list_item. Run scripts/discover-dom.mjs.");
  }
  await gotoMatches(page);
  await scanForHalts(page);
  // CODEX-R6-P0-9: assert Date mode after navigation. /app surface is where
  // mode_picker selectors resolve - asserting before navigation always nulls.
  await assertDateMode(page);

  // Scroll through the conversations list to load all rows (lazy-rendered).
  // Cap at 12 scroll passes - typical user has < 50 active conversations.
  for (let pass = 0; pass < 12; pass++) {
    const before = await page.$$eval(sels.matches_list_item.selector, els => els.length);
    await humanScroll(page, { distance: jitter(280, 540), steps: jitter(5, 9) });
    await sleep(jitter(700, 1500));
    await scanForHalts(page);
    const after = await page.$$eval(sels.matches_list_item.selector, els => els.length);
    if (after === before) break;
  }

  const matches = await page.$$eval(sels.matches_list_item.selector, els => els.map(el => {
    const matchId = el.getAttribute("data-qa-uid");
    const name = el.getAttribute("data-qa-name") || el.querySelector(".contact__name-text")?.textContent?.trim() || null;
    // Expiry signals.
    const expiryText = el.querySelector(".contact__expiration-status-text")?.textContent?.trim() || null;
    const progressAttr = el.querySelector(".contact__avatar")?.getAttribute("data-progress");
    const expiryProgress = progressAttr != null ? parseInt(progressAttr, 10) : null; // 0-100, 0=expired
    const yourMove = !!el.querySelector("[class*='move-label']") || (el.textContent || "").includes("Your move");
    const isSelected = (el.getAttribute("class") || "").includes("is-selected");
    return { matchId, name, expiryText, expiryProgress, yourMove, isSelected };
  }));
  // Filter rows that don't have a stable id (promo cards like "Match Queue" Beeline).
  const real = matches.filter(m => m.matchId && m.name);
  const promo = matches.length - real.length;

  await logSession({ event: "matches_list_snapshot", count: real.length, promo_skipped: promo });
  return real;
}

// Open the thread for a given matchId, scrape its message log + profile pane.
// Returns { matchId, slug, messages_total, messages_new, profile_diff, expires_at }.
// `sidebarHints` (optional) is the row from scrapeMatches with expiryText/expiryProgress;
// pass it through so we don't re-scrape what we already saw.
export async function scrapeThread(page, matchId, { name = null, sidebarHints = null } = {}) {
  const sels = await selectors();
  const caps = await loadCaps();
  // CODEX-R7-P0-3: thread_messages selector must be wired before scraping a
  // thread. Without it, page.$$eval(undefined) throws AFTER we've already
  // opened the thread (visible Bumble navigation with no useful scrape).
  if (!sels.thread_messages?.selector) {
    throw new Error("missing_selector: thread_messages. Run scripts/discover-dom.mjs.");
  }
  await openThread(page, matchId);
  await scanForHalts(page);

  // Read messages.
  const messages = await page.$$eval(sels.thread_messages.selector, els => els.map(el => {
    const cls = el.getAttribute("class") || "";
    const direction = /\bmessage--out\b|\bmessage--from-me\b/.test(cls) ? "out"
                    : /\bmessage--in\b/.test(cls) ? "in" : null;
    if (!direction) return null;
    const inner = el.querySelector(".message__content") || el;
    const text = (inner.textContent || "").trim();
    return text ? { direction, text, ts: null } : null;
  }).filter(Boolean));

  // Read profile pane and parse name + age etc.
  let profile = null;
  try { profile = await readThreadProfile(page); }
  catch (e) { console.error(`readThreadProfile failed: ${e.message}`); profile = null; }

  // CODEX-R8-P1 / GEMINI-P1: expiry parsing now uses parseExpiryIndicatorText,
  // which handles "X hours", "X hrs", "X minutes", "X min", "<1h", "expired".
  // Falls back to sidebar hints from scrapeMatches when the in-thread notice
  // is missing. Previously the regex only matched integer "hour" text and
  // silently null-ed everything else (corrupting expiry triage).
  const expiryHint = await page.$eval(".messages-notice.expiration-status-average, .contact__expiration-status-text", el => (el.textContent || "").trim()).catch(() => null);
  let expires_at = null;
  const candidateTexts = [expiryHint, sidebarHints?.expiryText].filter(Boolean);
  for (const t of candidateTexts) {
    const parsed = parseExpiryIndicatorText(t);
    if (parsed && parsed.hoursLeft != null) {
      expires_at = new Date(Date.now() + parsed.hoursLeft * 3600 * 1000).toISOString();
      break;
    }
  }
  // Fall back to sidebar progress (0-100, 0=expired) if available.
  if (!expires_at && sidebarHints?.expiryProgress != null) {
    // Conservative estimate: progress 100 ~ 24h left, progress 0 ~ expired now.
    const hoursLeft = (sidebarHints.expiryProgress / 100) * 24;
    expires_at = new Date(Date.now() + hoursLeft * 3600 * 1000).toISOString();
  }

  // Use the name we already know (from the sidebar row) if profile pane didn't give one.
  const displayName = profile?.name || name;
  if (!displayName) {
    return { matchId, slug: null, messages_total: messages.length, messages_new: 0, expires_at };
  }

  const entityResult = await upsertMatch({
    matchId,
    personId: null,
    name: displayName,
    source: "bumble",
    profile,
    expires_at,
  });

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
    expires_at,
  };
}
