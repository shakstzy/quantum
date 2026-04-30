// DOM-driven connection request. Default: no-note (faster + safer per OpenOutreach reference).
// LinkedIn's UI A/B-tests the Connect entrypoint (direct top-card button vs More->Connect dropdown);
// we try both. We also detect the weekly invitation limit popup and surface RateLimitExceeded.

import { promises as fs } from "node:fs";
import { SELECTORS_FILE } from "../../runtime/paths.mjs";
import { findTopCard, findFirstMatching, gotoProfile } from "./nav.mjs";
import { humanClick, makeCursor, sleep, jitter } from "../../runtime/humanize.mjs";
import { RateLimitExceeded } from "../../runtime/exceptions.mjs";
import { inspectPage } from "../ban-signals.mjs";

let _selectors = null;
async function selectors() {
  if (_selectors) return _selectors;
  _selectors = JSON.parse(await fs.readFile(SELECTORS_FILE, "utf8"));
  return _selectors;
}

export async function sendConnectViaDom(page, { publicId, dryRun = true } = {}) {
  await gotoProfile(page, publicId);
  await inspectPage(page, { stage: "send_connect_pre" });

  const sel = await selectors();
  const cursor = await makeCursor(page);

  // Try direct connect button on the top card.
  let clicked = false;
  try {
    const top = await findTopCard(page);
    const direct = await findFirstMatching(top.locator, sel.connect.direct, { timeoutMs: 2500 });
    if (direct) {
      if (dryRun) return { ok: true, dryRun: true, path: "direct_button_visible" };
      await humanClick(cursor, page, direct.locator);
      clicked = true;
    }
  } catch { /* fall through */ }

  // Fallback: More -> Connect.
  if (!clicked) {
    const top = await findTopCard(page);
    const more = await findFirstMatching(top.locator, sel.connect.more_button, { timeoutMs: 4000 });
    if (!more) {
      return { ok: false, reason: "no_connect_entry_point" };
    }
    if (dryRun) return { ok: true, dryRun: true, path: "more_menu_visible" };
    await humanClick(cursor, page, more.locator);
    await sleep(jitter(400, 900));
    const menu = await findFirstMatching(page, sel.connect.menu_connect, { timeoutMs: 3000 });
    if (!menu) return { ok: false, reason: "more_menu_no_connect" };
    await humanClick(cursor, page, menu.locator);
    clicked = true;
  }

  // Confirm dialog: "Send without a note".
  await sleep(jitter(500, 1200));

  // Weekly limit detection.
  for (const s of sel.weekly_invite_limit) {
    if ((await page.locator(s).count()) > 0) {
      throw new RateLimitExceeded("Weekly invitation limit popup", {
        action: "send_connect", scope: "pending_ceiling",
      });
    }
  }

  const sendNow = await findFirstMatching(page, sel.connect.send_now, { timeoutMs: 4000 });
  if (!sendNow) return { ok: false, reason: "send_now_not_found" };
  await humanClick(cursor, page, sendNow.locator);
  await sleep(jitter(700, 1500));

  // Error toast?
  for (const s of sel.connect.error_toast) {
    if ((await page.locator(s).count()) > 0) {
      const toastText = await page.locator(s).first().innerText().catch(() => "unknown");
      return { ok: false, reason: `toast:${toastText.trim()}` };
    }
  }

  await inspectPage(page, { stage: "send_connect_post" });
  return { ok: true, path: clicked ? "click_send_now" : "unknown" };
}
