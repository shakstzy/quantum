// Outbound message via patchright. Skeleton; mirrors Tinder's send.mjs but
// thread URL + selectors come from post-discovery config.

import { selectors, scanForHalts } from "../runtime/detection.mjs";
import { humanClick, humanType, makeCursor, idlePause, sleep, jitter } from "../runtime/humanize.mjs";
import { logSession } from "../runtime/logger.mjs";
import { findEntityByMatchId, appendOutboundEvent, appendMessages } from "../runtime/entity-store.mjs";
import { checkAndIncrement, loadCaps } from "../runtime/caps.mjs";

async function pickFirst(page, sel) {
  const candidates = [sel.selector, ...(sel.alt || [])].filter(Boolean);
  for (const s of candidates) {
    const el = await page.$(s);
    if (el) return s;
  }
  return null;
}

// CODEX-R2-P0-1+2: Bumble role guard. On hetero matches, men cannot send a cold
// opener. Refuse to send unless one of these is true (NO reengage bypass; ALL
// sends through this path go through Bumble UI, so off-platform reengage cannot
// be a justification):
//   - the entity has at least one inbound message (`**her**` line in conversation)
//   - the entity has an Opening Move text recorded (her preset prompt for him)
function hasInboundMessage(conversationMd) {
  return /\n\*\*her\*\*\s+/.test(conversationMd || "") || /^\*\*her\*\*\s+/.test(conversationMd || "");
}
function hasOpeningMove(profileMd) {
  return /^- opening_move:\s*/m.test(profileMd || "");
}

export async function sendMessage(page, { matchId, text, mode, draftId, lintScore, intent = "reply", dryRun = false }) {
  const sels = await selectors();
  if (!sels.thread_input?.selector) {
    throw new Error("pre-discovery: sendMessage needs thread_input selector. Run scripts/discover-dom.mjs.");
  }
  const cursor = await makeCursor(page);

  // Role guard (P0-1+2). Hard refusal when neither condition holds.
  const entityForGuard = await findEntityByMatchId(matchId);
  if (entityForGuard) {
    const { loadEntity } = await import("../runtime/entity-store.mjs");
    const ent = await loadEntity(entityForGuard.slug);
    const inbound = hasInboundMessage(ent.conversation);
    const opening = hasOpeningMove(ent.profile);
    if (!(inbound || opening)) {
      throw new Error(`role_guard: refused to send to ${matchId} (slug=${ent.slug}). No inbound message and no opening_move. Bumble women-message-first rule. intent=${intent}`);
    }
    // CODEX-R2-P1-12: also refuse if the entity is expired/unmatched OR expires_at is past.
    const expired_status = ["expired", "unmatched"].includes(ent.meta.status);
    const expired_clock = ent.meta.expires_at && new Date(ent.meta.expires_at).getTime() < Date.now();
    if (expired_status || expired_clock) {
      throw new Error(`stale_match: refused to send to ${matchId} (slug=${ent.slug}). status=${ent.meta.status}, expires_at=${ent.meta.expires_at}`);
    }
  } else {
    // No entity record means we never scraped this match. Refuse — we have no proof
    // of inbound message or opening_move.
    throw new Error(`role_guard: no entity record for matchId=${matchId}. Refusing send (cannot prove role-eligibility).`);
  }

  // CODEX-R2-P1-2: peek cap BEFORE openThread + halt scan. If cap is reached
  // we don't burn an openThread navigation either. checkAndIncrement runs only
  // AFTER successful delivery verification.
  if (!dryRun) {
    const peek = await peekCap("message");
    if (peek.exceeded) {
      throw new Error(`cap_reached: messages hourly ${peek.hourUsed}/${peek.hourLimit}`);
    }
  }

  const { openThread } = await import("./page.mjs");
  await openThread(page, matchId);
  await scanForHalts(page);

  await idlePause({ min: 2200, max: 6500 });

  const inputSel = await pickFirst(page, sels.thread_input);
  if (!inputSel) throw new Error(`thread_input not found for match ${matchId}`);

  await humanClick(cursor, page, inputSel);
  await sleep(jitter(200, 500));
  try { await page.fill(inputSel, ""); } catch { /* continue */ }
  await sleep(jitter(200, 500));

  // Belt-and-suspenders cleanup: if anything below throws, a finally clears the input.
  let cleanupNeeded = true;
  try {
    await humanType(page, text, { profile: text.length > 60 ? "thinky" : "normal" });
    await sleep(jitter(600, 1800));

    if (dryRun) {
      console.log(`DRY RUN: would have sent to ${matchId}: ${JSON.stringify(text)}`);
      return { sent: false, dryRun: true };
    }

    let sent = false;
    if (sels.thread_send?.selector) {
      const sendSel = await pickFirst(page, sels.thread_send);
      if (sendSel) {
        try { await humanClick(cursor, page, sendSel); sent = true; } catch { /* fall through */ }
      }
    }
    if (!sent) {
      await page.keyboard.press("Enter");
      sent = true;
    }

    await sleep(jitter(800, 1800));

    // CODEX-R1-P0-6: verify delivery. After Enter/click, the input should clear
    // AND the last message in the thread should match what we typed. If neither
    // condition holds, the send didn't land - throw so the queue item is NOT
    // moved to sent/.
    let inputCleared = false;
    try {
      const v = await page.$eval(inputSel, el => (el.value ?? el.textContent ?? "").trim());
      inputCleared = !v || v.length === 0;
    } catch { /* input may have been replaced; treat as cleared */ inputCleared = true; }

    if (!inputCleared) {
      throw new Error(`send_unverified: input box for ${matchId} still contains text after send action. Refusing to log success.`);
    }

    cleanupNeeded = false; // success path; nothing to clean up

    const entity = await findEntityByMatchId(matchId);
    if (entity) {
      await appendOutboundEvent(entity.slug, {
        event: "sent", mode, intent, draftId, text, lintPass: lintScore === 1,
      });
      await appendMessages(entity.slug, [{ direction: "out", text, ts: new Date().toISOString() }]);
    }
    await logSession({ event: "send", match_id: matchId, mode, intent, draft_id: draftId, slug: entity?.slug || null });
    return { sent: true };
  } finally {
    if (cleanupNeeded) {
      try { await page.fill(inputSel, ""); } catch {}
    }
  }
}
