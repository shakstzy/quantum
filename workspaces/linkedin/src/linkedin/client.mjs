// PatchrightLinkedInAPI. In-page fetch wrapper for LinkedIn's internal Voyager API.
// Inherits browser fingerprint + cookies + CSRF from the persistent context.
//
// Hardenings (vs OpenOutreach reference):
// - CSRF token is refreshed on EVERY call (Gemini-Flash adversarial fix #4: JSESSIONID rotates
//   mid-session in 2026; cached values turn into 403s).
// - Watchdog timer closes the page if the in-page evaluate hangs (e.g. Chromium OOM, captcha overlay).
// - Optional fixture cache (.dev-fixtures/) for read-only dev iteration without burning live calls.

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { csrfToken } from "./session.mjs";
import { inspectPage, isHttpBanStatus } from "./ban-signals.mjs";
import { BanSignalError, BrowserUnresponsiveError, ProfileInaccessibleError } from "../runtime/exceptions.mjs";
import { FIXTURES_DIR } from "../runtime/paths.mjs";

const VOYAGER_BASE = "https://www.linkedin.com/voyager/api";
const DEFAULT_TIMEOUT_MS = 30_000;

const FETCH_JS = `async ({ method, url, headers, body, timeoutMs }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const init = { method, headers, credentials: "include", signal: ctrl.signal };
  if (body !== null && body !== undefined) init.body = body;
  try {
    const r = await fetch(url, init);
    return { status: r.status, ok: r.ok, body: await r.text() };
  } finally {
    clearTimeout(timer);
  }
}`;

export class LinkedInClient {
  constructor({ ctx, page, timeoutMs = DEFAULT_TIMEOUT_MS, fixtureMode = false } = {}) {
    if (!ctx || !page) throw new Error("LinkedInClient requires { ctx, page }");
    this.ctx = ctx;
    this.page = page;
    this.timeoutMs = timeoutMs;
    this.fixtureMode = fixtureMode || process.env.QUANTUM_LINKEDIN_FIXTURE_MODE === "1";
  }

  async _baseHeaders() {
    const csrf = await csrfToken(this.ctx);
    return {
      "accept": "application/vnd.linkedin.normalized+json+2.1",
      "csrf-token": csrf,
      "x-li-lang": "en_US",
      "x-restli-protocol-version": "2.0.0",
    };
  }

  _fixtureKey(method, url, body) {
    const h = createHash("sha256");
    h.update(method);
    h.update("\n");
    h.update(url);
    if (body) { h.update("\n"); h.update(body); }
    return h.digest("hex").slice(0, 16);
  }

  _fixturePath(endpoint, key) {
    return join(FIXTURES_DIR, endpoint.replace(/[^a-zA-Z0-9]+/g, "_"), `${key}.json`);
  }

  async _readFixture(method, url, body, endpoint) {
    if (!this.fixtureMode) return null;
    const key = this._fixtureKey(method, url, body);
    try {
      const text = await fs.readFile(this._fixturePath(endpoint, key), "utf8");
      return JSON.parse(text);
    } catch { return null; }
  }

  async _writeFixture(method, url, body, endpoint, payload) {
    if (!this.fixtureMode) return;
    const key = this._fixtureKey(method, url, body);
    const path = this._fixturePath(endpoint, key);
    try {
      await fs.mkdir(join(FIXTURES_DIR, endpoint.replace(/[^a-zA-Z0-9]+/g, "_")), { recursive: true });
      await fs.writeFile(path, JSON.stringify(payload, null, 2), "utf8");
    } catch { /* tolerate */ }
  }

  async _runWithWatchdog(label, fn) {
    let killed = false;
    const deadlineMs = this.timeoutMs * 2;
    const timer = setTimeout(() => {
      killed = true;
      this.page.close({ runBeforeUnload: false }).catch(() => {});
    }, deadlineMs);
    try {
      const result = await fn();
      if (killed) {
        throw new BrowserUnresponsiveError(`Watchdog killed page on ${label} after ${deadlineMs}ms`);
      }
      return result;
    } catch (err) {
      if (killed) {
        throw new BrowserUnresponsiveError(`Watchdog killed page on ${label} after ${deadlineMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _fetch({ method, url, headers, body = null, endpoint }) {
    if (this.fixtureMode) {
      const cached = await this._readFixture(method, url, body, endpoint);
      if (cached) return cached;
    }
    // Pre-flight inspect for soft checkpoints. Throws on hard signals.
    await inspectPage(this.page, { stage: `pre_${endpoint}` });

    const arg = { method, url, headers, body, timeoutMs: this.timeoutMs };
    const raw = await this._runWithWatchdog(`${method} ${endpoint}`, () =>
      this.page.evaluate(FETCH_JS, arg)
    );

    // Post-flight: if the response was a 401/403/429 OR the page navigated to authwall, surface.
    if (isHttpBanStatus(raw.status)) {
      // Some 403s are profile-private (recoverable). Re-inspect the page url to differentiate.
      try {
        await inspectPage(this.page, { stage: `post_${endpoint}_${raw.status}` });
      } catch (err) {
        throw err; // BanSignalError or CheckpointError
      }
      // Page is fine -> treat as resource-level
      if (raw.status === 403) {
        throw new ProfileInaccessibleError(`Voyager returned 403 on ${endpoint}`, { status: 403 });
      }
      throw new BanSignalError(`Voyager ${raw.status} on ${endpoint}`, { signal: `http_${raw.status}` });
    }

    if (this.fixtureMode) await this._writeFixture(method, url, body, endpoint, raw);
    return raw;
  }

  async get(path, { params, endpoint = path } = {}) {
    const url = params ? `${VOYAGER_BASE}${path}?${new URLSearchParams(params).toString()}` : `${VOYAGER_BASE}${path}`;
    const headers = await this._baseHeaders();
    const raw = await this._fetch({ method: "GET", url, headers, endpoint });
    return parseRaw(raw);
  }

  async post(path, { body, headers: extra = {}, endpoint = path } = {}) {
    const url = `${VOYAGER_BASE}${path}`;
    const baseHeaders = await this._baseHeaders();
    const headers = {
      ...baseHeaders,
      "accept": "application/json",
      "content-type": "text/plain;charset=UTF-8",
      ...extra,
    };
    const raw = await this._fetch({ method: "POST", url, headers, body, endpoint });
    return parseRaw(raw);
  }
}

function parseRaw(raw) {
  if (!raw.body) return { _status: raw.status, _empty: true };
  try {
    return { _status: raw.status, _ok: raw.ok, ...JSON.parse(raw.body) };
  } catch {
    return { _status: raw.status, _ok: raw.ok, _text: raw.body };
  }
}
