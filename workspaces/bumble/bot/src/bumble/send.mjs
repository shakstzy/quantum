// Outbound message via patchright. Skeleton; mirrors Tinder's send.mjs but
// thread URL + selectors come from post-discovery config.

import { selectors, scanForHalts } from "../runtime/detection.mjs";
import { humanClick, humanType, makeCursor, idlePause, sleep, jitter } from "../runtime/humanize.mjs";
import { logSession } from "../runtime/logger.mjs";
import { findEntityByMatchId, appendOutboundEvent, appendMessages } from "../runtime/entity-store.mjs";
import { loadCaps, reserveCap, releaseCap } from "../runtime/caps.mjs";

async function pickFirst(page, sel) {
  const candidates = [sel.selector, ...(sel.alt || [])].filter(Boolean);
  for (const s of candidates) {
    const el = await page.$(s);
    if (el) return s;
  }
  return null;
}

// CODEX-R3-P0-2: role guard must check the LATEST message direction, not any
// historical inbound. After Adithya replies, the doctrine is: wait for her next
// message before sending again. The previous shape `.includes("**her**")` was
// true forever after the first inbound and permitted double-texting.
function lastMessageDirection(conversationMd) {
  if (!conversationMd) return null;
  const lines = conversationMd.split("\n").filter(l => l.startsWith("**her**") || l.startsWith("**you**"));
  if (lines.length === 0) return null;
  return lines[lines.length - 1].startsWith("**her**") ? "in" : "out";
}
// Only true when she sent the most recent message. Lets us reply, blocks double-texting.
function lastMessageIsHers(conversationMd) {
  return lastMessageDirection(conversationMd) === "in";
}
function hasOpeningMove(profileMd) {
  return /^- opening_move:\s*/m.test(profileMd || "");
}
// Pre-Bumble shape: empty thread, opening_move recorded, no outbound from us yet.
function isOpeningMoveResponse(conversationMd, profileMd) {
  if (!hasOpeningMove(profileMd)) return false;
  return lastMessageDirection(conversationMd) == null; // no messages either side
}

