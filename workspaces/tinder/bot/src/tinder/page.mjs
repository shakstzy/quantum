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
      // Essentials section (verified from screenshots 2026-05-01):
      height_cm: null, photo_verified: false,
      lives_in: null, pronouns: null, sexuality: null,
      jobs: [], schools: [],
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

    // GEMINI-CRIT-R2-1: walk up only as far as the next-H2 boundary. The section
    // container is the highest ancestor whose subtree contains ONLY this H2 (no
    // other H2 siblings within). Edge case: if H2 is direct child of pane, we
    // never enter the loop body to update `last`, so cap `last` to h2 itself
    // rather than ever returning the pane root (which would capture everything).
    const h2List = [...pane.querySelectorAll("h2")];
    function sectionContainerFor(h2) {
      let cur = h2;
      let last = (h2.parentElement && h2.parentElement !== pane) ? h2.parentElement : h2;
      while (cur.parentElement) {
        const parent = cur.parentElement;
        if (parent === pane) break;
        const otherH2s = [...parent.querySelectorAll("h2")].filter(o => o !== h2);
        if (otherH2s.length > 0) return last;
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

    // Looking for: a section of pills (e.g. "Long-term, open to short" + "Monogamy").
    // Walk leaves and join with " · " so multi-pill values stay readable instead of
    // concatenating to "Long-term, open to shortMonogamy".
    const lookingFor = findH2("Looking for");
    if (lookingFor) {
      const container = sectionContainerFor(lookingFor);
      if (container) {
        const headingText = (lookingFor.textContent || "").trim();
        const EMOJI_RE = /[\u{1F300}-\u{1FAFF}☀-➿\u{2700}-\u{27BF}]/u;
        const pills = [];
        const seen = new Set();
        for (const el of container.querySelectorAll("span, div, li, button, p")) {
          if (el.children.length > 0) continue; // leaf nodes only
          let t = (el.textContent || "").trim();
          if (!t || t === headingText) continue;
          // Strip leading emoji (Tinder prefixes the first pill with one)
          t = t.replace(/^[\u{1F300}-\u{1FAFF}☀-➿\u{2700}-\u{27BF}]+\s*/u, "").trim();
          // Skip pure-emoji or pure-whitespace lines
          if (!t || (EMOJI_RE.test(t) && t.replace(EMOJI_RE, "").trim() === "")) continue;
          if (t.length > 80) continue;
          if (!seen.has(t)) { seen.add(t); pills.push(t); }
        }
        out.looking_for = pills.length ? pills.join(" · ") : null;
      }
    }

    // Bio. Tinder uses two shapes:
    //   (1) classic "About me" H2 + free-text body
    //   (2) "Prompts" — the H2 IS the question (e.g. "Me: I'm a grown up. Also me:")
    //       and the section body is the answer.
    // Strategy: prefer "About me" if present; otherwise capture every non-structural
    // H2 as a prompt + answer pair, joined with " / ".
    const STRUCTURAL_H2 = new Set([
      "looking for", "essentials", "basics", "lifestyle", "interests",
      "my dream job is…", "my dream job is...", "about me",
    ]);
    const aboutMe = findH2("About me");
    if (aboutMe) {
      const v = sectionContentText(aboutMe);
      const cleaned = v ? v.replace(/^(Photo Verified|Verified|Selected|Boost)\s*/i, "").trim() : null;
      out.bio = cleaned || null;
    } else {
      const prompts = [];
      for (const h2 of h2List) {
        const label = (h2.textContent || "").trim();
        if (!label) continue;
        if (STRUCTURAL_H2.has(label.toLowerCase())) continue;
        const body = sectionContentText(h2);
        if (!body) continue;
        prompts.push(`${label} ${body}`.trim());
      }
      if (prompts.length) out.bio = prompts.join(" / ");
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

    // Essentials line-by-line: walk leaves, pattern-match each line. Tinder
    // renders Essentials as flex rows (icon + text). The text is the leaf node.
    // Regex anchors are strict so "Lives in Austin" doesn't get matched as job.
    if (essentials) {
      const container = sectionContainerFor(essentials);
      if (container) {
        const PRONOUN_RE = /^(She\/Her|He\/Him|They\/Them|She\/They|He\/They|They\/She|They\/He|Other)$/;
        const SEXUALITY_RE = /^(Straight|Gay|Lesbian|Bisexual|Bi|Pansexual|Asexual|Demisexual|Demi|Queer|Questioning|Other)$/;
        const SCHOOL_RE = /\b(University|College|School|Institute|Academy)\b/i;
        const HEIGHT_RE = /^\s*(\d{2,3})\s*cm\s*$/i;
        const DIST_RE = /^\s*\d+\s*miles?\s*away\s*$/i;
        const headingText = (essentials.textContent || "").trim();
        const lines = [];
        const seen = new Set();
        for (const el of container.querySelectorAll("span, div, li, p, button")) {
          if (el.children.length > 0) continue;
          const t = (el.textContent || "").trim();
          if (!t || t === headingText || t.length > 200) continue;
          if (!seen.has(t)) { seen.add(t); lines.push(t); }
        }
        // photo_verified: badge appears as its own line
        out.photo_verified = lines.includes("Photo Verified");
        // height
        for (const t of lines) {
          const m = t.match(HEIGHT_RE);
          if (m) { out.height_cm = parseInt(m[1], 10); break; }
        }
        // lives_in
        for (const t of lines) {
          const m = t.match(/^Lives in (.+)$/);
          if (m) { out.lives_in = m[1].trim(); break; }
        }
        // pronouns
        for (const t of lines) { if (PRONOUN_RE.test(t)) { out.pronouns = t; break; } }
        // sexuality (the bare label, not "Looking for sexuality")
        for (const t of lines) { if (SEXUALITY_RE.test(t)) { out.sexuality = t; break; } }
        // schools (could be multiple)
        const schools = [...new Set(lines.filter(t => SCHOOL_RE.test(t)))];
        if (schools.length) out.schools = schools;
        // jobs: the remaining lines that aren't already classified.
        const used = new Set([
          ...(out.photo_verified ? ["Photo Verified"] : []),
          ...lines.filter(t => HEIGHT_RE.test(t) || DIST_RE.test(t)),
          ...lines.filter(t => /^Lives in /.test(t)),
          ...lines.filter(t => PRONOUN_RE.test(t) || SEXUALITY_RE.test(t)),
          ...schools,
        ]);
        const jobs = lines.filter(t => !used.has(t) && t.length <= 80 && t !== "Essentials");
        if (jobs.length) out.jobs = jobs;
      }
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
