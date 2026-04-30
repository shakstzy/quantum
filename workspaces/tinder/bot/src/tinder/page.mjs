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
  // Wait for the like button to be present (up to 12s) since React hydration + rec-fetch can be slow.
  try {
    await page.waitForSelector("button.gamepad-button[class*='sparks-like']", { timeout: 12000 });
  } catch { /* health check downstream will halt loudly */ }
  // Then wait for at least one rec card photo to actually exist before proceeding.
  try {
    await page.waitForSelector("[class*='recCard__img'][role='img'][aria-label]", { timeout: 8000 });
  } catch { /* swipe loop will keep polling */ }
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
  // Card-stack DOM: [class*='recCard__img'] is the wrapper, [role='img'][aria-label]
  // is a child div with the displayed name. Topmost (active) card is the first in DOM order.
  let name = null;
  try {
    const card = await page.$("[class*='recCard__img'] [role='img'][aria-label]");
    if (card) name = await card.getAttribute("aria-label");
  } catch { /* skip */ }
  return { name, age: null, distance_mi: null, bio: null };
}

// Reads the profile pane from the open thread page using DOM-level section
// walking (not text-slicing). Robust to bios/dream-jobs that contain literal
// section headings like "Basics is overrated".
//
// Pane structure (verified 2026-04-30):
//   profileContent
//     ├─ H1 "<Name><age>"   (concatenated)
//     ├─ section{ H2 "Looking for" }   followed by sibling div with "<emoji><value>"
//     ├─ section{ H2 "About me" }      followed by sibling div with bio text
//     ├─ section{ H2 "Essentials" }    contains "Photo Verified" + "<n> miles away"
//     ├─ section{ H2 "My dream job is…" } followed by sibling div with text
//     ├─ section{ H2 "Basics" }        H3 children + value siblings
//     ├─ section{ H2 "Lifestyle" }     H3 children + value siblings
//     └─ section{ H2 "Interests" }     pill list
export async function readThreadProfile(page) {
  try { await page.waitForSelector("[class*='profileContent']", { timeout: 6000 }); }
  catch { /* fall through; evaluate returns empty profile */ }

  return await page.evaluate(() => {
    const empty = {
      name: null, age: null, distance_mi: null,
      bio: null, looking_for: null, dream_job: null,
      basics: {}, lifestyle: {}, interests: [],
      photos_count: 0,
    };
    // CODEX-CRIT-2: scope to the most-visible profileContent (skips stale/hidden
    // panes). On desktop there's only one rendered, but be defensive.
    const allPanes = [...document.querySelectorAll("[class*='profileContent']")];
    const pane = allPanes.find(p => p.offsetParent !== null) || allPanes[0];
    if (!pane) return empty;
    const out = { ...empty };

    // Name + age from H1. Handles "Zoe25" (concatenated) and "Zoe, 25" (comma).
    // GEMINI-BUG-R2-3: allow optional ", " between name and age.
    const h1 = pane.querySelector("h1");
    if (h1) {
      const t = (h1.textContent || "").trim();
      const m = t.match(/^(\p{L}[\p{L}\s'\-]*?)\s*,?\s*(\d{2,3})$/u);
      if (m) { out.name = m[1].trim(); out.age = parseInt(m[2], 10); }
      else out.name = t || null;
    }

    // Photos count
    out.photos_count = pane.querySelectorAll("img[src*='gotinder.com']").length;

    // GEMINI-CRIT-R2-1: walk up only as far as the next-H2 boundary. Old approach
    // (walk until text > heading+2) overshot for short content (e.g. bio="Hi"),
    // climbing all the way to the pane root and capturing every section's text.
    // New approach: the section container is the highest ancestor that does NOT
    // contain ANY OTHER H2. This gives us the H2's exclusive subtree.
    const h2List = [...pane.querySelectorAll("h2")];
    function sectionContainerFor(h2) {
      let cur = h2;
      let last = h2.parentElement;
      while (cur.parentElement) {
        const parent = cur.parentElement;
        if (parent === pane) break;
        const otherH2s = [...parent.querySelectorAll("h2")].filter(o => o !== h2);
        if (otherH2s.length > 0) {
          // parent contains another section's heading — stop, return previous
          return last;
        }
        last = parent;
        cur = parent;
      }
      return last;
    }
    function sectionContentText(h2) {
      const container = sectionContainerFor(h2);
      if (!container) return null;
      const clone = container.cloneNode(true);
      const headings = clone.querySelectorAll("h2, h3");
      for (const h of headings) h.remove();
      return (clone.textContent || "").trim().replace(/\s+/g, " ") || null;
    }
    function distanceFromSection(h2) {
      const container = sectionContainerFor(h2);
      if (!container) return null;
      const m = (container.textContent || "").match(/(\d+)\s*(?:miles?|mi)\s*away/i);
      return m ? parseInt(m[1], 10) : null;
    }
    function findH2(label) {
      const norm = label.toLowerCase();
      return h2List.find(h => (h.textContent || "").trim().toLowerCase() === norm) || null;
    }

    // Looking for: typically prefixed with an emoji
    const lookingFor = findH2("Looking for");
    if (lookingFor) {
      let v = sectionContentText(lookingFor);
      if (v) v = v.replace(/^[\u{1F300}-\u{1FAFF}☀-➿\u{2700}-\u{27BF}]+\s*/u, "").trim();
      out.looking_for = v || null;
    }

    // About me (bio)
    const aboutMe = findH2("About me");
    if (aboutMe) {
      const v = sectionContentText(aboutMe);
      // CODEX-IMP-18: strip badge prefixes if Tinder includes them at the start.
      // Use specific known badges only — never strip generic words.
      const cleaned = v ? v.replace(/^(Photo Verified|Verified|Selected|Boost)\s*/i, "").trim() : null;
      out.bio = cleaned || null;
    }

    // Dream job (Essentials sub-question)
    const dreamJob = findH2("My dream job is…");
    if (dreamJob) {
      out.dream_job = sectionContentText(dreamJob);
    }

    // Distance lives inside Essentials section
    const essentials = findH2("Essentials");
    if (essentials) out.distance_mi = distanceFromSection(essentials);
    if (out.distance_mi == null) {
      // Fallback: anywhere in pane
      const m = (pane.textContent || "").match(/(\d+)\s*(?:miles?|mi)\s*away/i);
      if (m) out.distance_mi = parseInt(m[1], 10);
    }

    // Basics + Lifestyle: H3 (heading, value) pairs scoped to their H2 section.
    // GEMINI-IMP-R2-9: position-based slice (heading is always FIRST). Old approach
    // (`parentText.replace(heading, "")`) mangled values that contained the heading
    // string as a substring (e.g. heading "Job", value "Job at Apple" -> " at Apple").
    function extractH3Pairs(h2) {
      const container = sectionContainerFor(h2);
      if (!container) return {};
      const out = {};
      for (const h3 of container.querySelectorAll("h3")) {
        const heading = (h3.textContent || "").trim();
        if (!heading) continue;
        const parent = h3.parentElement;
        const parentText = (parent?.textContent || "").trim();
        // Heading appears first in the rendered parent; slice after it.
        let value = parentText.startsWith(heading)
          ? parentText.slice(heading.length).trim()
          : parentText.replace(heading, "").trim(); // fallback for unusual layouts
        if (value) out[heading] = value;
      }
      return out;
    }
    const basics = findH2("Basics");
    if (basics) out.basics = extractH3Pairs(basics);
    const lifestyle = findH2("Lifestyle");
    if (lifestyle) out.lifestyle = extractH3Pairs(lifestyle);

    // Interests: walk the section container, find leaf-text descendants
    const interestsH2 = findH2("Interests");
    if (interestsH2) {
      const container = sectionContainerFor(interestsH2);
      if (container) {
        const headingText = (interestsH2.textContent || "").trim();
        const leaves = [...container.querySelectorAll("span, div, li")]
          .filter(el => el.children.length === 0)
          .map(el => (el.textContent || "").trim())
          .filter(t => t && t.length <= 40 && t !== headingText)
          .filter(t => !/^[\d\s]*$/.test(t));
        const seen = new Set();
        for (const t of leaves) { if (!seen.has(t)) { seen.add(t); out.interests.push(t); } }
      }
    }

    return out;
  });
}
