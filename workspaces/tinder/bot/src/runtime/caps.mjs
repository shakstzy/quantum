import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { CAPS_FILE, RATE_STATE_FILE } from "./paths.mjs";

// Caps are immutable config; safe to cache.
let _capsCache = null;
export async function loadCaps() {
  if (_capsCache) return _capsCache;
  _capsCache = JSON.parse(await readFile(CAPS_FILE, "utf8"));
  return _capsCache;
}

// C1 FIX: rate-state.json is shared across concurrent sessions (cron + manual).
// Wrap every read-modify-write in a proper-lockfile transaction to prevent race
// where two sessions both read 99 and both write 100, blowing the daily cap.
async function ensureStateFile() {
  await mkdir(dirname(RATE_STATE_FILE), { recursive: true });
  try { await readFile(RATE_STATE_FILE, "utf8"); }
  catch { await writeFile(RATE_STATE_FILE, JSON.stringify({ day: {}, hour: {}, last: {} }, null, 2)); }
}

async function withState(fn) {
  await ensureStateFile();
  const release = await lockfile.lock(RATE_STATE_FILE, {
    retries: { retries: 50, minTimeout: 50, maxTimeout: 500, factor: 1.4 },
    stale: 30000,
  });
  try {
    let state;
    try { state = JSON.parse(await readFile(RATE_STATE_FILE, "utf8")); }
    catch { state = { day: {}, hour: {}, last: {} }; }
    const result = await fn(state);
    const tmp = RATE_STATE_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, RATE_STATE_FILE);
    return result;
  } finally {
    await release();
  }
}

async function loadState() {
  await ensureStateFile();
  try { return JSON.parse(await readFile(RATE_STATE_FILE, "utf8")); }
  catch { return { day: {}, hour: {}, last: {} }; }
}

function todayKey() { return new Date().toISOString().slice(0, 10); }
function hourKey() { return new Date().toISOString().slice(0, 13); }

function pruneOld(s) {
  const today = todayKey();
  const thisHour = hourKey();
  for (const k of Object.keys(s.day || {})) if (k !== today) delete s.day[k];
  for (const k of Object.keys(s.hour || {})) if (!k.startsWith(today)) delete s.hour[k];
  if (Object.keys(s.hour || {}).length > 48) {
    const sorted = Object.keys(s.hour).sort();
    for (const k of sorted.slice(0, sorted.length - 24)) delete s.hour[k];
  }
}

export async function checkAndIncrement(kind) {
  const caps = await loadCaps();
  return withState((state) => {
    pruneOld(state);
    const today = todayKey();
    const thisHour = hourKey();
    state.day[today] = state.day[today] || {};
    state.hour[thisHour] = state.hour[thisHour] || {};
    state.last = state.last || {};

    const dayUsed = state.day[today][kind] || 0;
    const hourUsed = state.hour[thisHour][kind] || 0;

    if (kind === "swipe" && dayUsed >= caps.swipes.per_day) {
      throw new Error(`cap_reached: swipes daily ${dayUsed}/${caps.swipes.per_day}`);
    }
    if (kind === "message" && hourUsed >= caps.messages.per_hour) {
      throw new Error(`cap_reached: messages hourly ${hourUsed}/${caps.messages.per_hour}`);
    }

    state.day[today][kind] = dayUsed + 1;
    state.hour[thisHour][kind] = hourUsed + 1;
    state.last[kind] = Date.now();
    return { dayUsed: dayUsed + 1, hourUsed: hourUsed + 1 };
  });
}

export async function readCounters() {
  const state = await loadState();
  pruneOld(state);
  return { day: state.day[todayKey()] || {}, hour: state.hour[hourKey()] || {}, last: state.last || {} };
}

export async function shouldSkipDay() {
  const caps = await loadCaps();
  const state = await loadState();
  state.skipPlan = state.skipPlan || {};
  const today = todayKey();
  if (state.skipPlan[today] === undefined) {
    state.skipPlan[today] = Math.random() < caps.global.skip_day_probability;
    for (const k of Object.keys(state.skipPlan)) if (k !== today) delete state.skipPlan[k];
    await saveState(state);
  }
  return state.skipPlan[today];
}
