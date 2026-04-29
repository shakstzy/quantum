import { mkdir } from "node:fs/promises";
import { chromium } from "patchright";
import lockfile from "proper-lockfile";
import { PROFILE_DIR } from "./paths.mjs";

const VIEWPORT = { width: 1440, height: 900 };
const LOCALE = "en-US";
const TIMEZONE = "America/Chicago";

// C2 FIX: chromium --user-data-dir allows exactly one process. Concurrent launch
// (cron + manual; swipe + send) corrupts cookies and the SingletonLock, forcing
// re-login. Acquire process-level lock first; bail cleanly if held.
let _lockRelease = null;

export async function launchPersistent({ headless = false } = {}) {
  await mkdir(PROFILE_DIR, { recursive: true });
  try {
    _lockRelease = await lockfile.lock(PROFILE_DIR, {
      retries: { retries: 0 },
      stale: 0,
      lockfilePath: PROFILE_DIR + "/.session.lock",
    });
  } catch (e) {
    if (e.code === "ELOCKED") {
      throw new Error("profile_locked: another tinder bot session is already running. Aborting to avoid cookie corruption.");
    }
    throw e;
  }

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
  ctx.on("close", async () => { try { if (_lockRelease) await _lockRelease(); } catch {} _lockRelease = null; });
  return { ctx, page };
}

export async function gotoTinder(page, path = "/app/recs") {
  await page.goto(`https://tinder.com${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800 + Math.random() * 1200);
}
