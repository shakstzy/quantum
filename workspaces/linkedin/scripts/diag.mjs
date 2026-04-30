#!/usr/bin/env node
// Diagnostic dump for selector drift. Per the QUANTUM browser-skill self-heal learning:
// when a verb breaks, run this against the live site, read the survey, patch selectors,
// re-test. Do NOT ask the operator to debug selectors.
//
// Outputs into ~/.quantum/linkedin/diag/<ts>/ : page-text.txt, screenshot.png,
// selector-survey.json (counts per selector chain).

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../src/linkedin/session.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { SELECTORS_FILE } from "../src/runtime/paths.mjs";

const args = parseArgs(process.argv.slice(2));

await abortIfHalted();
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(homedir(), ".quantum/linkedin/diag", ts);
await fs.mkdir(outDir, { recursive: true });

const sel = JSON.parse(await fs.readFile(SELECTORS_FILE, "utf8"));
const { ctx, page } = await launchPersistent({ headless: false });
try {
  await ensureLoggedIn(page);
  const url = args.url ?? "https://www.linkedin.com/feed/";
  console.log(`[diag] -> ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500);

  await page.screenshot({ path: join(outDir, "screenshot.png"), fullPage: true });
  const text = (await page.evaluate(() => document.body.innerText)).slice(0, 5000);
  await fs.writeFile(join(outDir, "page-text.txt"), text, "utf8");

  const survey = {};
  for (const [section, group] of Object.entries(sel)) {
    if (typeof group !== "object" || Array.isArray(group)) {
      survey[section] = await surveyChain(page, Array.isArray(group) ? group : []);
      continue;
    }
    survey[section] = {};
    for (const [name, chain] of Object.entries(group)) {
      survey[section][name] = await surveyChain(page, chain);
    }
  }
  await fs.writeFile(join(outDir, "selector-survey.json"), JSON.stringify(survey, null, 2), "utf8");

  console.log(`[diag] artifacts: ${outDir}`);
} finally {
  await ctx.close();
}

async function surveyChain(page, chain) {
  if (!Array.isArray(chain)) return null;
  const out = [];
  for (const s of chain) {
    let count = 0; let sample = null;
    try {
      count = await page.locator(s).count();
      if (count > 0) sample = await page.locator(s).first().evaluate((el) => el.outerHTML?.slice(0, 240) ?? null).catch(() => null);
    } catch (err) { sample = `ERR:${err.message}`; }
    out.push({ selector: s, count, sample });
  }
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
  }
  return out;
}
