import { mkdir } from "node:fs/promises";
import { chromium } from "patchright";
import { PROFILE_DIR } from "./paths.mjs";

const VIEWPORT = { width: 1440, height: 900 };
const LOCALE = "en-US";
const TIMEZONE = "America/Chicago";

export async function launchPersistent({ headless = false } = {}) {
  await mkdir(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    channel: "chrome",
    viewport: VIEWPORT,
    locale: LOCALE,
    timezoneId: TIMEZONE,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

export async function gotoTinder(page, path = "/app/recs") {
  await page.goto(`https://tinder.com${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800 + Math.random() * 1200);
}
