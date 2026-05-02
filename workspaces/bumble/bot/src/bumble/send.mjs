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

export async function sendMessage(page, { matchId, text, mode, draftId, lintScore, dryRun = false }) {
  const sels = await selectors();
  if (!sels.thread_input?.selector) {
    throw new Error("pre-discovery: sendMessage needs thread_input selector. Run scripts/discover-dom.mjs.");
  }
  const cursor = await makeCursor(page);

  // openThread is in page.mjs; will throw PreDiscoveryError until thread URL is known.
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

  await humanType(page, text, { profile: text.length > 60 ? "thinky" : "normal" });
  await sleep(jitter(600, 1800));

  if (dryRun) {
    console.log(`DRY RUN: would have sent to ${matchId}: ${JSON.stringify(text)}`);
    try { await page.fill(inputSel, ""); } catch {}
    return { sent: false, dryRun: true };
  }

  await checkAndIncrement("message");

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

  const entity = await findEntityByMatchId(matchId);
  if (entity) {
    await appendOutboundEvent(entity.slug, {
      event: "sent", mode, intent: "auto-or-hitl", draftId, text, lintPass: lintScore === 1,
    });
    await appendMessages(entity.slug, [{ direction: "out", text, ts: new Date().toISOString() }]);
  }
  await logSession({ event: "send", match_id: matchId, mode, draft_id: draftId, slug: entity?.slug || null });
  return { sent: true };
}
