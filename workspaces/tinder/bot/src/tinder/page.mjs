import { selectors } from "../runtime/detection.mjs";
import { humanClick, makeCursor, idlePause, sleep, jitter } from "../runtime/humanize.mjs";

async function pickFirst(page, sel) {
  const candidates = [sel.selector, ...(sel.alt || [])];
  for (const s of candidates) {
    const el = await page.$(s);
    if (el) return s;
  }
  return null;
}

export async function gotoRecs(page) {
  if (!page.url().includes("/app/recs")) {
    await page.goto("https://tinder.com/app/recs", { waitUntil: "domcontentloaded" });
  }
  await sleep(jitter(1200, 2400));
}

export async function gotoMatches(page) {
  const sels = await selectors();
  const cursor = await makeCursor(page);
  const tab = await pickFirst(page, sels.matches_tab);
  if (tab) {
    await humanClick(cursor, page, tab);
  } else {
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
  }
  await sleep(jitter(1500, 3000));
}

export async function openThread(page, matchId) {
  await page.goto(`https://tinder.com/app/messages/${matchId}`, { waitUntil: "domcontentloaded" });
  await sleep(jitter(1200, 2400));
}

export async function readVisibleProfile(page) {
  const sels = await selectors();
  const get = async (key) => {
    const sel = sels[key];
    const s = await pickFirst(page, sel);
    if (!s) return null;
    try { return (await page.textContent(s))?.trim() || null; } catch { return null; }
  };
  const name = await get("rec_card_name");
  const ageText = await get("rec_card_age");
  const distanceText = await get("rec_card_distance");
  const bio = await get("rec_card_bio");
  const age = ageText ? parseInt(ageText.replace(/\D/g, ""), 10) : null;
  const distance_mi = distanceText ? parseInt(distanceText.replace(/\D/g, ""), 10) : null;
  return { name, age, distance_mi, bio };
}
