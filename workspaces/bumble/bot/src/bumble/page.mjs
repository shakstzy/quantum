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
// The sidebar is lazy-rendered; if the row isn't visible we scroll the sidebar
// progressively until it appears or we exhaust the list. Without this scroll,
// any contact past ~15 in the list wouldn't be findable (audit 2026-05-03).
export async function openThread(page, matchId) {
  if (!matchId) throw new Error("openThread: matchId required");
  await gotoMatches(page);

  async function attemptClick() {
    return await page.evaluate((uid) => {
      const sel = `[data-qa-role='contact'][data-qa-uid="${CSS.escape(uid)}"]`;
      const row = document.querySelector(sel);
      if (!row) return false;
      row.scrollIntoView({ block: "center", behavior: "instant" });
      row.click();
      return true;
    }, matchId);
  }

  if (await attemptClick()) {
    await sleep(jitter(2400, 4000));
    return;
  }

  // Not yet in DOM. Scroll the sidebar to load more rows; retry up to 30 passes
  // (up to ~300 rows; matches the scrapeMatches scroll cap).
  for (let pass = 0; pass < 30; pass++) {
    const grew = await page.evaluate(() => {
      const before = document.querySelectorAll("[data-qa-role='contact']").length;
      const scroller = document.querySelector(
        "[data-qa-role='conversations-tab-section-content'], [data-qa-role='conversations-tab-section'], .sidebar__contact-list"
      );
      if (scroller && scroller.scrollHeight > scroller.clientHeight) {
        scroller.scrollTop = scroller.scrollHeight;
      } else {
        const all = document.querySelectorAll("[data-qa-role='contact']");
        if (all.length) all[all.length - 1].scrollIntoView({ block: "end", behavior: "instant" });
      }
      return { before };
    });
    await sleep(jitter(700, 1300));
    if (await attemptClick()) {
      await sleep(jitter(2400, 4000));
      return;
    }
    const after = await page.$$eval("[data-qa-role='contact']", els => els.length);
    if (after === grew.before) break; // sidebar exhausted; row genuinely missing
  }

  throw new Error(`thread_not_found: contact with data-qa-uid='${matchId.slice(0, 24)}...' not in sidebar`);
}

