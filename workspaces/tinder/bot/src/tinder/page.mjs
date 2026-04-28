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
  await sleep(jitter(2400, 4200));
  // Dismiss any onboarding / "see who likes you" / promo modal that covers the gamepad
  try { await page.keyboard.press("Escape"); await sleep(jitter(300, 700)); } catch {}
  try { await page.keyboard.press("Escape"); await sleep(jitter(300, 700)); } catch {}
  // Wait for the like button to actually be present (up to 12s), since React hydration
  // and rec-fetch can be slow.
  try {
    await page.waitForSelector("button.gamepad-button[class*='sparks-like']", { timeout: 12000 });
  } catch { /* health check downstream will halt loudly */ }
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
  // Card-stack DOM exposes only the visible card's name (via aria-label on its photo
  // container). Age / distance / bio render only after card expansion, which we skip
  // in v1 — account-level Tinder filter already enforces 19-26 + <=70mi.
  let name = null;
  try {
    const card = await page.$("[class*='recCard__img'][role='img'][aria-label]");
    if (card) name = await card.getAttribute("aria-label");
  } catch { /* skip */ }
  return { name, age: null, distance_mi: null, bio: null };
}
