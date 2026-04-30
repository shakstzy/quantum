// Pending-invite ceiling enforcement. Per Gemini-Flash adversarial review fix #4:
// LinkedIn 2026 drops the ban hammer at the ratio level (sent-pending > ~500), not just volume.
// We count outstanding sent invites by visiting /mynetwork/invitation-manager/sent/, scrolling
// until row count stabilizes, and force-withdraw the oldest above-min-age batch when over the
// soft ceiling. FAIL CLOSED: when count is unavailable OR remaining-after-withdraw still above
// the ceiling, send_connect is blocked (per Codex r2 P0 + r3 P0).

import { loadCaps } from "../runtime/caps.mjs";
import { sleep } from "../runtime/humanize.mjs";

const SENT_URL = "https://www.linkedin.com/mynetwork/invitation-manager/sent/";
// As of 2026-04-30 LinkedIn renders the withdraw control as <a aria-label^="Withdraw invitation">.
// We accept both the new <a> form and the legacy <button> form so the count works across variants.
const WITHDRAW_BTN_SEL = 'a[aria-label^="Withdraw invitation"], button[aria-label*="Withdraw"]';

async function gotoSentManager(page) {
  await page.goto(SENT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(1500);
}

// Scroll the actual invitation list (not just any scrollable element). We anchor on
// withdraw buttons and walk up to their nearest scrollable ancestor, then scroll that.
// Window-scroll is also driven as a fallback. Continues until row count is stable for
// 3 consecutive ticks (Codex r3 P1 fix: longer stable window).
async function scrollUntilStable(page, { maxScrolls = 30, pauseMs = 700 } = {}) {
  let lastCount = -1;
  let stableTicks = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const count = await page.evaluate((sel) => document.querySelectorAll(`main ${sel}`).length, WITHDRAW_BTN_SEL).catch(() => -1);
    if (count === lastCount) {
      stableTicks += 1;
      if (stableTicks >= 3) return count;
    } else {
      stableTicks = 0;
      lastCount = count;
    }
    await page.evaluate((sel) => {
      const btn = document.querySelector(`main ${sel}`);
      // Walk up from the first withdraw button to the nearest scrollable ancestor.
      let scroller = null;
      if (btn) {
        let el = btn;
        while (el && el !== document.body) {
          const s = window.getComputedStyle(el);
          if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
            scroller = el;
            break;
          }
          el = el.parentElement;
        }
      }
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    }, WITHDRAW_BTN_SEL).catch(() => {});
    await sleep(pauseMs);
  }
  return lastCount;
}

// Returns {count, candidates: [{username, sentAtText}]} where candidates are oldest-first.
async function readSentInvites(page) {
  return await page.evaluate(() => {
    const out = [];
    // Anchor on the withdraw control (now an <a aria-label^="Withdraw invitation">),
    // walk up to find the card that also contains a /in/<username>/ link.
    const triggers = Array.from(document.querySelectorAll(
      'a[aria-label^="Withdraw invitation"], button[aria-label*="Withdraw"]'
    ));
    for (const trigger of triggers) {
      let node = trigger;
      let inLink = null;
      for (let depth = 0; depth < 15 && node; depth++) {
        inLink = node.querySelector('a[href*="/in/"]');
        if (inLink) break;
        node = node.parentElement;
      }
      if (!inLink || !node) continue;
      const m = (inLink.getAttribute("href") || "").match(/\/in\/([^/?#]+)/);
      if (!m) continue;
      const text = (node.innerText || "").trim();
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
// Also handles "Just now", "Today", "Yesterday", "a/an <unit> ago" (Codex r3 P2).
function parseSentAgoDays(s) {
  if (!s) return null;
  const lower = s.toLowerCase().trim();
  if (/^(just now|today|moments? ago)/.test(lower)) return 0;
  if (/^yesterday/.test(lower)) return 1;
  // "a day ago" / "an hour ago" -> count = 1
  const aUnitMatch = lower.match(/^(?:a|an)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (aUnitMatch) {
    const unit = aUnitMatch[1];
    const perDay = { second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[unit] ?? 0;
    return perDay;
  }
  const m = lower.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
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

// gate / record callbacks are passed in (rather than imported here) to avoid a circular
// dependency loop: rate-limits.mjs is the gate-and-record API but it lives in a different
// policy module. The CLI passes the canonical gate/record so withdraw_invite daily caps
// are honored even when the withdraw is forced by the ceiling enforcer (Codex r3 P0).
export async function enforcePendingCeiling(page, ext, { dryRun = true, gate = null, record = null } = {}) {
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
  const aged = all
    .map((c) => ({ ...c, ageDays: parseSentAgoDays(c.sentAtText) }))
    .filter((c) => c.ageDays !== null && c.ageDays >= ceiling.force_withdraw_min_age_days)
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, ceiling.force_withdraw_batch_size);

  if (aged.length === 0) {
    return { ok: false, total, action: "no_eligible_to_withdraw", reason: `no invites ≥ ${ceiling.force_withdraw_min_age_days} days old` };
  }

  // Even in dry-run, we project: would the withdraws be enough to cross back below the ceiling?
  const projectedRemaining = total - aged.length;
  const projectedSafe = projectedRemaining < ceiling.force_withdraw_when_above;
  if (dryRun) {
    return {
      ok: projectedSafe,
      total,
      action: "would_withdraw",
      count: aged.length,
      projected_remaining: projectedRemaining,
      sample: aged.slice(0, 3).map((c) => ({ username: c.username, age_days: Math.round(c.ageDays) })),
      reason: projectedSafe ? null : "still_above_ceiling_after_withdraws",
    };
  }

  let withdrawn = 0;
  for (const c of aged) {
    if (gate) {
      try { await gate("withdraw_invite"); }
      catch (err) {
        // Withdraw daily cap exhausted mid-loop; stop withdrawing and let the post-loop
        // remaining-check fail closed if we haven't yet crossed below the ceiling.
        break;
      }
    }
    try {
      const r = await ext.withdrawInvite(c.username, { dryRun: false });
      if (r.ok) {
        withdrawn += 1;
        if (record) await record("withdraw_invite", { target: c.username, extra: { reason: "pending_ceiling" } });
      }
    } catch { /* skip */ }
    await sleep(1500);
  }
  const remaining = total - withdrawn;
  if (remaining >= ceiling.force_withdraw_when_above) {
    return { ok: false, total, action: "block", count: withdrawn, remaining, reason: "still_above_ceiling_after_withdraws" };
  }
  return { ok: true, total, action: "withdrew", count: withdrawn, remaining };
}