export async function sendMessage(page, { matchId, text, mode, draftId, lintScore, intent = "reply", dryRun = false }) {
  const sels = await selectors();
  if (!sels.thread_input?.selector) {
    throw new Error("pre-discovery: sendMessage needs thread_input selector. Run scripts/discover-dom.mjs.");
  }
  const cursor = await makeCursor(page);

  // CODEX-R3-P0-2+3: tightened role guard. Two valid send shapes:
  //   (a) "reply" - she sent the MOST RECENT message in the thread
  //   (b) "opening_move_response" - empty thread but profile records an Opening Move
  // Anything else (you sent last, or no inbound + no opening_move) is refused.
  const entityForGuard = await findEntityByMatchId(matchId);
  if (entityForGuard) {
    const { loadEntity } = await import("../runtime/entity-store.mjs");
    const ent = await loadEntity(entityForGuard.slug);

    const isReply = lastMessageIsHers(ent.conversation);
    const isOpening = isOpeningMoveResponse(ent.conversation, ent.profile);

    if (!(isReply || isOpening)) {
      const dir = lastMessageDirection(ent.conversation);
      throw new Error(`role_guard: refused to send to ${matchId} (slug=${ent.slug}). last_msg_dir=${dir}, opening_move=${hasOpeningMove(ent.profile)}, intent=${intent}. Bumble women-message-first; no double-texting.`);
    }
    // Mismatched intent vs actual eligibility class is suspicious; reject.
    if (intent === "reply" && !isReply) {
      throw new Error(`role_guard: intent=reply but last message was not from her (slug=${ent.slug})`);
    }
    if (intent === "opening_move_response" && !isOpening) {
      throw new Error(`role_guard: intent=opening_move_response but thread is not empty or no opening_move (slug=${ent.slug})`);
    }

    // Refuse stale or unmatched.
    const expired_status = ["expired", "unmatched"].includes(ent.meta.status);
    const expired_clock = ent.meta.expires_at && new Date(ent.meta.expires_at).getTime() < Date.now();
    if (expired_status || expired_clock) {
      throw new Error(`stale_match: refused to send to ${matchId} (slug=${ent.slug}). status=${ent.meta.status}, expires_at=${ent.meta.expires_at}`);
    }
  } else {
    throw new Error(`role_guard: no entity record for matchId=${matchId}. Refusing send (cannot prove role-eligibility).`);
  }

  // CODEX-R5-P0-4: reserve cap atomically (under lock) BEFORE typing. If we
  // fail to verify delivery, releaseCap rolls back. This closes the
  // peek-then-commit race that allowed two concurrent senders to both go
  // through under the cap.
  let reservation = null;
  if (!dryRun) {
    reservation = await reserveCap("message");
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

  // CODEX-R3-P1: dryRun must not touch the real composer. Decide BEFORE typing.
  if (dryRun) {
    console.log(`DRY RUN: would have sent to ${matchId}: ${JSON.stringify(text)}`);
    return { sent: false, dryRun: true };
  }

  // CODEX-R5-P0-2: re-scan halts IMMEDIATELY before any click/type sequence.
  // The post-openThread halt scan + idlePause leaves a window where Turnstile
  // or photo-verify can appear. Don't type into mitigation surfaces.
  await scanForHalts(page);

  // CODEX-R5-P0-6: refuse to fall back to Enter. Bumble chat composers may be
  // contenteditable; Enter behavior is unsafe. Require thread_send to be wired
  // before any real send.
  if (!sels.thread_send?.selector) {
    if (reservation) await releaseCap(reservation);
    throw new Error("missing_selector: thread_send is not configured. Refusing to send via Enter fallback. Run scripts/discover-dom.mjs.");
  }
  // CODEX-R5-P0-7: strong delivery verification requires thread_messages too.
  if (!sels.thread_messages?.selector) {
    if (reservation) await releaseCap(reservation);
    throw new Error("missing_selector: thread_messages is not configured. Refusing to send without strong delivery verification. Run scripts/discover-dom.mjs.");
  }

  // Belt-and-suspenders cleanup: if anything below throws, a finally clears the input.
  let cleanupNeeded = true;
  try {
    await humanType(page, text, { profile: text.length > 60 ? "thinky" : "normal" });
    await sleep(jitter(600, 1800));

    // CODEX-R5-P0-6: thread_send selector existence is verified above; no
    // Enter fallback. If the click fails, throw - delivery did not happen.
    const sendSel = await pickFirst(page, sels.thread_send);
    if (!sendSel) throw new Error(`thread_send selector did not resolve at click time for ${matchId}`);
    await humanClick(cursor, page, sendSel);

    await sleep(jitter(800, 1800));

    // CODEX-R2-P0-6: real delivery verification. Input-cleared alone is too weak
    // (UIs clear on Enter even when blocked/rate-limited). Require BOTH:
    //   1. input cleared
    //   2. if thread_messages selector is configured, the last message in the
    //      thread normalizes to our sent text.
    let inputCleared = false;
    try {
      const v = await page.$eval(inputSel, el => (el.value ?? el.textContent ?? "").trim());
      inputCleared = !v || v.length === 0;
    } catch { inputCleared = true; }

    if (!inputCleared) {
      throw new Error(`send_unverified: input box for ${matchId} still contains text after send action. Refusing to log success.`);
    }

    // CODEX-R5-P0-7: strong-form check is now MANDATORY (thread_messages
    // existence asserted above). Read errors no longer silently fall through.
    const expected = String(text || "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
    let lastInThread = null;
    const tmCandidates = [sels.thread_messages.selector, ...(sels.thread_messages.alt || [])].filter(Boolean);
    let readOk = false;
    for (const q of tmCandidates) {
      try {
        const all = await page.$$eval(q, els => els.map(e => (e.textContent || "").trim()).filter(Boolean));
        readOk = true;
        if (all.length > 0) { lastInThread = all[all.length - 1]; break; }
      } catch { /* try next */ }
    }
    if (!readOk) {
      throw new Error(`send_unverified: thread_messages read failed for all candidates; cannot prove delivery for ${matchId}.`);
    }
    if (lastInThread == null) {
      throw new Error(`send_unverified: no messages visible in thread after send for ${matchId}.`);
    }
    const norm = String(lastInThread).normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
    if (!norm.includes(expected)) {
      throw new Error(`send_unverified_strong: last thread message does not contain sent text. expected="${expected.slice(0,80)}" last="${norm.slice(0,80)}"`);
    }

    // Cap was already reserved at the top under lock; nothing to commit here.
    cleanupNeeded = false;

    const entity = await findEntityByMatchId(matchId);
    if (entity) {
      await appendOutboundEvent(entity.slug, {
        event: "sent", mode, intent, draftId, text, lintPass: lintScore === 1,
      });
      await appendMessages(entity.slug, [{ direction: "out", text, ts: new Date().toISOString() }]);
    }
    await logSession({ event: "send", match_id: matchId, mode, intent, draft_id: draftId, slug: entity?.slug || null });
    return { sent: true };
  } catch (e) {
    // Send failed somewhere between reserve and verify - release reservation.
    if (reservation) {
      try { await releaseCap(reservation); } catch (rerr) { console.error(`releaseCap failed: ${rerr.message}`); }
      reservation = null;
    }
    throw e;
  } finally {
    if (cleanupNeeded) {
      try { await page.fill(inputSel, ""); } catch {}
    }
  }
}