// Read the active rec card with the full profile shape.
// Bumble exposes dedicated selectors on encounters-user (verified live 2026-05-02):
//   .encounters-story-profile__name      (first name)
//   .encounters-story-profile__age       (age digits)
//   .encounters-story-profile__occupation(job/company text)
//   .encounters-story-profile__education (school + grad year)
//   .encounters-story-about__badge       (ordered lifestyle pills)
//   .encounters-story-section--about     (about heading + body text)
//   .encounters-story-section--question  (prompt heading + answer text)
//   .encounters-story-section--location  (~X miles away)
//   .location-widget__pill               (Lives in / From)
//   .media-box__picture-image            (photo carousel images)
//   .encounters-story-profile__verification (photo-verified flag)
export async function readVisibleCard(page) {
  const sels = await selectors();
  if (!discovered(sels.rec_card)) {
    return { name: null, age: null, distance_mi: null, bio: null };
  }
  return await page.evaluate((cardSel) => {
    const empty = {
      name: null, age: null, distance_mi: null, bio: null,
      work: null, school: null, height: null, height_cm: null,
      photo_verified: false, prompts: [], interests: [],
      lifestyle_badges: [], lives_in: null, hometown: null,
      photos: [], photos_count: 0,
    };
    const root = document.querySelector(cardSel);
    if (!root) return empty;
    const out = { ...empty };

    const txt = (el) => (el?.textContent || "").trim() || null;

    // Name + age from dedicated selectors (no more textContent regex parsing).
    out.name = txt(root.querySelector(".encounters-story-profile__name"));
    const ageStr = txt(root.querySelector(".encounters-story-profile__age"));
    if (ageStr) {
      const n = parseInt(ageStr, 10);
      if (!Number.isNaN(n)) out.age = n;
    }

    // Photo verified flag.
    out.photo_verified = !!root.querySelector(".encounters-story-profile__verification, .verification-badge");

    // Job + school.
    out.work = txt(root.querySelector(".encounters-story-profile__occupation"));
    out.school = txt(root.querySelector(".encounters-story-profile__education"));

    // Lifestyle badges (ordered array). Each pill contains height, gender,
    // drinking, smoking, religion, etc. The drafter uses these directly.
    const badgeSeen = new Set();
    const titleEls = root.querySelectorAll(".encounters-story-about__badge .pill__title");
    if (titleEls.length) {
      for (const el of titleEls) {
        const t = txt(el);
        if (t && !badgeSeen.has(t)) { out.lifestyle_badges.push(t); badgeSeen.add(t); }
      }
    } else {
      for (const el of root.querySelectorAll(".encounters-story-about__badge")) {
        const t = txt(el);
        if (t && !badgeSeen.has(t)) { out.lifestyle_badges.push(t); badgeSeen.add(t); }
      }
    }
    // Extract height (X'Y'' format) from badges.
    for (const b of out.lifestyle_badges) {
      const m = b.match(/^(\d+)'\s*(\d+)''/);
      if (m) {
        out.height = b;
        const totalIn = parseInt(m[1], 10) * 12 + parseInt(m[2], 10);
        out.height_cm = Math.round(totalIn * 2.54);
        break;
      }
    }

    // About body text (strip the badges container so we get just the prose).
    const aboutSec = root.querySelector(".encounters-story-section--about");
    if (aboutSec) {
      const content = aboutSec.querySelector(".encounters-story-section__content") || aboutSec;
      const clone = content.cloneNode(true);
      for (const b of clone.querySelectorAll(".encounters-story-about__badges, .encounters-story-about__badge")) b.remove();
      const body = (clone.textContent || "").replace(/\s+/g, " ").trim();
      if (body) out.bio = body;
    }

    // Question prompts: ordered array of {q, a}.
    for (const q of root.querySelectorAll(".encounters-story-section--question")) {
      const heading = txt(q.querySelector("h2")) || txt(q.querySelector(".encounters-story-section__heading-title"));
      const ansEl = q.querySelector(".encounters-story-about__text");
      let answer = txt(ansEl);
      if (!answer) {
        const content = q.querySelector(".encounters-story-section__content");
        if (content && heading) {
          const t = (content.textContent || "").replace(/\s+/g, " ").trim();
          // Strip the heading off the front if it's concatenated.
          answer = heading && t.startsWith(heading) ? t.slice(heading.length).trim() : t;
        }
      }
      if (heading && answer) out.prompts.push({ q: heading, a: answer });
    }

    // Location: lives_in / hometown from .location-widget__pill (the leading
    // emoji flag is unicode noise; strip non-letters from the front).
    for (const pill of root.querySelectorAll(".location-widget__pill, .encounters-story-section--location .pill")) {
      let t = txt(pill);
      if (!t) continue;
      const stripFlag = (s) => s.replace(/^[^A-Za-z]+/, "").trim();
      if (/lives in/i.test(t)) out.lives_in = stripFlag(t.replace(/lives in\s*/i, ""));
      else if (/from/i.test(t)) out.hometown = stripFlag(t.replace(/from\s*/i, ""));
    }

    // Distance.
    const rootText = (root.textContent || "").replace(/\s+/g, " ").trim();
    const distM = rootText.match(/(\d+)\s*miles?\s*away/i);
    if (distM) out.distance_mi = parseInt(distM[1], 10);

    // Photos (only the real carousel; skip pill/badge icons).
    const photoSeen = new Set();
    for (const img of root.querySelectorAll("img.media-box__picture-image")) {
      let src = img.getAttribute("src") || img.src || "";
      if (!src) continue;
      if (src.startsWith("//")) src = "https:" + src;
      if (!src.includes("bumbcdn.com")) continue;
      // Strip the size= and ck= params to get a normalized URL for dedup.
      const norm = src.split("&size=")[0].split("&ck=")[0];
      if (photoSeen.has(norm)) continue;
      photoSeen.add(norm);
      out.photos.push(src);
    }
    out.photos_count = out.photos.length;

    return out;
  }, sels.rec_card.selector);
}

// Read the right-side profile pane on the connections (thread) view.
// The thread pane uses the `.profile__*` class convention (different from the
// `.encounters-story-*` one used on the swipe surface), but the profile shape
// is identical: name, age, job, school, badges, prompts, location, photos.
// Live-verified 2026-05-02 against Neha's pane.
export async function readThreadProfile(page) {
  const sels = await selectors();
  return await page.evaluate((paneSel) => {
    const empty = {
      name: null, age: null, distance_mi: null, bio: null,
      work: null, school: null, height: null, height_cm: null,
      photo_verified: false, prompts: [], interests: [],
      lifestyle_badges: [], lives_in: null, hometown: null,
      photos: [], photos_count: 0,
    };
    const root = document.querySelector(paneSel);
    if (!root) return empty;
    const out = { ...empty };

    const txt = (el) => (el?.textContent || "").trim() || null;

    // Name + age via dedicated selectors. profile__age is rendered as ", 22"
    // (with leading comma+space) — strip non-digits.
    out.name = txt(root.querySelector(".profile__name"));
    const ageStr = txt(root.querySelector(".profile__age")) || "";
    const ageMatch = ageStr.match(/(\d+)/);
    if (ageMatch) out.age = parseInt(ageMatch[1], 10);

    out.work = txt(root.querySelector(".profile__business--job"));
    out.school = txt(root.querySelector(".profile__business--education"));
    out.photo_verified = !!root.querySelector(".profile__verify *, .verification-badge")
                       || /\bPhotoverified\b|\bPhoto verified\b/i.test(txt(root) || "");

    // Lifestyle badges (ordered).
    const badgeSeen = new Set();
    for (const el of root.querySelectorAll(".profile__badge")) {
      const t = txt(el);
      if (t && !badgeSeen.has(t)) { out.lifestyle_badges.push(t); badgeSeen.add(t); }
    }
    for (const b of out.lifestyle_badges) {
      const m = b.match(/^(\d+)'\s*(\d+)''/);
      if (m) {
        out.height = b;
        const totalIn = parseInt(m[1], 10) * 12 + parseInt(m[2], 10);
        out.height_cm = Math.round(totalIn * 2.54);
        break;
      }
    }

    // About body: the .profile__section--answer subsections include the about
    // text + per-prompt answers. The about section's title is "About <Name>".
    // We extract the prose-only About body, then capture question prompts.
    for (const ans of root.querySelectorAll(".profile-answer")) {
      const heading = txt(ans.querySelector(".profile-answer__title"));
      const answer = txt(ans.querySelector(".profile-answer__text"));
      if (!heading || !answer) continue;
      if (/^about\b/i.test(heading)) {
        if (!out.bio) out.bio = answer;
      } else {
        out.prompts.push({ q: heading, a: answer });
      }
    }

    // Location pills.
    for (const pill of root.querySelectorAll(".location-widget__pill")) {
      const t = txt(pill);
      if (!t) continue;
      const stripFlag = (s) => s.replace(/^[^A-Za-z]+/, "").trim();
      if (/lives in/i.test(t)) out.lives_in = stripFlag(t.replace(/lives in\s*/i, ""));
      else if (/from/i.test(t)) out.hometown = stripFlag(t.replace(/from\s*/i, ""));
    }

    const rootText = (root.textContent || "").replace(/\s+/g, " ").trim();
    const distM = rootText.match(/(\d+)\s*miles?\s*away/i);
    if (distM) out.distance_mi = parseInt(distM[1], 10);

    // Photos in the thread pane carousel.
    const photoSeen = new Set();
    for (const img of root.querySelectorAll("img.media-box__picture-image, img[class*='profile__photo']")) {
      let src = img.getAttribute("src") || img.src || "";
      if (!src) continue;
      if (src.startsWith("//")) src = "https:" + src;
      if (!src.includes("bumbcdn.com")) continue;
      const norm = src.split("&size=")[0].split("&ck=")[0];
      if (photoSeen.has(norm)) continue;
      photoSeen.add(norm);
      out.photos.push(src);
    }
    out.photos_count = out.photos.length;

    return out;
  }, sels.thread_profile_pane?.selector || ".page__profile");
}
