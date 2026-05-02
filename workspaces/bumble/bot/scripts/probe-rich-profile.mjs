#!/usr/bin/env node
// Throwaway probe: dump the FULL DOM structure of an encounters card so we
// can wire rich profile extraction (job, school, height, lifestyle, prompts,
// interests, photo URLs, etc.). Also probes the right-side thread-profile
// pane on the connections view.

import { launchPersistent } from "../src/runtime/profile.mjs";
import { gotoEncounters, openThread } from "../src/bumble/page.mjs";
import { writeFile } from "node:fs/promises";

const TARGET_MATCH_ID = process.env.TARGET_MATCH_ID || null;

const { ctx, page } = await launchPersistent({ headless: false });
try {
  await gotoEncounters(page);
  await page.waitForTimeout(2500);

  const cardDump = await page.evaluate(() => {
    const root = document.querySelector("[data-qa-role='encounters-user']");
    if (!root) return null;

    // Walk all children, collect class names + text snippets to find selector patterns.
    const selectors = new Set();
    const walk = (el, depth = 0) => {
      if (depth > 8) return;
      const cls = el.className?.baseVal ?? el.className;
      if (typeof cls === "string" && cls.trim()) {
        for (const c of cls.split(/\s+/)) selectors.add(c);
      }
      if (el.dataset) {
        for (const k of Object.keys(el.dataset)) selectors.add(`data-${k}=${el.dataset[k]}`);
      }
      for (const child of el.children) walk(child, depth + 1);
    };
    walk(root);

    // Photos — look for img/picture inside the card.
    const imgs = [...root.querySelectorAll("img")].map(img => ({
      src: img.src,
      srcset: img.srcset,
      alt: img.alt,
      cls: img.className,
    }));

    // Pillbox / chip-like elements (lifestyle, basics, interests).
    const pills = [...root.querySelectorAll("[class*='pill'], [class*='chip'], [class*='tag'], [class*='attribute'], [class*='lifestyle'], [class*='badge']")].map(el => ({
      cls: el.className,
      text: (el.textContent || "").trim(),
    })).filter(p => p.text);

    // Sections — every encounters-story-section--*.
    const sections = [...root.querySelectorAll("[class*='encounters-story-section']")].map(el => ({
      cls: el.className,
      text: (el.textContent || "").trim().slice(0, 300),
    }));

    // Right-rail-style dl/dt or specific data list.
    const dlText = [...root.querySelectorAll("dl, .basic-info, [class*='profile-section'], [class*='bumble-info']")].map(el => ({
      cls: el.className,
      tag: el.tagName,
      text: (el.textContent || "").trim().slice(0, 400),
    }));

    return {
      classes: [...selectors].slice(0, 200),
      photos: imgs.slice(0, 12),
      pills: pills.slice(0, 30),
      sections: sections.slice(0, 30),
      dl: dlText.slice(0, 10),
      htmlSize: root.innerHTML.length,
      htmlSnippet: root.innerHTML.slice(0, 4000),
    };
  });

  await writeFile("/tmp/bumble-rich-encounters.json", JSON.stringify(cardDump, null, 2));
  console.log("encounters card dumped:", cardDump?.htmlSize, "bytes html");
  console.log("photo count:", cardDump?.photos?.length);
  console.log("section count:", cardDump?.sections?.length);
  console.log("pill count:", cardDump?.pills?.length);

  // Now open Neha's thread + dump the profile pane shape.
  const matchId = TARGET_MATCH_ID || "zAhMACjIzNjkxNjA2MDgIe-K7hQAAAAAgiSu1SzK_cg-cL8re0K1Bu-K6WKVPnO95ba0zq3OJF68";
  await openThread(page, matchId);
  await page.waitForTimeout(2200);

  const paneDump = await page.evaluate(() => {
    const candidates = [".page__profile", "[data-qa-role='profile-pane']", ".profile-pane", ".connection-profile"];
    let root = null;
    for (const s of candidates) { root = document.querySelector(s); if (root) break; }
    if (!root) {
      // Fall back to scanning right rail for profile-ish elements.
      const all = [...document.querySelectorAll("aside, [class*='profile']")];
      return { found: false, allCandidates: all.map(el => ({ tag: el.tagName, cls: el.className })).slice(0, 12) };
    }
    return {
      found: true,
      cls: root.className,
      tag: root.tagName,
      htmlSize: root.innerHTML.length,
      text_first_3000: (root.textContent || "").replace(/\s+/g, " ").trim().slice(0, 3000),
      htmlSnippet: root.innerHTML.slice(0, 5000),
      photoCount: root.querySelectorAll("img").length,
      photos: [...root.querySelectorAll("img")].slice(0, 8).map(img => ({ src: img.src, alt: img.alt, cls: img.className })),
      sections: [...root.querySelectorAll("[class*='section'], [class*='profile']")].slice(0, 30).map(el => ({
        cls: el.className,
        text: (el.textContent || "").trim().slice(0, 200),
      })),
    };
  });

  await writeFile("/tmp/bumble-rich-pane.json", JSON.stringify(paneDump, null, 2));
  console.log("thread profile pane:", paneDump?.found, "size", paneDump?.htmlSize);
  console.log("pane photo count:", paneDump?.photoCount);
} finally {
  await page.waitForTimeout(1500);
  await ctx.close();
}
