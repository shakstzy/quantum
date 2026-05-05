// Daily / weekly counters + active-hours guard. Reads config/caps.json. Persists to
// ~/.quantum/linkedin/state/rate-state.json with proper-lockfile.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { CAPS_FILE, RATE_STATE_FILE } from "./paths.mjs";
import { RateLimitExceeded } from "./exceptions.mjs";

let _capsCache = null;

export async function loadCaps() {
  if (_capsCache) return _capsCache;
  _capsCache = JSON.parse(await fs.readFile(CAPS_FILE, "utf8"));
  return _capsCache;
}

async function ensureStateFile() {
  await fs.mkdir(dirname(RATE_STATE_FILE), { recursive: true });
  try {
    await fs.access(RATE_STATE_FILE);
  } catch {
    await fs.writeFile(RATE_STATE_FILE, JSON.stringify({}), "utf8");
  }
}

async function readState() {
  await ensureStateFile();
  const text = await fs.readFile(RATE_STATE_FILE, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function writeStateAtomic(state) {
  const tmp = RATE_STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, RATE_STATE_FILE);
}

export function dayKey(d = new Date(), tz = "America/Chicago") {
  // YYYY-MM-DD in CST. Intl handles DST.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

function inActiveHours(caps, d = new Date()) {
  const tz = caps.active_hours.tz;
  const hr = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(d)
  );
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  const isWeekend = dow === "Sat" || dow === "Sun";
  if (caps.active_hours.weekdays_only && isWeekend) return false;
  return hr >= caps.active_hours.start && hr < caps.active_hours.end;
}

export async function checkBudget(action, { skipActiveHours = false } = {}) {
  const caps = await loadCaps();
  // Env-var override for dev/smoke testing outside the configured active-hours window.
  const envBypass = process.env.QUANTUM_LINKEDIN_SKIP_ACTIVE_HOURS === "1";
  if (!skipActiveHours && !envBypass && !inActiveHours(caps)) {
    throw new RateLimitExceeded(
      `Outside active hours (${caps.active_hours.start}:00-${caps.active_hours.end}:00 ${caps.active_hours.tz})`,
      { action, scope: "active_hours" }
    );
  }
  const state = await readState();
  const today = dayKey();
  const dailyCap = caps.daily[action];
  if (dailyCap !== undefined) {
    const used = state.daily?.[today]?.[action] ?? 0;
    if (used >= dailyCap) {
      throw new RateLimitExceeded(
        `Daily cap reached for ${action}: ${used}/${dailyCap}`,
        { action, scope: "daily" }
      );
    }
  }
  const weeklyCap = caps.weekly?.[action];
  if (weeklyCap !== undefined) {
    const used = sumLastNDays(state, action, 7);
    if (used >= weeklyCap) {
      throw new RateLimitExceeded(
        `Weekly cap reached for ${action}: ${used}/${weeklyCap}`,
        { action, scope: "weekly" }
      );
    }
  }
  return true;
}

function sumLastNDays(state, action, n) {
  if (!state.daily) return 0;
  const d = new Date();
  let total = 0;
  for (let i = 0; i < n; i++) {
    const k = dayKey(new Date(d.getTime() - i * 86400_000));
    total += state.daily?.[k]?.[action] ?? 0;
  }
  return total;
}

export async function recordAction(action, n = 1) {
  await ensureStateFile();
  const release = await lockfile.lock(RATE_STATE_FILE, { retries: { retries: 8, minTimeout: 50 } });
  try {
    const state = await readState();
    const today = dayKey();
    state.daily ??= {};
    state.daily[today] ??= {};
    state.daily[today][action] = (state.daily[today][action] ?? 0) + n;
    // Garbage-collect entries older than 30 days.
    const cutoff = dayKey(new Date(Date.now() - 30 * 86400_000));
    for (const k of Object.keys(state.daily)) {
      if (k < cutoff) delete state.daily[k];
    }
    await writeStateAtomic(state);
  } finally {
    await release();
  }
}

export async function readCounters() {
  const state = await readState();
  const today = dayKey();
  const caps = await loadCaps();
  const out = {};
  for (const [action, cap] of Object.entries(caps.daily)) {
    out[action] = {
      used: state.daily?.[today]?.[action] ?? 0,
      cap,
      week_used: sumLastNDays(state, action, 7),
      week_cap: caps.weekly?.[action] ?? null,
    };
  }
  out._active_hours_now = inActiveHours(caps);
  return out;
}
