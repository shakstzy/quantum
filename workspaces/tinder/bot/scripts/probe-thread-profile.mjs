#!/usr/bin/env node
// Live probe of thread profile pane structure. One hit per drift.
// Opens a thread, then uses page.evaluate to traverse the profile DOM and emit
// a structured report with class names + text + tag for each profile section.
// Output: bot/.dev-fixtures/thread-dom/<matchId>-probe.json

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { launchPersistent } from "../src/runtime/profile.mjs";

const matchId = process.argv[2];
if (!matchId) { console.error("usage: probe-thread-profile.mjs <matchId>"); process.exit(2); }

const FIXTURE_DIR = resolve(process.cwd(), "bot/.dev-fixtures/thread-dom");
await mkdir(FIXTURE_DIR, { recursive: true });

const { ctx, page } = await launchPersistent({ headless: false });
try {
  await page.goto(`https://tinder.com/app/messages/${matchId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  const probe = await page.evaluate(() => {
    const out = {};

    // The profile pane lives in a container with H1 holding "<Name><age>"
    // Find all H1 candidates and pick the one with name+age pattern (matches /^\w+\d+/)
    const h1s = [...document.querySelectorAll("h1")];
    let nameAgeEl = null;
    for (const h of h1s) {
      const t = (h.textContent || "").trim();
      if (/^[A-Z][a-zA-Z]+\d{2,3}$/.test(t)) { nameAgeEl = h; break; }
    }
    out.name_age = nameAgeEl ? {
      text: nameAgeEl.textContent.trim(),
      class: nameAgeEl.className?.toString?.() || "",
      tag: nameAgeEl.tagName,
      parent_class: nameAgeEl.parentElement?.className?.toString?.() || "",
    } : null;

    // Find the profile pane container — walk up from H1 until we hit a div that
    // also contains H2 "About me" or "Looking for"
    let paneRoot = null;
    if (nameAgeEl) {
      let cur = nameAgeEl;
      for (let i = 0; i < 8 && cur; i++) {
        cur = cur.parentElement;
        if (!cur) break;
        const headings = cur.querySelectorAll("h2");
        const hasAbout = [...headings].some(h => /about me|looking for|essentials|basics|lifestyle|interests/i.test(h.textContent || ""));
        if (hasAbout) { paneRoot = cur; break; }
      }
    }
    out.pane_root = paneRoot ? {
      tag: paneRoot.tagName,
      class: paneRoot.className?.toString?.() || "",
      id: paneRoot.id,
      role: paneRoot.getAttribute("role"),
      text_excerpt: (paneRoot.textContent || "").slice(0, 400).replace(/\s+/g, " "),
    } : null;

    // Walk every H2 inside the pane and emit its parent + next-sibling structure
    out.sections = [];
    if (paneRoot) {
      const h2s = [...paneRoot.querySelectorAll("h2")];
      for (const h of h2s) {
        const heading = (h.textContent || "").trim();
        const parent = h.parentElement;
        out.sections.push({
          heading,
          parent_class: parent?.className?.toString?.().slice(0, 80) || "",
          parent_text: (parent?.textContent || "").trim().slice(0, 300).replace(/\s+/g, " "),
        });
      }

      // Also emit H3s (Lifestyle items, Basics items)
      const h3s = [...paneRoot.querySelectorAll("h3")];
      out.h3_items = h3s.map(h => {
        const heading = (h.textContent || "").trim();
        const parent = h.parentElement;
        // The value is typically the next sibling div under parent
        const value = (parent?.textContent || "").trim().replace(heading, "").trim().slice(0, 80);
        return { heading, value, parent_class: parent?.className?.toString?.().slice(0, 60) || "" };
      });
    }

    // Distance: the literal "X miles away" usually appears outside the H2 sections,
    // near the name. Search the pane.
    if (paneRoot) {
      const txt = paneRoot.textContent || "";
      const m = txt.match(/(\d+)\s*miles?\s*away/i);
      out.distance_text = m ? m[0] : null;
      out.distance_value = m ? parseInt(m[1], 10) : null;
    }

    // Bio: the section under H2 "About me" — but sometimes it's a sibling, sometimes inside parent
    if (paneRoot) {
      const aboutH2 = [...paneRoot.querySelectorAll("h2")].find(h => /about me/i.test(h.textContent || ""));
      if (aboutH2) {
        // try multiple paths
        const parent = aboutH2.parentElement;
        const next = aboutH2.nextElementSibling;
        out.about_me = {
          parent_text: (parent?.textContent || "").replace(aboutH2.textContent, "").trim().slice(0, 400),
          next_sibling_text: (next?.textContent || "").trim().slice(0, 400),
          next_sibling_class: next?.className?.toString?.() || "",
        };
      }
    }

    // Photos: count img tags inside the pane (or the whole document — pane may be deeper)
    if (paneRoot) {
      const imgs = [...paneRoot.querySelectorAll("img")];
      out.imgs_in_pane = imgs.length;
      out.img_samples = imgs.slice(0, 5).map(i => ({
        alt: (i.alt || "").slice(0, 40),
        src_host: (() => { try { return new URL(i.src).host; } catch { return ""; } })(),
      }));
    }

    // Look for job/school text near building/school icons. Tinder typically uses
    // an SVG sprite. Check for visible text following common icon descriptors.
    if (paneRoot) {
      // Look for divs with aria-label "job" or "school", or text "Works at" / "Studied at"
      const candidates = [...paneRoot.querySelectorAll("[role='listitem'], li, div")];
      out.job_school_hints = [];
      for (const el of candidates) {
        const t = (el.textContent || "").trim();
        if (t.length < 100 && /(works? at|studied? at|attended)/i.test(t)) {
          out.job_school_hints.push({ text: t.slice(0, 100), class: el.className?.toString?.().slice(0, 60) || "" });
        }
        if (out.job_school_hints.length >= 8) break;
      }
    }

    return out;
  });

  await writeFile(resolve(FIXTURE_DIR, `${matchId}-probe.json`), JSON.stringify(probe, null, 2));
  console.log(`probe written to ${FIXTURE_DIR}/${matchId}-probe.json`);
} finally {
  await ctx.close();
}
