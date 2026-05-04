// LinkedIn session: ensure /feed/. Manual-login-only by design.
// We never auto-fill credentials. Any time /feed isn't reachable, surface AuthError.

import { sleep, jitter } from "../runtime/humanize.mjs";
import { AuthError } from "../runtime/exceptions.mjs";
import { detectRateLimit, isLoggedIn } from "./page-actions.mjs";

const FEED_URL = "https://www.linkedin.com/feed/";

export async function ensureLoggedIn(page, { allowInteractive = false, interactiveTimeoutMs = 5 * 60_000 } = {}) {
  // 2026-05-04: skip the /feed/ pre-nav when li_at cookie is present. Hitting /feed/ on every
  // verb is the most expensive nav on LinkedIn AND was the cause of our throttle bug. The caller
  // will hit /authwall on its action URL if the session is actually stale; detectRateLimit catches it.
  if (!allowInteractive) {
    const cookies = await page.context().cookies("https://www.linkedin.com").catch(() => []);
    if (cookies.some((c) => c.name === "li_at" && c.value)) {
      return { ok: true, url: page.url(), fast: true };
    }
  }

  await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(jitter(800, 1800));
  await detectRateLimit(page);

  if (await isLoggedIn(page)) return { ok: true, url: page.url() };

  if (!allowInteractive) {
    throw new AuthError(
      `Not logged in. Run \`npm run login\` to establish the persistent profile.`,
      { hint: "first-time login" }
    );
  }

  const deadline = Date.now() + interactiveTimeoutMs;
  process.stderr.write("[session] waiting for interactive login...\n");
  while (Date.now() < deadline) {
    await sleep(2000);
    await detectRateLimit(page).catch(() => {}); // surface checkpoint immediately
    if (await isLoggedIn(page)) return { ok: true, url: page.url() };
  }
  throw new AuthError(`Interactive login timed out after ${Math.round(interactiveTimeoutMs / 1000)}s`);
}
