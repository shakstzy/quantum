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

// CODEX-R4-P0-3: invalid syntax on a HALT_KIND selector now halts loudly. Stdout
// in cron is not a safety mechanism, and silently disabling a halt selector
// during the exact event it exists for is the wrong default. Returns true if
// present, throws if syntax invalid (caller treats as halt).
async function presentForHalt(page, sel, kind) {
  if (!sel) return false;
  const candidates = [sel.selector, ...(sel.alt || [])].filter(s => s != null);
  for (const s of candidates) {
    try {
      const el = await page.$(s);
      if (el) return true;
    } catch (e) {
      const reason = `selector_invalid:${kind}:${JSON.stringify(s).slice(0, 80)}`;
      await setHalt(reason);
      await logSession({ event: "halt", kind: "selector_invalid", halt_kind: kind, selector: s, error: e.message });
      throw new Error(`HALTED: ${reason}`);
    }
  }
  return false;
}

// Action selectors that, if configured, mean the bot can perform irreversible
// actions. If ANY of these is wired, ALL halt-kind selectors must also be wired
// or scanForHalts will fail closed at the start of the call.
const ACTION_SELECTORS_THAT_REQUIRE_FULL_HALT_LADDER = ["like_button", "pass_button", "thread_input"];

export async function scanForHalts(page) {
  const sels = await selectors();

  // CODEX-R4-P0-2: if any action selector is wired, require ALL halt selectors
  // to be wired too. The first day post-discovery is the highest risk window;
  // we cannot let the bot run irreversible actions while the ban-breaker is
  // still null-stubbed.
  const anyActionWired = ACTION_SELECTORS_THAT_REQUIRE_FULL_HALT_LADDER
    .some(k => sels[k]?.selector);
  if (anyActionWired) {
    const missing = HALT_KINDS.filter(k => !sels[k]?.selector);
    if (missing.length > 0) {
      const reason = `halt_ladder_incomplete:${missing.join(",")}`;
      await setHalt(reason);
      await logSession({ event: "halt", kind: "halt_ladder_incomplete", missing });
      throw new Error(`HALTED: ${reason}. Wire all halt-kind selectors before running with action selectors.`);
    }
  }

  for (const kind of HALT_KINDS) {
    if (await presentForHalt(page, sels[kind], kind)) {
      const reason = `detection:${kind}`;
      await setHalt(reason);
      await logSession({ event: "halt", kind, url: page.url() });
      throw new Error(`HALTED: ${reason}`);
    }
  }
}
