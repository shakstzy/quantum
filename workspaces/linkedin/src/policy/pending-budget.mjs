// Pending-invite ceiling enforcement. Per Gemini-Flash adversarial review fix #4:
// LinkedIn 2026 drops the ban hammer at the ratio level (sent-pending > ~500), not just volume.
// We count outstanding sent invites by visiting /mynetwork/invitation-manager/sent/, scrolling
// until row count stabilizes, and force-withdraw the oldest above-min-age batch when over the
// soft ceiling. FAIL CLOSED: when count is unavailable, send_connect is blocked (per Codex r2 P0).

import { loadCaps } from "../runtime/caps.mjs";
import { sleep } from "../runtime/humanize.mjs";

const SENT_URL = "https://www.linkedin.com/mynetwork/invitation-manager/sent/";

async function gotoSentManager(page) {
  await page.goto(SENT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(1500);
}

// Scroll the manager until row count stabilizes (or we hit max scrolls).
async function scrollUntilStable(page, { maxScrolls = 20, pauseMs = 700 } = {}) {
  let lastCount = -1;
  let stableTicks = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const count = await page.evaluate(() => {
      return document.querySelectorAll(
        'main li button[aria-label*="Withdraw"], main [data-test-id*="invitation"] button[aria-label*="Withdraw"]'
      ).length;
    }).catch(() => -1);
    if (count === lastCount) {
      stableTicks += 1;
      if (stableTicks >= 2) return count;
    } else {
      stableTicks = 0;
      lastCount = count;
    }
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) { window.scrollTo(0, document.body.scrollHeight); return; }
      // Find a scrollable container or fall back to window scroll.
      let scroller = main;
      const all = main.querySelectorAll("*");
      for (const el of all) {
        const s = window.getComputedStyle(el);
        if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
          scroller = el;
          break;
        }
      }
      scroller.scrollTop = scroller.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await sleep(pauseMs);
  }
  return lastCount;
}

// Returns {count, candidates: [{username, sentAtText}]} where candidates are oldest-first.
async function readSentInvites(page) {
  return await page.evaluate(() => {
    const out = [];
    const cards = Array.from(document.querySelectorAll(
      'main li:has(button[aria-label*="Withdraw"]), main [data-test-id*="invitation"]:has(button[aria-label*="Withdraw"])'
    ));
    for (const card of cards) {
      const a = card.querySelector('a[href*="/in/"]');
      if (!a) continue;
      const m = (a.getAttribute("href") || "").match(/\/in\/([^/?#]+)/);
      if (!m) continue;
      const text = (card.innerText || "").trim();
      // LinkedIn's "Sent X ago" line is usually visible. Extract the relative-time hint.
      const sentMatch = text.match(/Sent\s+([^\n]+?)(?:\n|$)/i);
      out.push({
        username: m[1],
        cardText: text.slice(0, 240),
        sentAtText: sentMatch ? sentMatch[1].trim() : null,
      });
    }
    return out;
  }).catch(() => []);
}

// Convert "X seconds/minutes/hours/days/weeks/months/year(s) ago" to a rough age in days.
function parseSentAgoDays(s) {
  if (!s) return null;
  const m = s.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const perDay = {
    second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365,
  }[unit] ?? 0;
  return n * perDay;
}

export async function countOutstandingSentInvites(page) {
  await gotoSentManager(page);
  const count = await scrollUntilStable(page);
  if (count === -1) return null;
  return count;
}

export async function enforcePendingCeiling(page, ext, { dryRun = true } = {}) {
  const caps = await loadCaps();
  const ceiling = caps.pending_ceiling ?? {
    force_withdraw_when_above: 400,
    force_withdraw_batch_size: 25,
    force_withdraw_min_age_days: 14,
  };
  const total = await countOutstandingSentInvites(page);
  if (total === null) {
    // FAIL CLOSED: caller should refuse to send_connect when count is unavailable.
    return { ok: false, reason: "count_unavailable", total: null, action: "block" };
  }
  if (total < ceiling.force_withdraw_when_above) {
    return { ok: true, total, action: "noop" };
  }

  // Read all sent invites (we're already on the manager page after countOutstandingSentInvites).
  const all = await readSentInvites(page);
  // Most-recent-first is LinkedIn's default; sort by parsed age (largest age = oldest).
  const aged = all
    .map((c) => ({ ...c, ageDays: parseSentAgoDays(c.sentAtText) }))
    .filter((c) => c.ageDays !== null && c.ageDays >= ceiling.force_withdraw_min_age_days)
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, ceiling.force_withdraw_batch_size);

  if (aged.length === 0) {
    return { ok: false, total, action: "no_eligible_to_withdraw", reason: `no invites ≥ ${ceiling.force_withdraw_min_age_days} days old` };
  }
  if (dryRun) {
    return { ok: true, total, action: "would_withdraw", count: aged.length, sample: aged.slice(0, 3).map((c) => ({ username: c.username, age_days: Math.round(c.ageDays) })) };
  }

  let withdrawn = 0;
  for (const c of aged) {
    try {
      const r = await ext.withdrawInvite(c.username, { dryRun: false });
      if (r.ok) withdrawn += 1;
    } catch { /* skip */ }
    await sleep(1500);
  }
  return { ok: true, total, action: "withdrew", count: withdrawn };
}
