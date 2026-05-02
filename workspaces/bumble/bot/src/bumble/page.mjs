// Bumble navigation primitives. URL paths in here are PLACEHOLDERS until
// scripts/discover-dom.mjs returns confirmed routes for the post-auth app.
//
// Codex flagged that all the obvious /app/encounters style URLs return 404 from
// the public origin. Either (a) post-auth they 200, (b) a different path is the
// real swipe/match surface, or (c) the web app no longer renders these views.
// `discover-dom.mjs` resolves which.
//
// Until that runs, this module's exports throw a clear pre-discovery error so
// the rest of the system fails loud.

import { selectors } from "../runtime/detection.mjs";
import { humanClick, makeCursor, sleep, jitter } from "../runtime/humanize.mjs";

class PreDiscoveryError extends Error {
  constructor(verb) {
    super(`pre-discovery: ${verb} cannot run until scripts/discover-dom.mjs has populated config/selectors.json. See workspaces/bumble/CLAUDE.md > Discovery phase.`);
  }
}

function discovered(sel) {
  if (!sel || (sel.selector == null && (!sel.alt || sel.alt.length === 0))) return false;
  return true;
}

async function pickFirst(page, sel) {
  const candidates = [sel.selector, ...(sel.alt || [])].filter(Boolean);
  for (const s of candidates) {
    const el = await page.$(s);
    if (el) return s;
  }
  return null;
}

// PLACEHOLDER URL. Replace with the real encounters route after discovery.
let ENCOUNTERS_URL = "https://bumble.com/app/encounters";
let MATCHES_URL = "https://bumble.com/app/matches";

export function setRoutes({ encounters, matches }) {
  if (encounters) ENCOUNTERS_URL = encounters;
  if (matches) MATCHES_URL = matches;
}

export async function gotoEncounters(page) {
  const sels = await selectors();
  if (!discovered(sels.rec_card) || !discovered(sels.like_button)) throw new PreDiscoveryError("gotoEncounters");
  if (!page.url().includes("encounters") && !page.url().includes("/app")) {
    await page.goto(ENCOUNTERS_URL, { waitUntil: "domcontentloaded" });
  }
  await sleep(jitter(2400, 4200));
  try {
    await page.waitForSelector(sels.like_button.selector, { timeout: 12000 });
  } catch { /* downstream verifies + halts loudly */ }
  try {
    await page.waitForSelector(sels.rec_card.selector, { timeout: 8000 });
  } catch { /* swipe loop will keep polling */ }
}

export async function gotoMatches(page) {
  const sels = await selectors();
  if (!discovered(sels.matches_tab) && !discovered(sels.matches_list_item)) throw new PreDiscoveryError("gotoMatches");
  if (discovered(sels.matches_tab)) {
    const cursor = await makeCursor(page);
    const tab = await pickFirst(page, sels.matches_tab);
    if (tab) {
      await humanClick(cursor, page, tab);
      await sleep(jitter(1500, 3000));
      return;
    }
  }
  await page.goto(MATCHES_URL, { waitUntil: "domcontentloaded" });
  await sleep(jitter(1500, 3000));
}

export async function openThread(page, matchId) {
  // Real thread URL shape unknown until discovery. discover-dom dumps it; we
  // wire it in here.
  throw new PreDiscoveryError("openThread");
}

export async function readVisibleCard(page) {
  const sels = await selectors();
  if (!discovered(sels.rec_card_name)) {
    return { name: null, age: null, distance_mi: null, bio: null };
  }
  let name = null;
  try {
    const el = await page.$(sels.rec_card_name.selector);
    if (el) name = (await el.getAttribute("aria-label")) || (await el.textContent())?.trim();
  } catch { /* skip */ }
  return { name, age: null, distance_mi: null, bio: null };
}
