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

// Reads the profile pane from the open thread page. The pane is rendered into
// the DOM eagerly on desktop (no click needed). Returns a structured snapshot.
// All fields default to null/empty arrays/0 — caller can diff against stored
// markdown profile to detect changes.
//
// Verified against fixture probe 2026-04-30: container=[class*='profileContent'],
// name+age concatenated in H1, distance as "<n> miles away" in body text,
// Basics/Lifestyle as H3 (heading, value) pairs, About me / Looking for / dream job
// as H2 sections with text content following.
export async function readThreadProfile(page) {
  // Wait briefly for pane to populate (thread navigation already triggered domcontentloaded)
  try { await page.waitForSelector("[class*='profileContent']", { timeout: 6000 }); }
  catch { /* fall through; evaluate will return empty profile */ }

  return await page.evaluate(() => {
    const empty = {
      name: null, age: null, distance_mi: null,
      bio: null, looking_for: null, dream_job: null,
      basics: {}, lifestyle: {}, interests: [],
      photos_count: 0,
    };
    const pane = document.querySelector("[class*='profileContent']");
    if (!pane) return empty;
    const out = { ...empty };

    // Name + age from H1 ("Zoe25" -> name="Zoe", age=25)
    const h1 = pane.querySelector("h1");
    if (h1) {
      const t = (h1.textContent || "").trim();
      const m = t.match(/^([A-Za-z][A-Za-z\s'\-]*?)(\d{2,3})$/);
      if (m) { out.name = m[1].trim(); out.age = parseInt(m[2], 10); }
      else out.name = t || null;
    }

    // Distance — appears literally as "<n> miles away" or "<n> mi away"
    const fullText = pane.textContent || "";
    const dm = fullText.match(/(\d+)\s*(?:miles?|mi)\s*away/i);
    if (dm) out.distance_mi = parseInt(dm[1], 10);

    // Photos: imgs sourced from gotinder image hosts
    out.photos_count = pane.querySelectorAll("img[src*='gotinder.com']").length;

    // H3 (heading, value) pairs — Basics + Lifestyle live here.
    // Strategy: each H3's parent contains "<heading><value>" concatenated.
    // Determine which H2 section the H3 belongs to by walking up to find the
    // nearest preceding H2 in DOM order.
    const h2s = [...pane.querySelectorAll("h2")];
    const h2Texts = h2s.map(h => (h.textContent || "").trim().toLowerCase());
    const sectionOfH3 = (h3) => {
      // walk previous siblings + ancestors looking for a preceding H2
      const all = [...pane.querySelectorAll("h1, h2, h3")];
      const idx = all.indexOf(h3);
      for (let i = idx - 1; i >= 0; i--) {
        if (all[i].tagName === "H2") return (all[i].textContent || "").trim().toLowerCase();
      }
      return null;
    };
    for (const h3 of pane.querySelectorAll("h3")) {
      const heading = (h3.textContent || "").trim();
      if (!heading) continue;
      const parent = h3.parentElement;
      const parentText = (parent?.textContent || "").trim();
      const value = parentText.replace(heading, "").trim();
      if (!value) continue;
      const section = sectionOfH3(h3);
      const bucket = section === "basics" ? out.basics : section === "lifestyle" ? out.lifestyle : null;
      if (bucket) bucket[heading] = value;
    }

    // H2-section text extractors. For "About me", "Looking for", "My dream job is…",
    // the content is a sibling block after the heading section. We slice the pane's
    // full text by the known section boundaries and extract.
    // Using indexOf on textContent — robust to className changes.
    const slicedSection = (label, nextLabels) => {
      const start = fullText.indexOf(label);
      if (start < 0) return null;
      let end = fullText.length;
      for (const next of nextLabels) {
        const i = fullText.indexOf(next, start + label.length);
        if (i >= 0 && i < end) end = i;
      }
      const raw = fullText.slice(start + label.length, end).trim();
      // Normalize whitespace
      return raw.replace(/\s+/g, " ").trim() || null;
    };
    // Order of section labels as they appear in the pane.
    // "Essentials" appears between "About me" and "My dream job is…".
    const sectionOrder = [
      "Looking for", "About me", "Essentials", "My dream job is…",
      "Basics", "Lifestyle", "Interests", "Frequently Used",
    ];
    const after = (label) => sectionOrder.slice(sectionOrder.indexOf(label) + 1);

    out.looking_for = slicedSection("Looking for", after("Looking for"));
    out.bio = slicedSection("About me", after("About me"));
    out.dream_job = slicedSection("My dream job is…", after("My dream job is…"));

    // Strip leading non-text artifacts. "Looking for" content can have a leading emoji
    // (e.g. "💘Long-term partner"). Remove single leading emoji-like char if present.
    const stripLeadingEmoji = (s) => s ? s.replace(/^[\u{1F300}-\u{1FAFF}☀-➿\u{2700}-\u{27BF}]+/u, "").trim() : s;
    out.looking_for = stripLeadingEmoji(out.looking_for);

    // Bio cleanup — "Essentials" stripped; sometimes pane includes "Photo Verified" before bio.
    if (out.bio && /^Photo Verified/i.test(out.bio)) out.bio = out.bio.replace(/^Photo Verified\s*/i, "").trim() || null;

    // Interests: between "Interests" and "Frequently Used" (or end). Comma/list separated.
    const interestsRaw = slicedSection("Interests", after("Interests"));
    if (interestsRaw) {
      // Tinder concatenates interests with no separator. Walk the DOM under Interests
      // h2's section container instead — much more reliable than text splitting.
      const intH2 = h2s.find(h => /^interests$/i.test((h.textContent || "").trim()));
      if (intH2) {
        // Find the closest ancestor that contains the interests pills
        let cur = intH2.parentElement;
        // Walk forward looking for sibling div containing many short text nodes
        let interestsContainer = null;
        for (let lvl = 0; lvl < 5 && cur; lvl++) {
          // Look at next sibling
          let sib = cur.nextElementSibling;
          while (sib) {
            if (sib.querySelectorAll("span, div").length > 2) { interestsContainer = sib; break; }
            sib = sib.nextElementSibling;
          }
          if (interestsContainer) break;
          cur = cur.parentElement;
        }
        if (interestsContainer) {
          // Each interest is a leaf element with 1-30 chars of text
          const leaves = [...interestsContainer.querySelectorAll("span, div")]
            .filter(el => el.children.length === 0)
            .map(el => (el.textContent || "").trim())
            .filter(t => t && t.length <= 40)
            .filter(t => !/^[\d\s]*$/.test(t));
          // Dedupe in order
          const seen = new Set();
          for (const t of leaves) { if (!seen.has(t)) { seen.add(t); out.interests.push(t); } }
        } else {
          // Fallback: split the raw interests text on capital letter boundaries
          // (Tinder pills concatenated like "ConcertsMindfulnessRoad Trips").
          const tokens = interestsRaw.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*(?:\s(?:TV\s?shows?))?/g) || [];
          out.interests = tokens.slice(0, 20);
        }
      }
    }

    return out;
  });
}
