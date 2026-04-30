// LinkedIn session: ensure we land on /feed/ with a healthy logged-in cookie. Detects OTP /
// captcha / comply / authwall and surfaces typed errors. Manual-login-only by design — we
// never re-type credentials programmatically (that's the canonical ban-trigger pattern, per
// Gemini-Flash adversarial review fix #5).

import { AuthError, CheckpointError } from "../runtime/exceptions.mjs";
import { inspectPage, dismissComplyGate } from "./ban-signals.mjs";
import { humanScroll, sleep, jitter } from "../runtime/humanize.mjs";

const FEED_URL = "https://www.linkedin.com/feed/";
const ME_URL = "https://www.linkedin.com/me/";

export async function ensureLoggedIn(page, { allowInteractive = false, interactiveTimeoutMs = 5 * 60_000 } = {}) {
  await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(jitter(800, 1800));

  // First inspection: comply gate is dismissable, everything else is fatal here.
  const inspection = await inspectPage(page, { stage: "post_feed_goto" });
  if (inspection.complyGate) {
    await dismissComplyGate(page);
    await sleep(jitter(500, 1200));
    await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  if (page.url().includes("/login") || page.url().includes("/uas/login")) {
    if (!allowInteractive) {
      throw new AuthError(
        `Not logged in. Run \`npm run login\` (interactive) to establish the persistent profile.`,
        { hint: "first-time login" }
      );
    }
    // Interactive: wait until the user completes login by hand. Poll for /feed.
    const deadline = Date.now() + interactiveTimeoutMs;
    while (Date.now() < deadline) {
      if (page.url().startsWith(FEED_URL) || page.url().startsWith("https://www.linkedin.com/feed")) {
        break;
      }
      await sleep(2000);
    }
    if (!(page.url().startsWith(FEED_URL) || page.url().startsWith("https://www.linkedin.com/feed"))) {
      throw new AuthError(`Interactive login timed out after ${Math.round(interactiveTimeoutMs / 1000)}s`);
    }
  }

  // Re-inspect after potential login. CheckpointError means OTP / device verification.
  await inspectPage(page, { stage: "post_login" });

  // Light human noise so the session has at least one scroll event before any Voyager call.
  await humanScroll(page, { distance: jitter(120, 280), steps: 3 });
  await sleep(jitter(500, 1200));

  return { ok: true, feedUrl: page.url() };
}

export async function visitMe(page) {
  await page.goto(ME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(jitter(800, 1800));
  await inspectPage(page, { stage: "post_me_visit" });
}

// Pull the JSESSIONID cookie. LinkedIn rotates this mid-session (per Gemini-Flash fix #4),
// so the API client refreshes via this helper before EVERY fetch.
export async function csrfToken(ctx) {
  const cookies = await ctx.cookies("https://www.linkedin.com");
  const jsess = cookies.find((c) => c.name === "JSESSIONID");
  if (!jsess) {
    throw new AuthError("No JSESSIONID cookie. Session is not authenticated.", { hint: "run login" });
  }
  return jsess.value.replace(/^"|"$/g, "");
}
