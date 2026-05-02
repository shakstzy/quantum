#!/usr/bin/env node
// Opens patchright Chrome to bumble.com and stays open until the user closes the window.
// Use this for the one-time manual login. Profile persists at workspaces/bumble/.profile/.
//
// Per Gemini's P2 #8: warm the browser on a neutral page first, then navigate to
// bumble.com get-started. This establishes local state before hitting the auth wall.

import { launchPersistent } from "../src/runtime/profile.mjs";

const { ctx, page } = await launchPersistent({ headless: false });

// Warmup: load Google's homepage briefly so the browser has plausible history before bumble.com.
try {
  await page.goto("https://www.google.com/", { waitUntil: "domcontentloaded", timeout: 12000 });
  await page.waitForTimeout(1500 + Math.random() * 1500);
} catch { /* warmup is best-effort, don't fail login on it */ }

await page.goto("https://bumble.com/get-started", { waitUntil: "domcontentloaded" });

console.log("browser open at https://bumble.com/get-started");
console.log("log in manually with phone number (avoid Google/Facebook/Apple OAuth - extra fingerprint surfaces).");
console.log("close the window when login is complete; profile persists at .profile/.");

await new Promise((resolve) => {
  ctx.on("close", resolve);
});
console.log("browser closed; profile persisted at .profile/");
