import { selectors } from "../runtime/detection.mjs";
import { openThread } from "./page.mjs";
import { humanClick, humanType, makeCursor, idlePause, sleep, jitter } from "../runtime/humanize.mjs";
import { scanForHalts } from "../runtime/detection.mjs";
import { logSent } from "../runtime/logger.mjs";
import { checkAndIncrement, loadCaps } from "../runtime/caps.mjs";

async function pickFirst(page, sel) {
  const candidates = [sel.selector, ...(sel.alt || [])];
  for (const s of candidates) {
    const el = await page.$(s);
    if (el) return s;
  }
  return null;
}

export async function sendMessage(page, { matchId, text, mode, draftId, lintScore }) {
  const sels = await selectors();
  const caps = await loadCaps();
  const cursor = await makeCursor(page);

  await openThread(page, matchId);
  await scanForHalts(page);

  await idlePause({ min: 2200, max: 6500 });

  const inputSel = await pickFirst(page, sels.thread_input);
  if (!inputSel) throw new Error(`thread_input not found for match ${matchId}`);
  await humanClick(cursor, page, inputSel);
  await sleep(jitter(400, 1200));
  await humanType(page, text, { profile: text.length > 60 ? "thinky" : "normal" });
  await sleep(jitter(600, 1800));

  await checkAndIncrement("message");

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
  await logSent({ match_id: matchId, text, mode, draft_id: draftId, lint_score: lintScore });
  return { sent: true };
}
