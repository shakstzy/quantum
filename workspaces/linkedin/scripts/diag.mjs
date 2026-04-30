#!/usr/bin/env node
// Diagnostic dump for selector drift. Per QUANTUM browser-skill self-heal protocol:
// when a verb breaks, run this against the live page, read the output, patch the
// extractor / dialog selectors, re-test.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../src/linkedin/session.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";

const args = parseArgs(process.argv.slice(2));
await abortIfHalted();
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(homedir(), ".quantum/linkedin/diag", ts);
await fs.mkdir(outDir, { recursive: true });

const url = args.url ?? "https://www.linkedin.com/feed/";
const { ctx, page } = await launchPersistent({ headless: false });
try {
  await ensureLoggedIn(page);
  console.log(`[diag] -> ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500);

  await page.screenshot({ path: join(outDir, "screenshot.png"), fullPage: true });
  const innerText = await page.evaluate(() => (document.body?.innerText || "").slice(0, 8000));
  await fs.writeFile(join(outDir, "page-text.txt"), innerText, "utf8");

  // Survey the structural anchors used by the extractor.
  const survey = await page.evaluate(() => {
    function describe(sel) {
      const els = Array.from(document.querySelectorAll(sel));
      return { count: els.length, sample: els[0]?.outerHTML?.slice(0, 240) ?? null };
    }
    return {
      "main": describe("main"),
      "main h1": describe("main h1"),
      "main a[href*='/preload/custom-invite/']": describe("main a[href*='/preload/custom-invite/']"),
      "main a[href*='/messaging/compose/']": describe("main a[href*='/messaging/compose/']"),
      "main a[href*='/edit/intro/']": describe("main a[href*='/edit/intro/']"),
      "dialog[open], [role='dialog']": describe("dialog[open], [role='dialog']"),
      "[role='dialog'] textarea, dialog textarea": describe("[role='dialog'] textarea, dialog textarea"),
      "main label[aria-label^='Select conversation']": describe("main label[aria-label^='Select conversation']"),
      "div[role='textbox'][contenteditable='true']": describe("div[role='textbox'][contenteditable='true']"),
      "button[aria-label*='Send']": describe("button[aria-label*='Send']"),
      "button[aria-label*='Withdraw']": describe("button[aria-label*='Withdraw']"),
      "main a[href*='/in/']": describe("main a[href*='/in/']"),
    };
  }).catch((e) => ({ _error: String(e) }));
  await fs.writeFile(join(outDir, "selector-survey.json"), JSON.stringify(survey, null, 2), "utf8");

  console.log(`[diag] artifacts: ${outDir}`);
} finally {
  await ctx.close();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
  }
  return out;
}
