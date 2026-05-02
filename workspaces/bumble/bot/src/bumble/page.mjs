// Bumble web SPA navigation primitives. Live-verified 2026-05-02.
//
// Important shape: bumble.com/app is a single-page app. There is NO per-thread
// URL. Encounters, conversations, and threads all live at /app (or /app/connections
// once a contact is selected). Navigation between them is INTRA-SPA via clicks,
// not URL changes. matchId comes from the contact row's `data-qa-uid` attribute.

import { selectors } from "../runtime/detection.mjs";
import { humanClick, makeCursor, sleep, jitter } from "../runtime/humanize.mjs";

const APP_URL = "https://bumble.com/app";

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

// Always lands on /app. The encounters surface is the default visible main pane;
// if a conversation is selected, the URL becomes /app/connections - in that case
// click an encounters re-entry signal or just reload /app.
export async function gotoEncounters(page) {
  const sels = await selectors();
  if (!discovered(sels.rec_card) || !discovered(sels.like_button)) {
    throw new Error("missing_selector: rec_card / like_button. Run scripts/discover-dom.mjs.");
  }
  if (!page.url().endsWith("/app") && !page.url().includes("/app?")) {
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  }
  await sleep(jitter(2400, 4200));
  try {
    await page.waitForSelector(sels.like_button.selector, { timeout: 12000 });
  } catch { /* downstream verifies + halts loudly */ }
  try {
    await page.waitForSelector(sels.rec_card.selector, { timeout: 8000 });
  } catch { /* swipe loop will keep polling */ }
}

// "Matches" surface is the same /app surface; the conversations list IS the
// match list. No actual navigation needed - just ensure we're on /app.
export async function gotoMatches(page) {
  const sels = await selectors();
  if (!discovered(sels.matches_list_item)) {
    throw new Error("missing_selector: matches_list_item. Run scripts/discover-dom.mjs.");
  }
  if (!page.url().includes("/app")) {
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  }
  await sleep(jitter(1500, 3000));
  try {
    await page.waitForSelector(sels.matches_list_item.selector, { timeout: 10000 });
  } catch { /* downstream handles */ }
}

// Open a thread by clicking the contact row whose `data-qa-uid` matches matchId.
// matchId is the opaque Bumble user identifier we stored when scraping the list.
export async function openThread(page, matchId) {
  if (!matchId) throw new Error("openThread: matchId required");
  await gotoMatches(page);
  // CODEX-R7-P1-1: matchId is opaque (Bumble user/connection id). Use CSS.escape
  // to defend against attribute values that contain ], ", \, or other special
  // chars. Single-quote escaping alone was unsafe.
  const clicked = await page.evaluate((uid) => {
    const sel = `[data-qa-role='contact'][data-qa-uid="${CSS.escape(uid)}"]`;
    const row = document.querySelector(sel);
    if (!row) return false;
    row.click();
    return true;
  }, matchId);
  if (!clicked) throw new Error(`thread_not_found: contact with data-qa-uid='${matchId.slice(0, 24)}...' not in sidebar`);
  await sleep(jitter(2400, 4000));
}

// Read the active rec card. Bumble exposes the entire profile in encounters-user
// textContent: "Name, ageWorkSchoolAbout NameHeightActivityIn collegeRarely..."
// We parse name + age, then split sections from encounters-story-section--*.
export async function readVisibleCard(page) {
  const sels = await selectors();
  if (!discovered(sels.rec_card)) {
    return { name: null, age: null, distance_mi: null, bio: null };
  }
  return await page.evaluate((cardSel) => {
    const empty = { name: null, age: null, distance_mi: null, bio: null,
                    work: null, school: null, height: null, photo_verified: false,
                    prompts: {}, interests: [] };
    const root = document.querySelector(cardSel);
    if (!root) return empty;
    const out = { ...empty };

    // Name + age from the first text chunk.
    const story = root.querySelector("[data-qa-role='encounters-story']") || root;
    const fullText = (story.textContent || "").replace(/\s+/g, " ").trim();
    const nm = fullText.match(/^([\p{L}][\p{L}\s'\-]{0,40}),\s*(\d{1,3})/u);
    if (nm) { out.name = nm[1].trim(); out.age = parseInt(nm[2], 10); }

    // Photo verified flag.
    out.photo_verified = !!root.querySelector(".encounters-story-profile__verification, .verification-badge");

    // About section text.
    const about = root.querySelector(".encounters-story-section--about");
    if (about) out.bio = (about.textContent || "").replace(/\s+/g, " ").trim();

    // Question prompts (multiple).
    const prompts = {};
    for (const q of root.querySelectorAll(".encounters-story-section--question")) {
      const qText = (q.textContent || "").replace(/\s+/g, " ").trim();
      // Question prompts on Bumble look like: "<Question>?<Answer>" concatenated.
      const m = qText.match(/^(.+?[?!.])\s*(.+)$/);
      if (m) prompts[m[1].trim()] = m[2].trim();
    }
    out.prompts = prompts;

    // Distance / location: scan for "X miles away" anywhere in the card.
    // Bumble emits the location text in a sibling section that's part of
    // encounters-user (root) but not necessarily encounters-story (fullText).
    // Fall back to root.textContent so we capture "~3 miles away" patterns too.
    const rootText = (root.textContent || "").replace(/\s+/g, " ").trim();
    const distM = rootText.match(/(\d+)\s*miles?\s*away/i);
    if (distM) out.distance_mi = parseInt(distM[1], 10);

    return out;
  }, sels.rec_card.selector);
}

// Read the right-side profile pane on the connections (thread) view.
export async function readThreadProfile(page) {
  const sels = await selectors();
  return await page.evaluate((paneSel) => {
    const empty = { name: null, age: null, work: null, school: null, height: null,
                    photo_verified: false, bio: null, distance_mi: null };
    const root = document.querySelector(paneSel);
    if (!root) return empty;
    const out = { ...empty };
    const text = (root.textContent || "").replace(/\s+/g, " ").trim();
    const nm = text.match(/^([\p{L}][\p{L}\s'\-]{0,40}),\s*(\d{1,3})/u);
    if (nm) { out.name = nm[1].trim(); out.age = parseInt(nm[2], 10); }
    const distM = text.match(/(\d+)\s*miles?\s*away/i);
    if (distM) out.distance_mi = parseInt(distM[1], 10);
    out.photo_verified = /\bPhotoverified\b|\bPhoto verified\b/i.test(text);
    return out;
  }, sels.thread_profile_pane?.selector || ".page__profile");
}
