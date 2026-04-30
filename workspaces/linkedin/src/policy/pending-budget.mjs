// Pending-invite ceiling enforcement. Per Gemini-Flash adversarial review fix #4:
// LinkedIn 2026 drops the ban hammer at the ratio level (sent-pending > ~500), not just volume.
// We count outstanding sent invites by visiting /mynetwork/invitation-manager/sent/ and reading
// the inbox-like list. If we exceed the soft ceiling (default 400), force-withdraw the oldest
// up to a small batch before we send any new connect.

import { loadCaps } from "../runtime/caps.mjs";

// Count outstanding sent invites. Approximate — counts aria-label-tagged rows.
export async function countOutstandingSentInvites(page) {
  await page.goto("https://www.linkedin.com/mynetwork/invitation-manager/sent/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(2000);
  // Heuristic: count list items with a Withdraw control inside them.
  return await page.evaluate(() => {
    const rows = document.querySelectorAll(
      'main li:has(button[aria-label*="Withdraw"]), main [data-test-id*="invitation"]:has(button[aria-label*="Withdraw"])'
    );
    return rows.length || null;
  }).catch(() => null);
}

export async function enforcePendingCeiling(page, ext, { dryRun = true } = {}) {
  const caps = await loadCaps();
  const ceiling = caps.pending_ceiling ?? { force_withdraw_when_above: 400, force_withdraw_batch_size: 25 };
  const total = await countOutstandingSentInvites(page);
  if (total === null) return { skipped: true, reason: "count_unavailable" };
  if (total < ceiling.force_withdraw_when_above) return { ok: true, total, action: "noop" };

  if (dryRun) return { ok: true, total, action: "would_withdraw_oldest", batch: ceiling.force_withdraw_batch_size };

  // Withdraw oldest N. Read each sent-row's username, then call ext.withdrawInvite per username.
  const usernames = await page.evaluate((batch) => {
    const cards = Array.from(document.querySelectorAll('main li:has(button[aria-label*="Withdraw"])'));
    const out = [];
    for (const card of cards.slice(-batch)) { // assume oldest is at the bottom of the rendered list
      const a = card.querySelector('a[href*="/in/"]');
      if (!a) continue;
      const m = (a.getAttribute("href") || "").match(/\/in\/([^/?#]+)/);
      if (m) out.push(m[1]);
    }
    return out;
  }, ceiling.force_withdraw_batch_size).catch(() => []);

  let withdrawn = 0;
  for (const u of usernames) {
    try {
      const r = await ext.withdrawInvite(u, { dryRun: false });
      if (r.ok) withdrawn += 1;
    } catch { /* skip */ }
    await page.waitForTimeout(1500);
  }
  return { ok: true, total, action: "withdrew", count: withdrawn };
}
