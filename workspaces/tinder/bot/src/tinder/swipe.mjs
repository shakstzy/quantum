import { readFile } from "node:fs/promises";
import { FILTER_FILE } from "../runtime/paths.mjs";
import { selectors } from "../runtime/detection.mjs";
import { humanClick, makeCursor, idlePause, microFidget, sleep, jitter } from "../runtime/humanize.mjs";
import { gotoRecs, readVisibleProfile } from "./page.mjs";
import { logSwipe } from "../runtime/logger.mjs";
import { checkAndIncrement, loadCaps } from "../runtime/caps.mjs";
import { scanForHalts } from "../runtime/detection.mjs";

let _filter = null;
async function loadFilter() {
  if (_filter) return _filter;
  _filter = JSON.parse(await readFile(FILTER_FILE, "utf8"));
  return _filter;
}

function passesFilter(profile, f) {
  if (profile.age == null) return false;
  if (profile.age < f.age_min || profile.age > f.age_max) return false;
  if (profile.distance_mi != null && profile.distance_mi > f.max_distance_mi) return false;
  if (f.auto_pass_if_no_bio_and_no_prompts && !profile.bio) return false;
  return true;
}

export async function swipeSession(page, { sessionMinutesMax = null } = {}) {
  const caps = await loadCaps();
  const filter = await loadFilter();
  const cursor = await makeCursor(page);
  const sels = await selectors();

  // wall-clock guard: estimate from per-session swipe count * average gap, plus 50% headroom for idle pauses
  const avgGap = (caps.swipes.between_swipes_ms[0] + caps.swipes.between_swipes_ms[1]) / 2;
  const estMs = caps.swipes.per_session_max * avgGap * 1.5;
  const sessionMs = sessionMinutesMax ? sessionMinutesMax * 60 * 1000 : estMs;
  const sessionEnd = Date.now() + sessionMs;
  const sessionMaxSwipes = jitter(caps.swipes.per_session_min, caps.swipes.per_session_max + 1);

  await gotoRecs(page);

  let swiped = 0;
  let liked = 0;
  let stopReason = "session_end";

  while (swiped < sessionMaxSwipes && Date.now() < sessionEnd) {
    await scanForHalts(page);
    await microFidget(page);

    const profile = await readVisibleProfile(page);
    if (!profile.name && !profile.age) {
      await sleep(jitter(800, 1600));
      continue;
    }

    const inFilter = passesFilter(profile, filter);
    const liveRatio = swiped > 0 ? liked / swiped : 0;
    const wantLike = inFilter && (liveRatio < filter.right_swipe_ratio_cap);

    let counters;
    try {
      counters = await checkAndIncrement("swipe");
    } catch (e) {
      stopReason = e.message;
      break;
    }

    if (Math.random() < 0.18) await idlePause({ min: 1800, max: 5500 });
    else await idlePause({ min: 800, max: 2400 });

    const buttonSel = wantLike ? sels.like_button : sels.nope_button;
    const candidates = [buttonSel.selector, ...(buttonSel.alt || [])];
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

    await logSwipe({
      decision: wantLike ? "like" : "pass",
      filter_pass: inFilter,
      profile,
      day_count: counters.dayUsed,
      live_ratio: liveRatio,
    });
    swiped += 1;
    if (wantLike) liked += 1;

    await sleep(jitter(...caps.swipes.between_swipes_ms));
  }

  return { swiped, liked, stopReason };
}
