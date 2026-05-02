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

// CODEX-R1-P0-4: the previous fallback returned the FIRST visible mode label.
// A picker can show all three labels visibly while only one is the *active*
// mode. That false-passed BFF as Date. Safe rule: only trust an element that
// is explicitly marked active (aria-current, aria-selected, or active/selected
// CSS class). If no active marker is found, return null and let the caller
// decide (assertDateMode treats null as "could not detect, do not halt").
export async function readActiveMode(page) {
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
  // Safe fallback: only consider a mode "active" if the element has an active
  // marker. Reject any element that is merely visible.
  return await page.evaluate(() => {
    const labels = ["Date", "BFF", "Bizz"];
    const isActive = (el) => {
      if (!el) return false;
      if (el.getAttribute("aria-current") === "page" || el.getAttribute("aria-current") === "true") return true;
      if (el.getAttribute("aria-selected") === "true") return true;
      if (el.dataset && (el.dataset.active === "true" || el.dataset.selected === "true")) return true;
      const cls = el.getAttribute("class") || "";
      if (/\b(active|selected|is-active|is-selected|current)\b/.test(cls)) return true;
      return false;
    };
    for (const label of labels) {
      // exact-text match across all elements; check ancestor chain for an active marker
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        if ((node.textContent || "").trim() !== label) continue;
        let cur = node;
        for (let depth = 0; cur && depth < 4; depth++, cur = cur.parentElement) {
          if (isActive(cur)) return label;
        }
      }
    }
    return null;
  });
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
