#!/usr/bin/env node
// Throwaway: open /app, scroll the conversations sidebar exhaustively, count
// how many distinct contact rows are present + what other match-bearing
// selectors exist. Used to validate that scrapeMatches isn't missing a
// section (e.g., "Match Queue" / Beeline / "Your Move" / pagination).

import { launchPersistent } from "../src/runtime/profile.mjs";
import { gotoMatches } from "../src/bumble/page.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";

const { ctx, page } = await launchPersistent({ headless: false });
try {
  await gotoMatches(page);
  await sleep(2500);

  // Count contact rows BEFORE scrolling.
  const initial = await page.$$eval("[data-qa-role='contact']", els => els.length);
  console.log(`initial contacts visible: ${initial}`);

  // Find all distinct sidebar sections that might contain match-like rows.
  const sectionMap = await page.evaluate(() => {
    const out = {};
    const candidates = [
      "[data-qa-role='conversations-tab-section']",
      "[data-qa-role='conversations-tab-section-content']",
      ".contacts__section",
      ".contacts__category",
      "[class*='contact-list']",
      "[class*='match-queue']",
      "[class*='beeline']",
      "[class*='archive']",
      "[data-qa*='archive']",
      "[aria-label*='archive' i]",
      "[aria-label*='hidden' i]",
      "button[class*='filter']",
      "[role='tab']",
    ];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      if (els.length) {
        out[sel] = [...els].slice(0, 4).map(el => ({
          cls: (el.className || "").slice(0, 80),
          headerText: el.querySelector("h2, [class*='heading'], [class*='header']")?.textContent?.trim()?.slice(0, 60) || null,
          contactCount: el.querySelectorAll("[data-qa-role='contact']").length,
          firstChildClasses: [...el.children].slice(0, 3).map(c => c.className?.slice(0, 60)).filter(Boolean),
        }));
      }
    }
    return out;
  });
  console.log("section_map:");
  console.log(JSON.stringify(sectionMap, null, 2));

  // Find distinct row selectors that look "match-like".
  const rowMap = await page.evaluate(() => {
    const out = {};
    const candidates = [
      "[data-qa-role='contact']",
      "[data-qa-role*='contact']",
      "[class*='contact-list-item']",
      "[class*='match-item']",
      "[class*='your-move']",
      "[href^='/app/connections']",
    ];
    for (const sel of candidates) {
      const c = document.querySelectorAll(sel).length;
      if (c) out[sel] = c;
    }
    return out;
  });
  console.log("row_map:");
  console.log(JSON.stringify(rowMap, null, 2));

  // Scroll the sidebar conversations container exhaustively.
  console.log("scrolling sidebar exhaustively...");
  let lastCount = initial;
  for (let pass = 0; pass < 30; pass++) {
    const beforeCount = await page.$$eval("[data-qa-role='contact']", els => els.length);
    // Try multiple scroll containers - we don't know which one is the actual scrollable one.
    await page.evaluate(() => {
      const candidates = [
        "[data-qa-role='conversations-tab-section-content']",
        "[data-qa-role='conversations-tab-section']",
        ".contacts__list",
        "[class*='contact-list']",
        "[class*='conversations']",
        "[class*='sidebar']",
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight) {
          el.scrollTop = el.scrollHeight;
        }
      }
      // Also try the last contact row's scrollIntoView as a fallback.
      const all = document.querySelectorAll("[data-qa-role='contact']");
      if (all.length) all[all.length - 1].scrollIntoView({ block: "end", behavior: "instant" });
    });
    await sleep(jitter(700, 1300));
    const afterCount = await page.$$eval("[data-qa-role='contact']", els => els.length);
    if (afterCount === beforeCount) {
      console.log(`pass ${pass}: ${afterCount} contacts (no growth, stopping)`);
      break;
    }
    console.log(`pass ${pass}: ${beforeCount} -> ${afterCount}`);
    lastCount = afterCount;
  }

  // Final breakdown by section header label.
  const finalSectionBreakdown = await page.evaluate(() => {
    const out = [];
    for (const sec of document.querySelectorAll("[data-qa-role='conversations-tab-section']")) {
      const header = sec.querySelector("h2, [class*='heading'], [class*='title']")?.textContent?.trim() || "(unlabeled)";
      const count = sec.querySelectorAll("[data-qa-role='contact']").length;
      out.push({ header, count });
    }
    return out;
  });
  console.log("final_breakdown:");
  console.log(JSON.stringify(finalSectionBreakdown, null, 2));

  const finalTotal = await page.$$eval("[data-qa-role='contact']", els => els.length);
  console.log(`FINAL total contacts (active sidebar): ${finalTotal}`);

  // Look for an Archive entry point: filter button, dropdown, or hidden tab.
  const archiveSurface = await page.evaluate(() => {
    const out = { matches: [] };
    // Look for any text that says "Archive" / "Archived" / "Hidden"
    const allText = document.body.innerText || "";
    out.bodyMentionsArchive = /archive/i.test(allText);
    out.bodyMentionsHidden = /\bhidden\b/i.test(allText);
    // Find clickable elements with archive-y labels.
    const labels = ["archive", "archived", "hidden", "filter"];
    for (const el of document.querySelectorAll("button, a, [role='tab'], [role='button'], [class*='filter']")) {
      const t = (el.textContent || "").trim();
      const aria = el.getAttribute("aria-label") || "";
      const both = (t + " " + aria).toLowerCase();
      for (const l of labels) {
        if (both.includes(l)) {
          out.matches.push({
            text: t.slice(0, 60),
            aria: aria.slice(0, 60),
            cls: (el.className || "").slice(0, 80),
            tag: el.tagName,
          });
          break;
        }
      }
    }
    return out;
  });
  console.log("archive_surface:");
  console.log(JSON.stringify(archiveSurface, null, 2));

  await page.screenshot({ path: "/tmp/bumble-sidebar.png", fullPage: true });
  console.log("screenshot at /tmp/bumble-sidebar.png");
} finally {
  await page.waitForTimeout(1500);
  await ctx.close();
}
