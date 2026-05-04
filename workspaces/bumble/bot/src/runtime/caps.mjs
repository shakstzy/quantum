import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { CAPS_FILE, RATE_STATE_FILE } from "./paths.mjs";

let _capsCache = null;
export async function loadCaps() {
  if (_capsCache) return _capsCache;
  _capsCache = JSON.parse(await readFile(CAPS_FILE, "utf8"));
  return _capsCache;
}

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

async function saveState(state) {
  const tmp = RATE_STATE_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, RATE_STATE_FILE);
}

// CODEX-R6-P0-3: doctrine and schedule are America/Chicago, but keys were UTC.
// Use the local-day key so the daily cap resets at local midnight, not UTC midnight.
const TZ = "America/Chicago";
function localKey(slice) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(new Date()).map(p => [p.type, p.value]));
  // en-CA gives "YYYY-MM-DD" + hour as 2-digit
  if (slice === "day") return `${parts.year}-${parts.month}-${parts.day}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}
function todayKey() { return localKey("day"); }
function hourKey() { return localKey("hour"); }

// CODEX-R6-P0-4: rolling 60-min window for messages. Persist a list of message
// timestamps; trim entries older than 60 min on every read.
function pruneRolling(state, kind, windowMs) {
  state.rolling = state.rolling || {};
  state.rolling[kind] = (state.rolling[kind] || []).filter(ts => Date.now() - ts < windowMs);
  return state.rolling[kind];
}

function pruneOld(s) {
  const today = todayKey();
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

// CODEX-R2-P0-3: peek-then-commit pattern. Use this BEFORE the irreversible
// UI action; if `exceeded` is true, abort. Then call checkAndIncrement() AFTER
// the action succeeds. This guarantees we never perform action #51 only to
// discover the cap was 50.
export async function peekCap(kind) {
  const caps = await loadCaps();
  const state = await loadState();
  pruneOld(state);
  const today = todayKey();
  const thisHour = hourKey();
  const dayUsed = (state.day[today] || {})[kind] || 0;
  const hourUsed = (state.hour[thisHour] || {})[kind] || 0;
  const dayLimit = kind === "swipe" ? caps.swipes.per_day : null;
  const hourLimit = kind === "message" ? caps.messages.per_hour : null;
  const exceeded =
    (dayLimit != null && dayUsed >= dayLimit) ||
    (hourLimit != null && hourUsed >= hourLimit);
  return { dayUsed, dayLimit, hourUsed, hourLimit, exceeded };
}

// CODEX-R5-P0-4+5 + R6-P0-4+5: reserve-under-lock cap with rolling-window
// support for messages and between-action gap enforcement. Throws if cap
// reached or if the minimum gap since last action hasn't elapsed.
export async function reserveCap(kind) {
  const caps = await loadCaps();
  return withState((state) => {
    pruneOld(state);
    const today = todayKey();
    const thisHour = hourKey();
    state.day[today] = state.day[today] || {};
    state.hour[thisHour] = state.hour[thisHour] || {};
    const dayUsed = state.day[today][kind] || 0;
    const hourUsed = state.hour[thisHour][kind] || 0;

    // Rolling 60-min check for messages (the doctrine).
    let rollingNow = null;
    if (kind === "message") {
      rollingNow = pruneRolling(state, kind, 3600 * 1000);
      if (rollingNow.length >= caps.messages.per_hour) {
        const oldestAge = Math.round((Date.now() - rollingNow[0]) / 1000);
        throw new Error(`cap_reached: messages rolling-60min ${rollingNow.length}/${caps.messages.per_hour} (oldest ${oldestAge}s ago)`);
      }
    }

    // Daily swipe cap (local day).
    if (kind === "swipe" && dayUsed >= caps.swipes.per_day) {
      throw new Error(`cap_reached: swipes daily ${dayUsed}/${caps.swipes.per_day}`);
    }

    // Between-action gap enforcement (CODEX-R6-P0-5).
    state.last = state.last || {};
    const lastTs = state.last[kind] || 0;
    const gap = Date.now() - lastTs;
    if (kind === "message") {
      const min = caps.messages.between_messages_ms?.[0] ?? 0;
      if (lastTs && gap < min) throw new Error(`min_gap: messages need ${min}ms between, only ${gap}ms since last`);
    }
    if (kind === "swipe") {
      const min = caps.swipes.global_min_gap_ms ?? 0;
      if (lastTs && gap < min) throw new Error(`min_gap: swipes need ${min}ms between, only ${gap}ms since last`);
    }

    // 2026-05-04: capture state.last[kind] BEFORE clobbering, so releaseCap
    // can restore it on failed-send. Without this, a thread_not_found at
    // openThread time would update state.last to "now", and the next send
    // attempt 11s later would trip min_gap=60s on a send that never happened.
    // Use a SHARED `now` so reservedAt === state.last[kind] exactly,
    // letting releaseCap detect "still our value, safe to restore".
    const now = Date.now();
    const priorLast = state.last[kind];
    state.day[today][kind] = dayUsed + 1;
    state.hour[thisHour][kind] = hourUsed + 1;
    state.last[kind] = now;
    if (kind === "message") {
      rollingNow.push(now);
      state.rolling[kind] = rollingNow;
    }
    return {
      reservationId: `${kind}-${today}-${thisHour}-${dayUsed + 1}`,
      dayUsed: dayUsed + 1,
      hourUsed: hourUsed + 1,
      rollingCount: kind === "message" ? rollingNow.length : null,
      kind, today, thisHour,
      reservedAt: now,
      priorLast,
    };
  });
}

export async function releaseCap(reservation) {
  if (!reservation) return;
  return withState((state) => {
    state.day[reservation.today] = state.day[reservation.today] || {};
    state.hour[reservation.thisHour] = state.hour[reservation.thisHour] || {};
    const dayUsed = state.day[reservation.today][reservation.kind] || 0;
    const hourUsed = state.hour[reservation.thisHour][reservation.kind] || 0;
    state.day[reservation.today][reservation.kind] = Math.max(0, dayUsed - 1);
    state.hour[reservation.thisHour][reservation.kind] = Math.max(0, hourUsed - 1);
    // Pop the rolling-window entry that this reservation added (best-effort: pop the
    // closest-to-reservedAt timestamp). Avoids inflating the rolling count from
    // a failed action.
    if (reservation.kind === "message" && state.rolling?.message?.length) {
      const idx = state.rolling.message.findIndex(ts => Math.abs(ts - reservation.reservedAt) < 1000);
      if (idx >= 0) state.rolling.message.splice(idx, 1);
    }
    // Restore state.last so the min_gap check doesn't fire as if a real action
    // happened. Only restore if state.last hasn't been overwritten by a
    // subsequent successful action since this reservation.
    state.last = state.last || {};
    if (state.last[reservation.kind] === reservation.reservedAt) {
      state.last[reservation.kind] = reservation.priorLast || 0;
    }
  });
}

// CODEX-R1-P1-1: must run inside withState() lock, otherwise concurrent cron
// fires (swipe + pull at the same minute) can both decide skipPlan independently.
export async function shouldSkipDay() {
  const caps = await loadCaps();
  return withState((state) => {
    state.skipPlan = state.skipPlan || {};
    const today = todayKey();
    if (state.skipPlan[today] === undefined) {
      state.skipPlan[today] = Math.random() < caps.global.skip_day_probability;
      for (const k of Object.keys(state.skipPlan)) if (k !== today) delete state.skipPlan[k];
    }
    return state.skipPlan[today];
  });
}
