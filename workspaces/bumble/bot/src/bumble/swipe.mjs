// Swipe loop primitives. Skeleton; the loop body mirrors Tinder's swipe.mjs
// but the click selectors / DOM polls come from config/selectors.json which
// is populated by scripts/discover-dom.mjs.

import { readFile } from "node:fs/promises";
import { FILTER_FILE } from "../runtime/paths.mjs";
import { selectors, scanForHalts } from "../runtime/detection.mjs";
import { humanClick, makeCursor, idlePause, microFidget, sleep, jitter } from "../runtime/humanize.mjs";
import { gotoEncounters, readVisibleCard } from "./page.mjs";
import { logSwipe } from "../runtime/logger.mjs";
import { checkAndIncrement, loadCaps } from "../runtime/caps.mjs";
import { assertDateMode } from "../runtime/mode-guard.mjs";

let _filter = null;
async function loadFilter() {
  if (_filter) return _filter;
  _filter = JSON.parse(await readFile(FILTER_FILE, "utf8"));
  return _filter;
}

function passesFilter(profile, f) {
  if (profile.age != null) {
    if (profile.age < f.age_min || profile.age > f.age_max) return false;
  }
  if (profile.distance_mi != null && profile.distance_mi > f.max_distance_mi) return false;
  return true;
}

export async function swipeSession(page, { sessionMinutesMax = null } = {}) {
  const caps = await loadCaps();
  const filter = await loadFilter();
  const cursor = await makeCursor(page);
  const sels = await selectors();

  if (!sels.like_button?.selector || !sels.pass_button?.selector) {
    throw new Error("pre-discovery: swipeSession needs like_button + pass_button selectors. Run scripts/discover-dom.mjs.");
  }

  const avgGap = (caps.swipes.between_swipes_ms[0] + caps.swipes.between_swipes_ms[1]) / 2;
  const estMs = caps.swipes.per_session_max * avgGap * 1.5;
  const sessionMs = sessionMinutesMax ? sessionMinutesMax * 60 * 1000 : estMs;
  const sessionEnd = Date.now() + sessionMs;
  const testLimit = parseInt(process.env.QUANTUM_BUMBLE_TEST_LIMIT || "0", 10);
  const sessionMaxSwipes = testLimit > 0
    ? testLimit
    : jitter(caps.swipes.per_session_min, caps.swipes.per_session_max + 1);
  if (testLimit > 0) console.log(`TEST MODE: hard-capped at ${testLimit} swipes`);

  const ratioCap = caps.swipes.right_swipe_ratio_max ?? 0.5;

  await gotoEncounters(page);
  await assertDateMode(page);

  let swiped = 0;
  let liked = 0;
  let stopReason = "session_end";

  while (swiped < sessionMaxSwipes && Date.now() < sessionEnd) {
    await scanForHalts(page);
    await microFidget(page);

    const profile = await readVisibleCard(page);
    if (!profile.name && !profile.age) {
      await sleep(jitter(800, 1600));
      continue;
    }

    const inFilter = passesFilter(profile, filter);
    // CODEX-R1-P0-2: enforce right_swipe_ratio_max. If liking this profile would
    // push the session ratio above the cap, force pass even if she's in filter.
    // Prevents the "20 in-filter cards in a row -> 20 likes" Bumble-bot signature.
    const wouldBeRatio = swiped > 0 ? (liked + (inFilter ? 1 : 0)) / (swiped + 1) : (inFilter ? 1 : 0);
    const wantLike = inFilter && wouldBeRatio <= ratioCap;

    if (Math.random() < 0.18) await idlePause({ min: 1800, max: 5500 });
    else await idlePause({ min: 1100, max: 3100 });

    const buttonSel = wantLike ? sels.like_button : sels.pass_button;
    const candidates = [buttonSel.selector, ...(buttonSel.alt || [])].filter(Boolean);
    let clicked = false;
    for (const sel of candidates) {
      try {
        const el = await page.$(sel);
        if (el) { await humanClick(cursor, page, sel); clicked = true; break; }
      } catch { /* continue */ }
    }
    if (!clicked) {
      stopReason = "button_not_found";
      break;
    }

    // CODEX-R1-P1-3: only increment counter AFTER successful click. A selector
    // miss should not consume daily quota.
    let counters;
    try {
      counters = await checkAndIncrement("swipe");
    } catch (e) {
      stopReason = e.message;
      break;
    }

    await logSwipe({
      decision: wantLike ? "like" : "pass",
      filter_pass: inFilter,
      ratio_after: wouldBeRatio,
      profile,
      day_count: counters.dayUsed,
    });
    swiped += 1;
    if (wantLike) liked += 1;

    await sleep(jitter(...caps.swipes.between_swipes_ms));
  }

  return { swiped, liked, stopReason, ratio: swiped > 0 ? liked / swiped : 0 };
}
