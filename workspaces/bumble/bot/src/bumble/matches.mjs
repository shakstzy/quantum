// Match list scrape + per-thread snapshot.
// Bumble web shape: ALL conversations live in the sidebar at /app. There is no
// per-thread URL; opening a thread = clicking the contact row. matchId is the
// `data-qa-uid` attribute on each row (stable opaque Bumble identifier).

import { selectors, scanForHalts } from "../runtime/detection.mjs";
import { gotoMatches, openThread, readThreadProfile } from "./page.mjs";
import { humanScroll, idlePause, sleep, jitter } from "../runtime/humanize.mjs";
import { logSession } from "../runtime/logger.mjs";
import { upsertMatch, appendMessages, setStatus } from "../runtime/entity-store.mjs";
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

  // CRITICAL FIX (2026-05-03 Adithya audit): the previous loop used humanScroll
  // (mouse wheel), which scrolls whatever's under the cursor — typically the
  // encounters card surface in the center, NOT the sidebar contacts list.
  // That capped us at the initially-rendered ~15 rows even though the sidebar
  // actually contained 86. Probe verified: scrolling the sidebar container
  // directly via scrollTop=scrollHeight gets all rows. Cap raised to 30 passes
  // (10 rows / pass empirically) so users with 100+ matches are fully caught.
  for (let pass = 0; pass < 30; pass++) {
    const before = await page.$$eval(sels.matches_list_item.selector, els => els.length);
    await page.evaluate(() => {
      const scroller = document.querySelector(
        "[data-qa-role='conversations-tab-section-content'], [data-qa-role='conversations-tab-section'], .sidebar__contact-list"
      );
      if (scroller && scroller.scrollHeight > scroller.clientHeight) {
        scroller.scrollTop = scroller.scrollHeight;
      } else {
        // Fall back to scrolling the last contact into view to trigger lazy-load.
        const all = document.querySelectorAll("[data-qa-role='contact']");
        if (all.length) all[all.length - 1].scrollIntoView({ block: "end", behavior: "instant" });
      }
    });
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
  // 2026-05-04: Bumble's sidebar shows "Deleted account" verbatim for matches
  // whose accounts no longer exist. Short-circuit BEFORE opening the thread.
  // Don't create a raw/bumble/ entity (it pollutes the graph). Track the
  // matchId in ~/.quantum/bumble/deleted/ so subsequent pulls stay quiet.
  if (name && /^deleted account$/i.test(String(name).trim())) {
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      const { homedir } = await import("node:os");
      const deletedDir = resolve(homedir(), ".quantum/bumble/deleted");
      await mkdir(deletedDir, { recursive: true });
      const safeId = String(matchId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
      await writeFile(resolve(deletedDir, `${safeId}.json`), JSON.stringify({
        matchId, sidebarName: name, firstSeen: new Date().toISOString(),
      }, null, 2));
    } catch { /* tracking is best-effort */ }
    return { matchId, slug: null, messages_total: 0, messages_new: 0, expires_at: null, deleted_account: true };
  }
  await openThread(page, matchId);
  await scanForHalts(page);

  // Detect chat-blocker interstitials. Two distinct dead-states:
  //   1. expired: "This match has expired" (24h timer ran out)
  //   2. unmatched/left-bumble: "X has left Bumble. Perhaps it's time to make another connection"
  //      (account deleted/banned, or she manually unmatched).
  // Both block the composer; both must stop send attempts. The text content
  // disambiguates which one it is.
  // Live-verified 2026-05-03 (expired-Lacie) and 2026-05-04 (left-Emily).
  const expiredInterstitial = await page.$(".chat-blocker.expiration-status-expired, [class*='expiration-status-expired']").catch(() => null);
  const isExpiredView = !!expiredInterstitial;
  let isLeftBumble = false;
  if (!isExpiredView) {
    const blockerText = await page.$eval(".chat-blocker, [class*='chat-blocker']", el => (el.textContent || "").toLowerCase()).catch(() => "");
    if (blockerText && (blockerText.includes("left bumble") || blockerText.includes("make another connection"))) {
      isLeftBumble = true;
    }
  }

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
  let expires_at = null;
  if (isExpiredView) {
    // The expired interstitial is the authoritative signal — set expires_at
    // to a past timestamp so triage classifies as "expired" and decide.mjs
    // routes accordingly. Sidebar data-progress can still report 100 here
    // (visual lag); the interstitial overrides.
    expires_at = new Date(Date.now() - 1000).toISOString();
  } else {
    const expiryHint = await page.$eval(".messages-notice.expiration-status-average, .contact__expiration-status-text", el => (el.textContent || "").trim()).catch(() => null);
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
      const hoursLeft = (sidebarHints.expiryProgress / 100) * 24;
      expires_at = new Date(Date.now() + hoursLeft * 3600 * 1000).toISOString();
    }
  }

  // Use the name we already know (from the sidebar row) if profile pane didn't give one.
  const displayName = profile?.name || name;
  if (!displayName) {
    return { matchId, slug: null, messages_total: messages.length, messages_new: 0, expires_at };
  }
  // 2026-05-04: Bumble shows "Deleted account" as the sidebar name when the
  // user deleted their profile. Treat as unmatched alongside the in-thread
  // "left Bumble" interstitial. Both paths set isLeftBumble so the persist
  // block below sets status=unmatched.
  const isDeletedAccount = /^deleted account$/i.test(String(displayName).trim());
  if (isDeletedAccount) {
    isLeftBumble = true;
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

  // Persist the expired status so decide.mjs and rematch.mjs can route on it.
  if (isExpiredView && entityResult?.slug) {
    try { await setStatus(entityResult.slug, "expired"); } catch (e) { console.error(`setStatus(expired) failed for ${entityResult.slug}: ${e.message}`); }
  }
  // Persist the unmatched status so decide.mjs skips drafting and send.mjs
  // refuses delivery. Distinct from "expired" because rematch.mjs cannot
  // resurrect a left-Bumble account (no rematch button is offered).
  if (isLeftBumble && entityResult?.slug) {
    try { await setStatus(entityResult.slug, "unmatched"); } catch (e) { console.error(`setStatus(unmatched) failed for ${entityResult.slug}: ${e.message}`); }
  }
  // 2026-05-06: rescue stale-expired entities. When the chat-blocker is GONE
  // (no expired/left-bumble interstitial) AND there's a recent inbound message,
  // the thread is alive again — she rematched OR our prior pull mistakenly set
  // status=expired. Reset status to "new" so decide.mjs re-engages.
  if (!isExpiredView && !isLeftBumble && entityResult?.slug && messages.length > 0) {
    const priorStatus = String(entityResult.priorStatus || "").replace(/^"|"$/g, "");
    if (priorStatus === "expired" || priorStatus === "unmatched") {
      try { await setStatus(entityResult.slug, "new"); } catch (e) { console.error(`setStatus(new-rescue) failed for ${entityResult.slug}: ${e.message}`); }
    }
  }

  await idlePause({ min: caps.scrape.between_thread_opens_ms[0], max: caps.scrape.between_thread_opens_ms[1] });
  return {
    matchId,
    slug: entityResult?.slug || null,
    messages_total: messages.length,
    messages_new: added,
    profile_diff: entityResult?.profile_diff || null,
    expires_at,
    expired_view: isExpiredView,
  };
}
