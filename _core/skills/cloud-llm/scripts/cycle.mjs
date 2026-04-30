// Cloud LLM dispatcher with account cycling.
//
// Default engine: Gemini Pro vision. Cycles 3 cached accounts on 429.
// Final fallback: claude -p sonnet.
//
// Consumers (tinder-visualize, future) import describeImages / askText.
// See SKILL.md for behavior + when this fires.

import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const execFile = promisify(_execFile);

const QUANTUM_ROOT = "/Users/shakstzy/QUANTUM";
const STAGING_DIR = resolve(QUANTUM_ROOT, "raw/.cloud-llm-staging");
const GEMINI_ACCOUNTS_DIR = resolve(homedir(), ".gemini/accounts");
const GEMINI_ACTIVE_CREDS = resolve(homedir(), ".gemini/oauth_creds.json");
const GEMINI_PRO_MODEL = "gemini-3-pro-preview";

export class CloudLLMUnreachable extends Error {
  constructor(message) { super(message); this.name = "CloudLLMUnreachable"; }
}

async function listGeminiAccounts() {
  try {
    const files = await readdir(GEMINI_ACCOUNTS_DIR);
    return files.filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
  } catch { return []; }
}

async function rotateGeminiAccount(email) {
  const src = resolve(GEMINI_ACCOUNTS_DIR, `${email}.json`);
  await copyFile(src, GEMINI_ACTIVE_CREDS);
}

// Stage images so they live under QUANTUM_ROOT (gemini's workspace sandbox
// rejects paths outside cwd). Returns array of relative-to-QUANTUM_ROOT paths.
async function stageImages(absPaths) {
  const runId = randomUUID().slice(0, 8);
  const stage = resolve(STAGING_DIR, runId);
  await mkdir(stage, { recursive: true });
  const staged = [];
  for (let i = 0; i < absPaths.length; i++) {
    const src = absPaths[i];
    if (src.startsWith(QUANTUM_ROOT + "/")) {
      // already under QUANTUM, no copy
      staged.push({ rel: src.slice(QUANTUM_ROOT.length + 1), copied: null });
    } else {
      const ext = (basename(src).match(/\.[a-z0-9]+$/i) || [".jpg"])[0];
      const target = resolve(stage, `img-${i}${ext}`);
      await copyFile(src, target);
      staged.push({ rel: target.slice(QUANTUM_ROOT.length + 1), copied: target });
    }
  }
  return { runId, stage, staged };
}

async function cleanupStage(stage) {
  try { await rm(stage, { recursive: true, force: true }); } catch {}
}

const GEMINI_QUOTA_RE = /(429|exhausted|quota|rate.?limit)/i;

