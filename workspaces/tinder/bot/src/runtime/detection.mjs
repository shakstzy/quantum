import { readFile } from "node:fs/promises";
import { SELECTORS_FILE } from "./paths.mjs";
import { setHalt } from "./halt.mjs";
import { logSession } from "./logger.mjs";

let _selectors = null;

export async function selectors() {
  if (_selectors) return _selectors;
  _selectors = JSON.parse(await readFile(SELECTORS_FILE, "utf8"));
  return _selectors;
}

const HALT_KINDS = ["arkose_iframe", "face_check_prompt", "rate_limit_banner", "login_wall"];

async function present(page, sel) {
  if (!sel) return false;
  const candidates = [sel.selector, ...(sel.alt || [])].filter(s => s != null);
  for (const s of candidates) {
    try {
      const el = await page.$(s);
      if (el) return true;
    } catch { /* invalid selector, skip */ }
  }
  return false;
}

export async function scanForHalts(page) {
  const sels = await selectors();
  for (const kind of HALT_KINDS) {
    if (await present(page, sels[kind])) {
      const reason = `detection:${kind}`;
      await setHalt(reason);
      await logSession({ event: "halt", kind, url: page.url() });
      throw new Error(`HALTED: ${reason}`);
    }
  }
}

// (ensureSelectorsHealthy removed — caused more false-halts than real catches.
// Each script now uses inline `page.waitForSelector` for the elements IT needs
// on the page IT loads. If a selector breaks during a swipe/send/scrape, the
// primitive throws naturally — same halt outcome, less error surface.)
