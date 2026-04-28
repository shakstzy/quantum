#!/usr/bin/env node
// Opens patchright Chromium to tinder.com and stays open until the user closes the window.
// Use this for the one-time manual login. Profile persists at workspaces/tinder/.profile/.

import { launchPersistent } from "../src/runtime/profile.mjs";

const { ctx, page } = await launchPersistent({ headless: false });

await page.goto("https://tinder.com", { waitUntil: "domcontentloaded" });
console.log("browser open at https://tinder.com — log in manually. Close the window when done.");

await new Promise((resolve) => {
  ctx.on("close", resolve);
});
console.log("browser closed; profile persisted at .profile/");