async function runGemini({ prompt, imageRefs, useFlash = false }) {
  // imageRefs: array of relative-to-QUANTUM_ROOT paths (already staged)
  // We invoke gemini from QUANTUM_ROOT cwd so the workspace sandbox accepts them.
  const fullPrompt = imageRefs.length > 0
    ? `${prompt}\n\n` + imageRefs.map(r => `@${r}`).join("\n")
    : prompt;
  const args = ["-p", fullPrompt, "-o", "text"];
  if (!useFlash) { args.unshift("-m", GEMINI_PRO_MODEL); }
  // Gemini CLI exits 0 even when the API returned 429 (just logs the error to
  // stderr + returns empty stdout). Detect that and treat it as a thrown error
  // so the cycle logic can rotate accounts.
  let stdout = "", stderr = "";
  try {
    const r = await execFile("gemini", args, {
      cwd: QUANTUM_ROOT,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = r.stdout || "";
    stderr = r.stderr || "";
  } catch (e) {
    // execFile rejected (non-zero exit). Read its captured streams.
    stdout = (e.stdout || "").toString();
    stderr = (e.stderr || "").toString();
    if (!stderr) stderr = e.message || "";
  }
  // Quota error in stderr (regardless of exit code) → throw with a quota-shaped
  // message so the outer cycle catches it via GEMINI_QUOTA_RE and rotates.
  if (GEMINI_QUOTA_RE.test(stderr)) {
    const e = new Error(`gemini 429: ${stderr.slice(0, 300)}`);
    e.stderr = stderr;
    throw e;
  }
  // Empty stdout with no quota signal also indicates a soft failure (e.g. safety
  // filter, malformed prompt). Treat as non-quota error → bail out, don't cycle.
  if (!stdout.trim()) {
    throw new Error(`gemini returned empty output. stderr=${stderr.slice(0, 300)}`);
  }
  return stdout.trim();
}

async function runClaude({ prompt, imagePaths }) {
  // claude -p has no workspace sandbox; pass absolute paths inline in prompt.
  const fullPrompt = imagePaths.length > 0
    ? `${prompt}\n\n` + imagePaths.map(p => p).join("\n")
    : prompt;
  const { stdout } = await execFile("claude", ["-p", fullPrompt, "--model", "sonnet"], {
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

// Try gemini across all cached accounts (Pro then Flash on each); on 429 cycle account.
// Returns { engine, account, output } or throws.
async function tryGeminiCycle({ prompt, imageRefs }) {
  const accounts = await listGeminiAccounts();
  if (accounts.length === 0) throw new CloudLLMUnreachable("no gemini accounts cached at ~/.gemini/accounts/");

  const errors = [];
  for (const account of accounts) {
    await rotateGeminiAccount(account);
    for (const useFlash of [false, true]) {
      try {
        const output = await runGemini({ prompt, imageRefs, useFlash });
        return { engine: useFlash ? "gemini-flash" : "gemini-pro", account, output };
      } catch (e) {
        const msg = (e.stderr ? e.stderr.toString() : "") + " " + (e.message || "");
        errors.push(`${account}/${useFlash ? "flash" : "pro"}: ${msg.slice(0, 200)}`);
        if (!GEMINI_QUOTA_RE.test(msg)) {
          // Not a quota error — non-recoverable, bail
          throw new CloudLLMUnreachable(`gemini call failed (non-quota): ${msg.slice(0, 400)}`);
        }
        // quota error — try next (Flash on same account, then next account)
      }
    }
  }
  throw new CloudLLMUnreachable("all gemini accounts exhausted:\n" + errors.join("\n"));
}

// PUBLIC: describe N images. Default engine cycle: gemini → claude.
export async function describeImages(absPaths, prompt, opts = {}) {
  if (!Array.isArray(absPaths) || absPaths.length === 0) throw new Error("describeImages: absPaths must be non-empty array");
  const { stage, staged } = await stageImages(absPaths);
  try {
    try {
      const out = await tryGeminiCycle({ prompt, imageRefs: staged.map(s => s.rel) });
      return out;
    } catch (geminiErr) {
      // fall through to claude
      try {
        const output = await runClaude({ prompt, imagePaths: absPaths });
        return { engine: "claude-sonnet", account: null, output };
      } catch (claudeErr) {
        throw new CloudLLMUnreachable(
          `both engines failed.\nGemini: ${geminiErr.message}\nClaude: ${claudeErr.message}`
        );
      }
    }
  } finally {
    await cleanupStage(stage);
  }
}

// PUBLIC: text-only call. Same fallback chain, no staging.
export async function askText(prompt, opts = {}) {
  try {
    const out = await tryGeminiCycle({ prompt, imageRefs: [] });
    return out;
  } catch (geminiErr) {
    try {
      const output = await runClaude({ prompt, imagePaths: [] });
      return { engine: "claude-sonnet", account: null, output };
    } catch (claudeErr) {
      throw new CloudLLMUnreachable(
        `both engines failed.\nGemini: ${geminiErr.message}\nClaude: ${claudeErr.message}`
      );
    }
  }
}
