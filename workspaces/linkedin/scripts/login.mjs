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
  console.log("[login] /feed reached. Reading own profile via extractor as a sanity check…");
  const ext = new LinkedInExtractor(page);
  // Visit /me/ — it client-side redirects to /in/<vanity>/. Wait for the redirect.
  await page.goto("https://www.linkedin.com/me/", { waitUntil: "load", timeout: 30_000 });
  try {
    await page.waitForURL(/linkedin\.com\/in\//, { timeout: 12_000 });
  } catch { /* tolerate, we'll inspect URL anyway */ }
  await page.waitForTimeout(1500);
  const url = page.url();
  const match = url.match(/\/in\/([^/?#]+)/);
  if (match) {
    const me = await ext.getPersonProfile(match[1]);
    console.log("[login] OK. Self profile:");
    console.log(JSON.stringify({ url: me.url, displayName: me.displayName, profileUrn: me.profileUrn, publicId: match[1], mainTextLen: (me.sections.main_profile || "").length }, null, 2));
  } else {
    console.log("[login] OK but could not derive own /in/ slug from", url);
  }
} catch (err) {
  console.error(`[login] failed: ${err.code ?? "ERR"} ${err.message}`);
  exitCode = 1;
} finally {
  await ctx.close();
  process.exit(exitCode);
}
