#!/usr/bin/env node
// Pre-flight: deps, profile dir, halt state, claude CLI presence. Does NOT launch a browser.
import { access, stat } from "node:fs/promises";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROFILE_DIR, CAPS_FILE, SELECTORS_FILE, FILTER_FILE, VOICE_DIR, CONFIG_DIR } from "../src/runtime/paths.mjs";
import { resolve as resolvePath } from "node:path";
import { isHalted, readHaltReason } from "../src/runtime/halt.mjs";

const execFile = promisify(_execFile);
const checks = [];
function ok(name) { checks.push({ name, status: "ok" }); }
function fail(name, why) { checks.push({ name, status: "FAIL", why }); }
function warn(name, why) { checks.push({ name, status: "warn", why }); }

async function exists(p) { try { await access(p); return true; } catch { return false; } }

try { await execFile("claude", ["--version"], { timeout: 5000 }); ok("claude CLI"); }
catch { fail("claude CLI", "not on PATH; needed for drafting (no API key approach)"); }

if (process.env.QUANTUM_SELF_PHONE) ok("QUANTUM_SELF_PHONE");
else warn("QUANTUM_SELF_PHONE", "not set; HITL notifications disabled");

const citiesFile = resolvePath(CONFIG_DIR, "cities.json");
for (const [name, p] of [["caps.json", CAPS_FILE], ["selectors.json", SELECTORS_FILE], ["filter.json", FILTER_FILE], ["cities.json", citiesFile]]) {
  if (await exists(p)) ok(name); else fail(name, `missing: ${p}`);
}

if (await exists(VOICE_DIR)) ok("voice/");
else fail("voice/", `missing: ${VOICE_DIR}`);

if (await exists(PROFILE_DIR)) {
  const s = await stat(PROFILE_DIR);
  if (s.isDirectory()) ok(".profile/");
  else fail(".profile/", "exists but is not a dir");
} else warn(".profile/", "missing — will be created on first session, but you'll need to log in");

if (await isHalted()) fail("halt_state", `HALT FILE PRESENT: ${await readHaltReason()}`);
else ok("halt_state");

let nodeOk = true;
try { await import("patchright"); } catch { nodeOk = false; }
if (nodeOk) ok("patchright"); else fail("patchright", "not installed; run `npm install` in bot/");

let cursorOk = true;
try { await import("ghost-cursor-playwright"); } catch { cursorOk = false; }
if (cursorOk) ok("ghost-cursor-playwright"); else fail("ghost-cursor-playwright", "not installed");


const anyFail = checks.some(c => c.status === "FAIL");
for (const c of checks) console.log(`${c.status.padEnd(4)} ${c.name}${c.why ? ` — ${c.why}` : ""}`);
process.exit(anyFail ? 1 : 0);
