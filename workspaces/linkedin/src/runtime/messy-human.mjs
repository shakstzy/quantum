// "Messy human" behavior layer. Per Gemini-Flash adversarial review (2026-04-30):
// LinkedIn 2026 behavioral ML detects "randomized consistency". 15 actions in a row
// with 30-180s gaps is a tell. Real humans scroll the feed, dwell on unrelated profiles,
// and get distracted. This module emits behavioral breadcrumbs between Voyager calls.

import { humanScroll, microFidget, sleep, jitter } from "./humanize.mjs";
import { loadCaps } from "./caps.mjs";

let _actionsThisBurst = 0;

// Light-weight noise to scatter between actions. Cheap (a few hundred ms).
export async function sprinkleBetween(page) {
  const r = Math.random();
  if (r < 0.4) {
    await microFidget(page);
  } else if (r < 0.7) {
    await humanScroll(page, { distance: jitter(60, 220), steps: jitter(2, 4) });
  } else {
    await sleep(jitter(400, 1800));
  }
}

// Heavier "look around" pattern. Use between bursts.
export async function browseFeed(page, { secondsMin = 12, secondsMax = 35 } = {}) {
  const start = Date.now();
  const deadline = start + jitter(secondsMin * 1000, secondsMax * 1000);
  try {
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 20000 });
  } catch {
    return; // tolerate; this is just behavioral noise
  }
  while (Date.now() < deadline) {
    await humanScroll(page, { distance: jitter(280, 700), steps: jitter(4, 8) });
    await sleep(jitter(800, 2400));
  }
}

// Distraction probability. Some fraction of inter-action calls become a long pause.
export async function maybeGetDistracted() {
  const caps = await loadCaps();
  const p = caps.pacing.distraction_probability ?? 0.05;
  if (Math.random() >= p) return false;
  const [lo, hi] = caps.pacing.distraction_minutes ?? [8, 18];
  const ms = jitter(lo * 60_000, hi * 60_000);
  await sleep(ms);
  return true;
}

// Burst tracker. Every burst_size actions, force a long cooldown.
export async function tickBurst(page = null) {
  const caps = await loadCaps();
  _actionsThisBurst += 1;
  if (_actionsThisBurst < (caps.pacing.burst_size ?? 8)) return;
  _actionsThisBurst = 0;
  const [lo, hi] = caps.pacing.burst_cooldown_minutes ?? [45, 65];
  const ms = jitter(lo * 60_000, hi * 60_000);
  if (page) {
    try {
      await browseFeed(page, { secondsMin: 20, secondsMax: 45 });
    } catch {
      /* ignore */
    }
  }
  await sleep(ms);
}
