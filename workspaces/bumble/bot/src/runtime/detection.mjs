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
// or invasive Bumble-visible activity. If ANY of these is wired, ALL halt-kind
// selectors must also be wired or scanForHalts will fail closed at the start
// of the call.
//
// CODEX-R5-P0-3: include match-list selectors. pull.mjs scrolls and opens
// threads, which is account-behavior signal too. If the halt ladder is null
// while scrapeMatches navigates, we'd burn through verification walls silently.
const ACTION_SELECTORS_THAT_REQUIRE_FULL_HALT_LADDER = [
  "like_button", "pass_button", "thread_input",
  "matches_tab", "matches_list_item", "thread_messages",
];

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

  // Parallel text-scan for halt phrases that don't have stable CSS selectors.
  // Cheap (one evaluate) and only fires when we genuinely see the language.
  await scanHaltText(page);
}

const HALT_TEXT_CHECKS = [
  { kind: "login_wall_text", patterns: [/quick\s+sign\s+in/i, /continue with other methods/i, /sign in to bumble/i], urlContains: "/get-started" },
  { kind: "photo_verify_text", patterns: [/verify your photos/i, /photo verification required/i] },
  { kind: "rate_limit_text", patterns: [/you've been swiping too much/i, /please slow down/i, /try again in a (few|moment)/i] },
  { kind: "account_restriction_text", patterns: [/we've noticed unusual activity/i, /your account has been (suspended|restricted|blocked)/i, /this account has been disabled/i] },
];

export async function scanHaltText(page) {
  const url = page.url();
  let bodyText;
  try {
    bodyText = await page.evaluate(() => (document.body?.innerText || "").slice(0, 30000));
  } catch { return; }
  for (const check of HALT_TEXT_CHECKS) {
    if (check.urlContains && !url.includes(check.urlContains)) {
      // URL-gated check (login wall is gated to /get-started so we don't false-fire on
      // marketing copy that happens to mention 'sign in').
      continue;
    }
    for (const re of check.patterns) {
      if (re.test(bodyText)) {
        const reason = `detection:${check.kind}`;
        await setHalt(reason);
        await logSession({ event: "halt", kind: check.kind, url, matched: re.source });
        throw new Error(`HALTED: ${reason} matched=${re.source}`);
      }
    }
  }
}
