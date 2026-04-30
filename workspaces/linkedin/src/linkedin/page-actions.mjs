// Page-level helpers shared across reads and writes. Ported from
// stickerdaniel/linkedin-mcp-server core/utils.py + core/auth.py with the same
// "minimize DOM dependence" philosophy.

import { sleep } from "../runtime/humanize.mjs";
import { CheckpointError, BanSignalError } from "../runtime/exceptions.mjs";

const _AUTH_BLOCKER_PATTERNS = ["/login", "/authwall", "/checkpoint", "/challenge", "/uas/login"];
const _AUTHENTICATED_PATHS = ["/feed", "/mynetwork", "/messaging", "/notifications"];
const _RATE_LIMIT_PHRASES = ["too many requests", "rate limit", "slow down", "try again later"];

const MODAL_CLOSE_SELECTOR = [
  'button[aria-label="Dismiss"]',
  'button[aria-label="Close"]',
  "button.artdeco-modal__dismiss",
].join(", ");

export async function detectRateLimit(page) {
  const url = page.url();
  if (url.includes("/checkpoint") || url.includes("/authwall")) {
    throw new CheckpointError(`LinkedIn checkpoint at ${url}`, { kind: "checkpoint", hint: "manual login required" });
  }
  // Body-text heuristic: only on error-shaped pages (no <main>, short body).
  try {
    const hasMain = (await page.locator("main").count()) > 0;
    if (hasMain) return;
    const text = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    if (!text || text.length >= 2000) return;
    const lower = text.toLowerCase();
    for (const phrase of _RATE_LIMIT_PHRASES) {
      if (lower.includes(phrase)) {
        throw new BanSignalError(`Rate-limit page detected: "${phrase}"`, { signal: "rate_limit_page", url });
      }
    }
  } catch (err) {
    if (err instanceof BanSignalError || err instanceof CheckpointError) throw err;
    /* tolerate timing errors */
  }
}

export async function handleModalClose(page) {
  try {
    const btn = page.locator(MODAL_CLOSE_SELECTOR).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await sleep(500);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// Three-tier login state check (URL fail-fast → nav-element check → URL fallback with body-text gate).
// Mirror of auth.py:is_logged_in. We don't compute or store cookies here — the persistent profile does that.
export async function isLoggedIn(page) {
  const url = page.url();
  if (_AUTH_BLOCKER_PATTERNS.some((p) => url.includes(p))) return false;

  const oldNav = await page.locator('.global-nav__primary-link, [data-control-name="nav.settings"]').count().catch(() => 0);
  const newNav = await page.locator('nav a[href*="/feed"], nav button:has-text("Home"), nav a[href*="/mynetwork"]').count().catch(() => 0);
  const hasNav = oldNav > 0 || newNav > 0;

  const isAuthPath = _AUTHENTICATED_PATHS.some((p) => url.includes(p));
  if (!isAuthPath) return hasNav;
  if (hasNav) return true;
  // Bridge case: URL is /feed but nav not loaded yet — require some real body text.
  const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  return Boolean(body && body.trim());
}

// Scroll the main scrollable region (used for inbox + long sections). Returns scroll count.
export async function scrollMainScrollable(page, { attempts = 3, pauseMs = 500, position = "bottom" } = {}) {
  const scrolled = await page.evaluate(async ({ attempts, pauseMs, position }) => {
    const main = document.querySelector("main");
    if (!main) return -1;
    let container = null;
    // Walk descendants to find the first scrollable container with content overflow.
    const candidates = main.querySelectorAll("*");
    for (const el of candidates) {
      const s = window.getComputedStyle(el);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
        container = el;
        break;
      }
    }
    if (!container) container = main;
    let scrollCount = 0;
    for (let i = 0; i < attempts; i++) {
      const prev = container.scrollHeight;
      if (position === "top") container.scrollTop = 0;
      else container.scrollTop = container.scrollHeight;
      await new Promise((r) => setTimeout(r, pauseMs));
      if (container.scrollHeight === prev && position !== "top") break;
      scrollCount += 1;
    }
    return scrollCount;
  }, { attempts, pauseMs, position });
  return scrolled;
}

export async function waitForMainText(page, { timeoutMs = 8000 } = {}) {
  try {
    await page.waitForSelector("main", { timeout: timeoutMs });
    // Tiny extra wait so SPA content lands.
    await sleep(400);
  } catch { /* ok, caller decides */ }
}
