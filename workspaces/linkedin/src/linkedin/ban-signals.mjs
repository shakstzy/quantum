// Detect LinkedIn ban / checkpoint / rate-limit signals. Every Voyager call and DOM action
// runs this both BEFORE and AFTER. On any hit we throw BanSignalError. The caller decides
// whether to quarantine the profile (hard signal) or just halt (soft signal).

import { promises as fs } from "node:fs";
import { SELECTORS_FILE } from "../runtime/paths.mjs";
import { BanSignalError, CheckpointError } from "../runtime/exceptions.mjs";

let _selectors = null;
async function selectors() {
  if (_selectors) return _selectors;
  _selectors = JSON.parse(await fs.readFile(SELECTORS_FILE, "utf8"));
  return _selectors;
}

const HARD_PATHS = ["/checkpoint/lg/login-submit", "/uas/login-submit", "/authwall"];
const SOFT_PATHS = ["/checkpoint/", "/uas/login"];

export async function inspectPage(page, { stage = "unknown" } = {}) {
  const url = page.url();
  const sel = await selectors();

  for (const p of HARD_PATHS) {
    if (url.includes(p)) {
      throw new BanSignalError(`Hard ban path: ${p}`, { signal: "auth_wall", url });
    }
  }
  for (const p of SOFT_PATHS) {
    if (url.includes(p)) {
      throw new CheckpointError(`Soft checkpoint at ${url}`, { kind: "checkpoint", hint: "manual login required" });
    }
  }

  // Captcha
  for (const s of sel.captcha) {
    try {
      if ((await page.locator(s).count()) > 0) {
        throw new CheckpointError(`Captcha detected at ${stage}`, { kind: "captcha" });
      }
    } catch (err) {
      if (err instanceof CheckpointError) throw err;
    }
  }

  // OTP/PIN form
  for (const s of sel.checkpoint) {
    try {
      if ((await page.locator(s).count()) > 0) {
        throw new CheckpointError(`OTP / PIN form detected at ${stage}`, { kind: "otp" });
      }
    } catch (err) {
      if (err instanceof CheckpointError) throw err;
    }
  }

  // Comply gate (interstitial). Soft — caller can dismiss it.
  for (const s of sel.comply_gate) {
    try {
      if ((await page.locator(s).count()) > 0) {
        return { complyGate: true, url };
      }
    } catch { /* ignore */ }
  }

  // Weekly invite limit popup. Caller (send_connect) handles via RateLimitExceeded mapping.
  for (const s of sel.weekly_invite_limit) {
    try {
      if ((await page.locator(s).count()) > 0) {
        return { weeklyInviteLimit: true, url };
      }
    } catch { /* ignore */ }
  }

  return { ok: true, url };
}

export function isHttpBanStatus(status) {
  return status === 401 || status === 403 || status === 429 || status === 999;
}

export async function dismissComplyGate(page, { timeoutMs = 4000 } = {}) {
  const sel = await selectors();
  for (const s of sel.comply_gate) {
    const loc = page.locator(s).first();
    try {
      await loc.waitFor({ state: "visible", timeout: timeoutMs });
      await loc.click();
      return true;
    } catch { /* try next */ }
  }
  return false;
}
