// Detection ladder. Halt the bot on any P0 signal.
// Selectors live in config/selectors.json (populated by scripts/discover-dom.mjs).
// Until selectors are discovered, the only auto-detected signal is the Cloudflare
// Turnstile iframe (selector hardcoded in selectors.json since it's a stable URL match).

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

// Bumble-specific halt kinds. Wider than Tinder's because Bumble pushes
// photo verification harder and uses Cloudflare Turnstile (not Arkose).
const HALT_KINDS = [
  "turnstile_iframe",
  "photo_verify_modal",
  "rate_limit_banner",
  "login_wall",
  "account_restriction_banner",
];

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
