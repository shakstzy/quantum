// Patchright persistent-context launcher. Mirrors workspaces/tinder/bot/src/runtime/profile.mjs
// but pinned to the LinkedIn .profile dir and with LinkedIn-flavored hardening.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "patchright";
import { PROFILE_DIR } from "./paths.mjs";

const DEFAULT_VIEWPORT = { width: 1366, height: 820 };
const DEFAULT_USER_AGENT = null;
// Rapid sequential verbs trigger LinkedIn's /feed/ throttle. Cross-process file lock keeps
// back-to-back CLI invocations >=30s apart.
const MIN_INTER_LAUNCH_MS = 30_000;
const LAUNCH_TS_FILE = path.join(os.homedir(), ".quantum", "linkedin", "state", "last-launch.ts");

async function paceLaunch() {
  try {
    const raw = await fs.readFile(LAUNCH_TS_FILE, "utf8").catch(() => null);
    const last = raw ? Number(raw) : 0;
    const wait = MIN_INTER_LAUNCH_MS - (Date.now() - last);
    if (wait > 0 && wait <= MIN_INTER_LAUNCH_MS) {
      process.stderr.write(`[profile] pacing ${Math.ceil(wait / 1000)}s before launch\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
    await fs.mkdir(path.dirname(LAUNCH_TS_FILE), { recursive: true });
    await fs.writeFile(LAUNCH_TS_FILE, String(Date.now()));
  } catch { /* best-effort */ }
}

export async function launchPersistent({
  headless = false,
  slowMo = 0,
  viewport = DEFAULT_VIEWPORT,
  userAgent = DEFAULT_USER_AGENT,
  closeStraggler = true,
} = {}) {
  await paceLaunch();
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const launchOpts = {
    headless,
    slowMo,
    viewport,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };
  if (userAgent) launchOpts.userAgent = userAgent;
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);

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
