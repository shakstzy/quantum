import { mkdir } from "node:fs/promises";
import { chromium } from "patchright";
import lockfile from "proper-lockfile";
import { PROFILE_DIR } from "./paths.mjs";

const VIEWPORT = { width: 1440, height: 900 };
const LOCALE = "en-US";
const TIMEZONE = "America/Chicago";

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
      throw new Error("profile_locked: another bumble bot session is already running. Aborting to avoid cookie corruption.");
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

// Gemini P2 #8: don't navigate straight to a logged-in app surface from cold launch.
// Boot to a neutral page first to establish browser history + local state, then
// navigate to bumble.com once the page is settled.
export async function gotoBumble(page, path = "/") {
  await page.goto(`https://bumble.com${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800 + Math.random() * 1200);
}
