#!/usr/bin/env node
// Throwaway: launch the persistent profile, navigate to /app, dump what's
// actually rendered on the encounters surface. Used to debug why
// readVisibleCard returns empty (no name/age).

import { launchPersistent } from "../src/runtime/profile.mjs";
import { gotoEncounters, readVisibleCard } from "../src/bumble/page.mjs";
import { selectors } from "../src/runtime/detection.mjs";

const { ctx, page } = await launchPersistent({ headless: false });
try {
  await gotoEncounters(page);
  await page.waitForTimeout(2500);

  const url = page.url();
  console.log(`url: ${url}`);

  const sels = await selectors();
  const recSel = sels.rec_card.selector;

  const probe = await page.evaluate((rs) => {
    const root = document.querySelector(rs);
    if (!root) {
      return { found: false, body_text_first_500: (document.body?.innerText || "").slice(0, 500) };
    }
    const text = (root.textContent || "").replace(/\s+/g, " ").trim();
    return {
      found: true,
      rect: root.getBoundingClientRect().toJSON?.() || null,
      childCount: root.childElementCount,
      text_first_500: text.slice(0, 500),
      hasStory: !!root.querySelector("[data-qa-role='encounters-story']"),
      classNames: root.className,
    };
  }, recSel);

  console.log("rec_card probe:", JSON.stringify(probe, null, 2));

  const profile = await readVisibleCard(page);
  console.log("readVisibleCard:", JSON.stringify(profile, null, 2));

  await page.screenshot({ path: "/tmp/bumble-encounters.png", fullPage: false });
  console.log("screenshot: /tmp/bumble-encounters.png");
} finally {
  await page.waitForTimeout(1500);
  await ctx.close();
}
