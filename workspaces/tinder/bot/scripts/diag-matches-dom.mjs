#!/usr/bin/env node
// Non-scrolling diagnostic of tinder.com/app/matches DOM structure.
// Read-only, no clicks, no scrolling, no api.gotinder.com.
// Just opens the page, waits, and dumps the structure so we can see
// whether 66 is the real count or whether matches live behind a tab/filter.

import { launchPersistent } from "../src/runtime/profile.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";

async function main() {
  await abortIfHalted();
  const { ctx, page } = await launchPersistent({ headless: false });

  try {
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    await sleep(jitter(4000, 6000));

    const diag = await page.evaluate(() => {
      const results = {};

      // 1) All match-thread anchors
      const anchors = document.querySelectorAll("a[href*='/app/messages/']");
      results.match_anchors_total = anchors.length;
      const ids = new Set();
      for (const a of anchors) {
        const id = a.href.split("/").pop();
        if (id && id.length >= 40) ids.add(id);
      }
      results.unique_match_ids = ids.size;

      // 2) Group anchors by their nearest scrollable ancestor
      const containerStats = new Map();
      for (const a of anchors) {
        let el = a;
        while (el && el !== document.body) {
          const style = getComputedStyle(el);
          if ((style.overflowY === "auto" || style.overflowY === "scroll")
              && el.scrollHeight > el.clientHeight + 4) {
            const key = el.tagName + "." + (el.className || "").split(/\s+/).slice(0, 2).join(".") + "#" + (el.id || "");
            const prev = containerStats.get(key) || {
              tag: el.tagName,
              classes: el.className,
              id: el.id,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              scrollTop: el.scrollTop,
              count: 0,
            };
            prev.count++;
            containerStats.set(key, prev);
            break;
          }
          el = el.parentElement;
        }
      }
      results.scrollable_ancestors = [...containerStats.values()];

      // 3) Tab-like elements anywhere on the page
      const tabs = [];
      for (const el of document.querySelectorAll("[role='tab'], button[aria-selected], a[aria-selected], nav a, nav button")) {
        const text = (el.textContent || "").trim().slice(0, 60);
        if (!text) continue;
        tabs.push({
          tag: el.tagName,
          role: el.getAttribute("role"),
          ariaSelected: el.getAttribute("aria-selected"),
          ariaLabel: el.getAttribute("aria-label"),
          href: el.getAttribute("href"),
          text,
        });
      }
      results.tabs = tabs.slice(0, 30);

      // 4) Section headers
      const headings = [];
      for (const el of document.querySelectorAll("h1, h2, h3, h4, [role='heading']")) {
        const text = (el.textContent || "").trim().slice(0, 80);
        if (!text) continue;
        headings.push({ tag: el.tagName, level: el.getAttribute("aria-level"), text });
      }
      results.headings = headings.slice(0, 30);

      // 5) Messages-section heuristics: search for "Messages" / "Matches" text
      const banners = [];
      const re = /\b(messages|matches|new matches|unread|chats)\b/i;
      for (const el of document.querySelectorAll("h1, h2, h3, h4, [role='heading'], div, span")) {
        const text = (el.textContent || "").trim();
        if (text.length < 3 || text.length > 50) continue;
        if (re.test(text) && el.children.length === 0) {
          banners.push({ tag: el.tagName, text });
          if (banners.length >= 20) break;
        }
      }
      results.messages_text_hits = banners;

      // 6) URL + title
      results.url = location.href;
      results.title = document.title;

      // 7) Body scroll status
      results.body_scroll = {
        scrollHeight: document.body.scrollHeight,
        clientHeight: document.body.clientHeight,
        scrollTop: document.scrollingElement?.scrollTop ?? document.body.scrollTop,
      };

      return results;
    });

    console.log(JSON.stringify(diag, null, 2));
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(`diag FAILED: ${e.stack || e.message}`); process.exit(1); });
