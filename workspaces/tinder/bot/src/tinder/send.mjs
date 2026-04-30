import { selectors } from "../runtime/detection.mjs";
import { openThread } from "./page.mjs";
import { humanClick, humanType, makeCursor, idlePause, sleep, jitter } from "../runtime/humanize.mjs";
import { scanForHalts } from "../runtime/detection.mjs";
import { logSession } from "../runtime/logger.mjs";
import { findEntityByMatchId, appendOutboundEvent, appendMessages } from "../runtime/entity-store.mjs";
import { checkAndIncrement, loadCaps } from "../runtime/caps.mjs";

async function pickFirst(page, sel) {
  const candidates = [sel.selector, ...(sel.alt || [])];
  for (const s of candidates) {
    const el = await page.$(s);
    if (el) return s;
  }
  return null;
}

export async function sendMessage(page, { matchId, text, mode, draftId, lintScore, dryRun = false }) {
  const sels = await selectors();
  const caps = await loadCaps();
  const cursor = await makeCursor(page);

  await openThread(page, matchId);
  await scanForHalts(page);

  // C3 GUARD + GEMINI-CRIT-R2-2 + CODEX-R3-1: verify URL settled.
  // filter(Boolean).pop() handles trailing slashes correctly.
  const settledUrl = page.url();
  let settledLast = "";
  try {
    settledLast = new URL(settledUrl).pathname.split("/").filter(Boolean).pop() || "";
  } catch {}
  if (settledLast !== matchId) {
    throw new Error(`thread_redirect: expected matchId=${matchId}, last_segment=${settledLast}, url=${settledUrl}. Aborting send to prevent wrong-recipient.`);
  }

  await idlePause({ min: 2200, max: 6500 });

  const inputSel = await pickFirst(page, sels.thread_input);
  if (!inputSel) throw new Error(`thread_input not found for match ${matchId}`);

  // C3 GUARD: clear any stale textarea content from a prior send in this session.
  await humanClick(cursor, page, inputSel);
  await sleep(jitter(200, 500));
  try { await page.fill(inputSel, ""); } catch { /* fallback to manual clear */ }
  await sleep(jitter(200, 500));

  await humanType(page, text, { profile: text.length > 60 ? "thinky" : "normal" });
  await sleep(jitter(600, 1800));

  if (dryRun) {
    console.log(`DRY RUN: would have sent to ${matchId}: ${JSON.stringify(text)}`);
    try { await page.fill(inputSel, ""); } catch {}
    return { sent: false, dryRun: true };
  }

  await checkAndIncrement("message");

  // C3 GUARD + GEMINI-CRIT-R2-2 + CODEX-R3-1: re-check URL right before send.
  const finalUrl = page.url();
  let finalLast = "";
  try {
    finalLast = new URL(finalUrl).pathname.split("/").filter(Boolean).pop() || "";
  } catch {}
  if (finalLast !== matchId) {
    throw new Error(`thread_drift: url changed to ${finalUrl} during compose. Not sending.`);
  }

  let sent = false;
  const sendSel = await pickFirst(page, sels.thread_send);
  if (sendSel) {
    try { await humanClick(cursor, page, sendSel); sent = true; } catch { /* fall through */ }
  }
  if (!sent) {
    await page.keyboard.press("Enter");
    sent = true;
  }

  await sleep(jitter(800, 1800));

  const entity = await findEntityByMatchId(matchId);
  if (entity) {
    await appendOutboundEvent(entity.slug, {
      event: "sent",
      mode,
      intent: "auto-or-hitl",
      draftId,
      text,
      lintPass: lintScore === 1,
    });
    await appendMessages(entity.slug, [{ direction: "out", text, ts: new Date().toISOString() }]);
  }
  await logSession({ event: "send", match_id: matchId, mode, draft_id: draftId, slug: entity?.slug || null });
  return { sent: true };
}
