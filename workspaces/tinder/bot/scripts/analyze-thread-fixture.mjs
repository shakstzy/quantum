#!/usr/bin/env node
// Offline analyzer: parses a fixture HTML dump and prints proposed selectors
// for the thread profile pane (name+age, bio, basics, lifestyle, interests).
// No network. Run after dump-thread-dom.mjs.

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

const FIXTURE_DIR = resolve(process.cwd(), "bot/.dev-fixtures/thread-dom");

const files = (await readdir(FIXTURE_DIR)).filter(f => f.endsWith("-stage1-as-is.html"));
if (!files.length) {
  console.error("no stage1 fixture found in", FIXTURE_DIR);
  process.exit(1);
}

for (const f of files) {
  const html = await readFile(resolve(FIXTURE_DIR, f), "utf8");
  const { document } = new JSDOM(html).window;
  console.log(`\n=== ${f} ===`);

  // Name + age — likely H1 in the profile pane
  const h1s = [...document.querySelectorAll("h1")];
  console.log(`\nH1s (${h1s.length}):`);
  for (const h of h1s) {
    const text = (h.textContent || "").trim();
    if (!text) continue;
    let cls = h.className || "";
    if (typeof cls !== "string") cls = (cls.toString && cls.toString()) || "";
    cls = cls.slice(0, 80);
    let parentTag = "";
    if (h.parentElement) {
      let pcls = h.parentElement.className || "";
      if (typeof pcls !== "string") pcls = (pcls.toString && pcls.toString()) || "";
      parentTag = `${h.parentElement.tagName}.${pcls.slice(0, 40)}`;
    }
    console.log(`  "${text}"  class=${cls}  parent=${parentTag}`);
  }

  // H2 sections
  const h2s = [...document.querySelectorAll("h2")];
  console.log(`\nH2s (${h2s.length}):`);
  for (const h of h2s) {
    const text = (h.textContent || "").trim();
    if (!text) continue;
    let cls = h.className || "";
    if (typeof cls !== "string") cls = (cls.toString && cls.toString()) || "";
    cls = cls.slice(0, 80);
    console.log(`  "${text}"  class=${cls}`);
  }

  // For each interesting H2, look at the next sibling's text
  const wantedH2 = ["Looking for", "About me", "Essentials", "Basics", "Lifestyle", "Interests"];
  console.log(`\nSection contents:`);
  for (const h of h2s) {
    const text = (h.textContent || "").trim();
    const matched = wantedH2.find(w => text.toLowerCase().startsWith(w.toLowerCase()));
    if (!matched) continue;
    // the section content typically follows the h2; look at parent of h2
    const parent = h.parentElement;
    if (!parent) continue;
    let pcls = parent.className || "";
    if (typeof pcls !== "string") pcls = (pcls.toString && pcls.toString()) || "";
    console.log(`  [${matched}] parent.tagName=${parent.tagName} class=${pcls.slice(0, 60)}`);
    const ptxt = (parent.textContent || "").trim().slice(0, 200).replace(/\s+/g, " ");
    console.log(`     parent.text: ${ptxt}`);
    // also look at next sibling sections within parent
    const grand = parent.parentElement;
    if (grand) {
      let gcls = grand.className || "";
      if (typeof gcls !== "string") gcls = (gcls.toString && gcls.toString()) || "";
      console.log(`     grandparent.tagName=${grand.tagName} class=${gcls.slice(0, 60)}`);
    }
  }

  // Photos: look for img tags inside the profile pane
  const imgs = [...document.querySelectorAll("img")].filter(i => i.alt || (i.src && i.src.includes("images-ssl")));
  console.log(`\nImgs with alt/photo URLs: ${imgs.length}`);
  for (const i of imgs.slice(0, 6)) {
    const alt = (i.alt || "").slice(0, 40);
    const src = (i.src || "").slice(0, 80);
    console.log(`  alt="${alt}"  src="${src}"`);
  }

  // Distance string — look for "miles away" or "mi away"
  const all = document.body.textContent || "";
  const distMatches = [...all.matchAll(/(\d+)\s*(?:miles?|mi)\s*away/gi)].slice(0, 3);
  console.log(`\nDistance matches: ${distMatches.length} found`);
  for (const m of distMatches) console.log(`  "${m[0]}"`);

  // Job/school — look for divs with role next to building/school icons
  const profileText = all.slice(0, 4000);
  console.log(`\nFirst 800 chars of full body text (profile pane probably visible):`);
  console.log(profileText.slice(0, 800).replace(/\s+/g, " "));
}
