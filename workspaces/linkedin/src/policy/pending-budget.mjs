// Pending-invite ceiling enforcement. Per Gemini-Flash adversarial review fix #4: LinkedIn
// 2026 drops the ban hammer when sent-pending exceeds ~500. We force-withdraw the oldest
// invitations once the count crosses our soft limit, before sending any new connect.

import { loadCaps } from "../runtime/caps.mjs";
import { listPendingInvites, withdrawInvite, pendingSentCount } from "../linkedin/voyager/connections.mjs";
import { logAction } from "../runtime/logger.mjs";
import { interActionSpacing } from "../runtime/humanize.mjs";

export async function enforcePendingCeiling(client, { dryRun = true } = {}) {
  const caps = await loadCaps();
  const ceiling = caps.pending_ceiling;
  const total = await pendingSentCount(client);
  if (total === null || total === undefined) {
    return { skipped: true, reason: "pending_count_unavailable" };
  }
  if (total < ceiling.force_withdraw_when_above) {
    return { ok: true, total, action: "noop" };
  }

  const sent = await listPendingInvites(client, { direction: "sent", limit: 100 });
  // Sort oldest first.
  sent.sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0));
  const minAgeMs = ceiling.force_withdraw_min_age_days * 86400_000;
  const cutoff = Date.now() - minAgeMs;
  const candidates = sent.filter((inv) => (inv.sentAt ?? 0) <= cutoff)
    .slice(0, ceiling.force_withdraw_batch_size);

  if (dryRun) {
    return { ok: true, total, action: "would_withdraw", count: candidates.length };
  }

  let withdrawn = 0;
  for (const inv of candidates) {
    try {
      await withdrawInvite(client, { invitationUrn: inv.invitationUrn });
      await logAction({ action: "withdraw_invite", target: inv.invitationUrn, success: true, reason: "pending_ceiling" });
      withdrawn += 1;
    } catch (err) {
      await logAction({ action: "withdraw_invite", target: inv.invitationUrn, success: false, error: String(err.message ?? err) });
    }
    await interActionSpacing();
  }
  return { ok: true, total, action: "withdrew", count: withdrawn };
}
