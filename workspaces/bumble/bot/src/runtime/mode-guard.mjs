// Mode guard. Bumble has Date / BFF / Bizz modes. The bot must always be in Date mode.
// Halt loudly if it's not - reading BFF chats with dating-voice drafting is the failure
// mode this guards against.
//
// Selector for the active mode indicator lives at `selectors.mode_picker`. Until
// discovery is done, this is best-effort: it queries by aria-label / text.

import { selectors } from "./detection.mjs";
import { setHalt } from "./halt.mjs";
import { logSession } from "./logger.mjs";

const ACCEPTED_MODES = ["date", "Date"];

export async function readActiveMode(page) {
  // Try the configured selector first.
  const sels = await selectors();
  const sel = sels.mode_picker;
  if (sel?.selector) {
    try {
      const el = await page.$(sel.selector);
      if (el) {
        const txt = (await el.textContent())?.trim() || (await el.getAttribute("aria-label"));
        if (txt) return txt;
      }
    } catch { /* fall through */ }
  }
  // Heuristic fallback: look for any element whose text equals one of the three modes.
  for (const candidate of ["Date", "BFF", "Bizz"]) {
    try {
      const el = await page.getByText(candidate, { exact: true }).first();
      const visible = await el?.isVisible?.().catch(() => false);
      if (visible) return candidate;
    } catch { /* skip */ }
  }
  return null;
}

export async function assertDateMode(page) {
  const mode = await readActiveMode(page);
  if (mode == null) {
    // Could not detect mode at all. Don't halt on this - mode picker may not be on this page.
    return { mode: null, asserted: false };
  }
  if (!ACCEPTED_MODES.includes(mode)) {
    const reason = `mode_not_date:${mode}`;
    await setHalt(reason);
    await logSession({ event: "halt", kind: "mode_not_date", mode, url: page.url() });
    throw new Error(`HALTED: ${reason}`);
  }
  return { mode, asserted: true };
}
