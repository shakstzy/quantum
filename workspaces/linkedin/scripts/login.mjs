#!/usr/bin/env node
// One-time interactive login. Headful Chrome; user types creds + handles 2FA / captcha / comply.

import { launchPersistent } from "../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../src/linkedin/session.mjs";
import { LinkedInExtractor } from "../src/linkedin/extractor.mjs";
import { abortIfHalted, isHalted } from "../src/runtime/halt.mjs";

if (await isHalted()) {
  console.error("Workspace is halted. Inspect ~/.quantum/linkedin/.halt before re-running login.");
  process.exit(2);
}
await abortIfHalted();

console.log("[login] launching persistent Chrome profile…");
const { ctx, page } = await launchPersistent({ headless: false });
let exitCode = 0;
try {
  await ensureLoggedIn(page, { allowInteractive: true, interactiveTimeoutMs: 5 * 60_000 });
  console.log("[login] /feed reached. Reading own profile slug from global nav…");
  // /me/ doesn't reliably redirect under patchright (the JS redirect fails or is delayed).
  // Pull the user's /in/<vanity>/ link directly from the global nav anchors instead. This
  // is rendered server-side and always present when logged in.
  const navHref = await page.evaluate(() => {
    // Try the most stable selectors first.
    const candidates = [
      'nav a[href*="/in/"]',
      'header a[href*="/in/"]',
      'a[href*="/in/"][data-test-app-aware-link]',
      'a[href*="/in/"]',
    ];
    for (const sel of candidates) {
      const a = document.querySelector(sel);
      if (a) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/in\/([^/?#]+)/);
        if (m) return { href, publicId: m[1], selector: sel };
      }
    }
    return null;
  }).catch(() => null);

  if (!navHref) {
    console.log("[login] OK but could not find a self /in/ link in nav. Session is good though.");
  } else {
    console.log(`[login] self public_id from nav: ${navHref.publicId}  (selector=${navHref.selector})`);
    try {
      const ext = new LinkedInExtractor(page);
      const me = await ext.getPersonProfile(navHref.publicId);
      console.log("[login] OK. Self profile:");
      console.log(JSON.stringify({ url: me.url, displayName: me.displayName, profileUrn: me.profileUrn, publicId: navHref.publicId, mainTextLen: (me.sections.main_profile || "").length }, null, 2));
    } catch (err) {
      console.error(`[login] self-profile fetch failed: ${err.code ?? "ERR"} ${err.message}`);
    }
  }
} catch (err) {
  console.error(`[login] failed: ${err.code ?? "ERR"} ${err.message}`);
  exitCode = 1;
} finally {
  await ctx.close();
  process.exit(exitCode);
}
