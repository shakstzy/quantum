#!/usr/bin/env node
// Throwaway: open Lacie's thread (verified expired via screenshot), dump the
// DOM around the "This match has expired" interstitial + Rematch button so
// we can wire scripts/rematch.mjs.

import { writeFile } from "node:fs/promises";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { openThread } from "../src/bumble/page.mjs";
import { sleep } from "../src/runtime/humanize.mjs";

const LACIE = "zAhMACjE2OTAyNjEyMDkIe-K7hQAAAAAgrs_qV8hJY35hxLk9DOYNlAmO56WFBreJdmEiXr6gmGw";

const { ctx, page } = await launchPersistent({ headless: false });
try {
  await openThread(page, LACIE);
  await sleep(3500);

  const probe = await page.evaluate(() => {
    const out = {};
    out.bodyHasExpiredText = /this match has expired/i.test(document.body.innerText || "");
    out.bodyHasRematchText = /\brematch\b/i.test(document.body.innerText || "");

    const candidatesForExpired = [
      ".match-expired",
      "[class*='expired']",
      "[class*='match-expired']",
      "[class*='no-conversation']",
      "[class*='conversation-expired']",
    ];
    out.expiredEls = [];
    for (const sel of candidatesForExpired) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const t = (el.textContent || "").trim().slice(0, 150);
        if (t) out.expiredEls.push({ sel, cls: (el.className || "").slice(0, 100), text: t });
      }
    }

    out.rematchButtons = [];
    for (const btn of document.querySelectorAll("button, [role='button']")) {
      const t = (btn.textContent || "").trim();
      const aria = btn.getAttribute("aria-label") || "";
      if (/^rematch$/i.test(t) || /rematch/i.test(t) || /rematch/i.test(aria)) {
        out.rematchButtons.push({
          text: t,
          aria,
          cls: (btn.className || "").slice(0, 120),
          dataQa: btn.getAttribute("data-qa-role") || btn.getAttribute("data-qa") || null,
          tag: btn.tagName,
          disabled: btn.hasAttribute("disabled") || btn.getAttribute("aria-disabled") === "true",
        });
      }
    }

    // Surrounding container of the rematch button (so we know what selector identifies the interstitial wrapper).
    const rematchBtn = [...document.querySelectorAll("button, [role='button']")].find(b => /^rematch$/i.test((b.textContent || "").trim()));
    if (rematchBtn) {
      let parent = rematchBtn.parentElement;
      out.parentChain = [];
      for (let i = 0; i < 6 && parent; i++) {
        out.parentChain.push({
          tag: parent.tagName,
          cls: (parent.className || "").slice(0, 100),
          dataQa: parent.getAttribute("data-qa-role") || null,
        });
        parent = parent.parentElement;
      }
    }

    return out;
  });

  console.log(JSON.stringify(probe, null, 2));
  await writeFile("/tmp/bumble-rematch-probe.json", JSON.stringify(probe, null, 2));
  try { await page.screenshot({ path: "/tmp/bumble-rematch-probe.png", fullPage: false }); } catch {}
} finally {
  try { await ctx.close(); } catch {}
}
