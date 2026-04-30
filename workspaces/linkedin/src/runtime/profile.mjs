// Patchright persistent-context launcher. Mirrors workspaces/tinder/bot/src/runtime/profile.mjs
// but pinned to the LinkedIn .profile dir and with LinkedIn-flavored hardening.

import { promises as fs } from "node:fs";
import { chromium } from "patchright";
import { PROFILE_DIR } from "./paths.mjs";

const DEFAULT_VIEWPORT = { width: 1366, height: 820 };
const DEFAULT_USER_AGENT = null; // let patchright/chromium pick to match installed Chromium build

export async function launchPersistent({
  headless = false,
  slowMo = 0,
  viewport = DEFAULT_VIEWPORT,
  userAgent = DEFAULT_USER_AGENT,
  closeStraggler = true,
} = {}) {
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    slowMo,
    viewport,
    userAgent,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  // Tab hygiene per QUANTUM feedback memory: close stragglers on launch.
  if (closeStraggler) {
    const pages = ctx.pages();
    for (let i = 1; i < pages.length; i++) {
      try { await pages[i].close({ runBeforeUnload: false }); } catch { /* ignore */ }
    }
  }
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(30_000);

  // Tab hygiene on close: close every page.
  const origClose = ctx.close.bind(ctx);
  ctx.close = async () => {
    for (const p of ctx.pages()) {
      try { await p.close({ runBeforeUnload: false }); } catch { /* ignore */ }
    }
    return origClose();
  };

  return { ctx, page };
}
