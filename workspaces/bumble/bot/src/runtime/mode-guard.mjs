// Mode guard. Bumble web ONLY renders Date mode (BFF/Bizz live on subdomain
// surfaces or in mobile app). Discovery showed there is no Date/BFF/Bizz toggle
// in the web SPA - the conversations-tab-section + encounters-user being present
// IS the active-Date marker.
//
// Strategy: presence-based. If sels.mode_picker resolves on the page, we're in
// Date mode. If it does not resolve when expected (post-discovery, on the app
// surface), halt - we may have been forced to a different surface.

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
// Presence-based detection: if any mode_picker selector resolves on the page,
// we're in Date mode (Bumble web only renders Date). If NO picker resolves AND
// the URL is on /app, that's a real signal something's wrong.
export async function readActiveMode(page) {
  const sels = await selectors();

  // CODEX-R8-P0-1: BFF/Bizz markers MUST be checked FIRST. Previously the
  // mode_picker presence check returned "Date" early; if we landed on a BFF
  // surface that ALSO renders the mode_picker selector, the non-Date check
  // was unreachable and we'd false-pass BFF as Date. Order is fail-closed:
  //   1. If body text shouts BFF/Bizz mode active -> return that (caller halts).
  //   2. If mode_picker resolves AND no BFF/Bizz signal -> return Date.
  //   3. Otherwise null.
  try {
    const bizzy = await page.evaluate(() => {
      const text = (document.body?.innerText || "").toLowerCase();
      const bffActive = /\bbff\s+mode\b|\bbumble\s+bff\b/.test(text) && !/switch to bff/.test(text);
      const bizzActive = /\bbizz\s+mode\b|\bbumble\s+bizz\b/.test(text) && !/switch to bizz/.test(text);
      return bffActive ? "BFF" : (bizzActive ? "Bizz" : null);
    });
    if (bizzy) return bizzy;
  } catch { /* skip */ }

  const sel = sels.mode_picker;
  if (!sel?.selector) return null;
  const candidates = [sel.selector, ...(sel.alt || [])].filter(Boolean);
  for (const q of candidates) {
    try {
      const found = await page.$(q);
      if (found) return "Date";
    } catch { /* invalid selector; try next */ }
  }
  return null;
}

// CODEX-R2-P0-5: when mode_picker selector IS configured (post-discovery), null
// mode means the selector resolved but no active mode was found - that's a hard
// fail-closed signal on Bumble. Pre-discovery (selector not configured), warn-only
// is fine because the picker may legitimately not be on this page.
export async function assertDateMode(page) {
  const sels = await selectors();
  const selectorConfigured = !!(sels.mode_picker && sels.mode_picker.selector);
  const mode = await readActiveMode(page);
  if (mode == null) {
    if (selectorConfigured) {
      const reason = "mode_not_date:undetectable";
      await setHalt(reason);
      await logSession({ event: "halt", kind: "mode_undetectable", url: page.url() });
      throw new Error(`HALTED: ${reason}`);
    }
    // Pre-discovery: warn only.
    return { mode: null, asserted: false, configured: false };
  }
  if (!ACCEPTED_MODES.includes(mode)) {
    const reason = `mode_not_date:${mode}`;
    await setHalt(reason);
    await logSession({ event: "halt", kind: "mode_not_date", mode, url: page.url() });
    throw new Error(`HALTED: ${reason}`);
  }
  return { mode, asserted: true, configured: selectorConfigured };
}
