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

    // Refuse if status is authoritative-stale. The expires_at field is unreliable
    // here: we set it from the initial 24h timer the first time we saw the match,
    // but the timer resets when messages are exchanged and we don't always
    // re-derive expires_at on every pull (no in-thread expiry hint exists for
    // active conversations). status="expired" is the strong signal — it's only
    // set when scrapeThread observed the .chat-blocker.expiration-status-expired
    // interstitial. Trust that, not the stale clock.
    const expired_status = ["expired", "unmatched"].includes(ent.meta.status);
    if (expired_status) {
      throw new Error(`stale_match: refused to send to ${matchId} (slug=${ent.slug}). status=${ent.meta.status}`);
    }
  } else {
    throw new Error(`role_guard: no entity record for matchId=${matchId}. Refusing send (cannot prove role-eligibility).`);
  }

  // CODEX-R7-P0-1: dryRun must abort BEFORE we open the thread. Previously
  // dry-run still drove openThread + humanClick + page.fill(""), which is
  // visible Bumble behavior AND can erase a manually drafted message in the
  // composer. Decide before any browser action.
  if (dryRun) {
    console.log(`DRY RUN: would have sent to ${matchId}: ${JSON.stringify(text)}`);
    return { sent: false, dryRun: true };
  }

  // CODEX-R6-P0-6: wrap reservation + all subsequent risky operations in a
  // single try/catch so any failure releases the cap. Previously a throw in
  // openThread/scanForHalts/thread_input lookup could leak the reservation.
  // CODEX-R8-P0-3 / GEMINI-P0: use `let` so the catch path's `reservation = null`
  // doesn't TypeError. The previous `const` would mask the original error.
  let reservation = await reserveCap("message");

  let inputSel;
  try {
    const { openThread } = await import("./page.mjs");
    await openThread(page, matchId);
    await scanForHalts(page);

    // CODEX-R7-P0-2: LIVE pre-send direction check. The role guard above used
    // local entity markdown (last pull state); if Adithya manually replied via
    // the Bumble app since the last pull, our local snapshot says "her sent
    // last" while live truth is "you sent last". Reading the live thread now
    // forces refusal in that race.
    if (sels.thread_messages?.selector) {
      const tmCandidates = [sels.thread_messages.selector, ...(sels.thread_messages.alt || [])].filter(Boolean);
      let liveLastDir = null;
      for (const q of tmCandidates) {
        try {
          const dir = await page.$$eval(q, els => {
            for (let i = els.length - 1; i >= 0; i--) {
              const cls = els[i].getAttribute("class") || "";
              if (/\bmessage--out\b|\bmessage--from-me\b/.test(cls)) return "out";
              if (/\bmessage--in\b/.test(cls)) return "in";
            }
            return null;
          });
          if (dir != null) { liveLastDir = dir; break; }
        } catch { /* try next */ }
      }
      // Live empty-thread is acceptable only when intent is opening_move_response.
      if (liveLastDir == null && intent !== "opening_move_response") {
        throw new Error(`live_role_guard: thread appears empty live but intent=${intent}. Refusing send.`);
      }
      if (liveLastDir === "out") {
        throw new Error(`live_role_guard: live thread shows YOU sent the most recent message (matchId=${matchId}). Refusing to double-text. Re-pull and re-evaluate.`);
      }
    }

    await idlePause({ min: 2200, max: 6500 });

    // GEMINI-P0: scan halts IMMEDIATELY before humanClick. The idlePause
    // opens a window where Turnstile/photo-verify/restriction can appear,
    // and we must not click into a mitigation surface.
    await scanForHalts(page);

    inputSel = await pickFirst(page, sels.thread_input);
    if (!inputSel) throw new Error(`thread_input not found for match ${matchId}`);

    await humanClick(cursor, page, inputSel);
    await sleep(jitter(200, 500));
    try { await page.fill(inputSel, ""); } catch { /* continue */ }
    await sleep(jitter(200, 500));
  } catch (e) {
    if (reservation) {
      try { await releaseCap(reservation); } catch (rerr) { console.error(`releaseCap failed: ${rerr.message}`); }
    }
    throw e;
  }

  // CODEX-R8-P0-2: pre-click halt scan and selector existence checks must run
  // INSIDE the same try/finally that owns the cap reservation. Previously a
  // halt firing here (or a missing-selector throw) leaked the reservation
  // because the catch only covered openThread/scanForHalts/thread_input.
  // Belt-and-suspenders cleanup: if anything below throws, a finally clears the input.
  let cleanupNeeded = true;
  let postClickReached = false;
  try {
    await scanForHalts(page);

    // CODEX-R5-P0-6: refuse to fall back to Enter. Bumble chat composers may be
    // contenteditable; Enter behavior is unsafe. Require thread_send wired.
    if (!sels.thread_send?.selector) {
      throw new Error("missing_selector: thread_send is not configured. Refusing to send via Enter fallback. Run scripts/discover-dom.mjs.");
    }
    // CODEX-R5-P0-7: strong delivery verification requires thread_messages too.
    if (!sels.thread_messages?.selector) {
      throw new Error("missing_selector: thread_messages is not configured. Refusing to send without strong delivery verification. Run scripts/discover-dom.mjs.");
    }

    await humanType(page, text, { profile: text.length > 60 ? "thinky" : "normal" });
    await sleep(jitter(600, 1800));

    // CODEX-R6-P0-7: scan halts AFTER typing, BEFORE clicking send. Long text
    // can take seconds; Turnstile / photo-verify / restriction can appear in
    // that window and we must not click send into a mitigation surface.
    await scanForHalts(page);

    // CODEX-R5-P0-6: thread_send selector existence is verified above; no
    // Enter fallback. If the click fails, throw - delivery did not happen.
    const sendSel = await pickFirst(page, sels.thread_send);
    if (!sendSel) throw new Error(`thread_send selector did not resolve at click time for ${matchId}`);
    await humanClick(cursor, page, sendSel);
    postClickReached = true; // anything past this point is "ambiguous" on failure

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
    // CODEX-R6-P0-8: differentiate ambiguous vs clean failure. If we already
    // clicked the send button, the message MAY have gone through but
    // verification failed. In that case, KEEP the cap reservation (don't
    // double-charge nor under-count) and signal ambiguous so the caller
    // moves the queue item to a quarantine stage instead of letting cron
    // retry it.
    if (postClickReached) {
      const ambiguous = new Error(`send_ambiguous: clicked send button, verification failed afterward. Treat as MAYBE-DELIVERED. Original: ${e.message}`);
      ambiguous.ambiguous = true;
      throw ambiguous;
    }
    // Pre-click failure: release the reservation, no message went out.
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
