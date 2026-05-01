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
// Staging lives inside the skill itself (NOT raw/) so gemini's .gitignore-respect
// behavior doesn't filter out the staged image files. raw/* is gitignored so any
// path under raw/ would be skipped by gemini at file-read time.
const STAGING_DIR = resolve(QUANTUM_ROOT, "_core/skills/cloud-llm/.staging");
const GEMINI_ACCOUNTS_DIR = resolve(homedir(), ".gemini/accounts");
const GEMINI_ACTIVE_CREDS = resolve(homedir(), ".gemini/oauth_creds.json");
const GEMINI_PRO_MODEL = "gemini-3-pro-preview";

export class CloudLLMUnreachable extends Error {
  constructor(message) { super(message); this.name = "CloudLLMUnreachable"; }
}

// Priority order. Avery is the Workspace AI Ultra plan (effectively unlimited
// quota), so always try it first. The two adithya@ accounts are personal AI
// Ultra and serve as backup. Anything else found on disk falls in alphabetical
// after the priority list.
const GEMINI_ACCOUNT_PRIORITY = ["avery@seedboxlabs.co", "adithya@outerscope.xyz", "adithya@eclipse.builders"];

async function listGeminiAccounts() {
  try {
    const files = await readdir(GEMINI_ACCOUNTS_DIR);
    const found = new Set(files.filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, "")));
    const ordered = [];
    for (const acct of GEMINI_ACCOUNT_PRIORITY) {
      if (found.has(acct)) { ordered.push(acct); found.delete(acct); }
    }
    for (const acct of [...found].sort()) ordered.push(acct);
    return ordered;
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
// Gemini sometimes apologizes IN-BAND when the workspace sandbox blocks a file
// read (gitignore / geminiignore / outside-cwd). It still produces structurally
// valid bullets, so the agentic-chatter check above misses it. Match on the
// apology phrasing directly so we throw and fall back to claude.
const GEMINI_ACCESS_ERROR_RE = /\b(image inaccessible|images? (?:are|is) inaccessible|cannot access (?:the )?(?:image|file)|could not access (?:the )?(?:image|file)|unable to (?:read|access) (?:the )?(?:image|file)|configured ignore patterns?|\.gemini ?ignore|skipped due to (?:gitignore|gemini ?ignore)|move the file to a non-ignored)/i;
// One more failure shape: gemini returns the bullet template fully filled with
// "(none observed)" everywhere — that means it answered without seeing any
// image (sandbox blocked silently, or no images attached). Treat as failure.
function allBulletsEmpty(text) {
  const bullets = text.match(/^[-*]\s+\w+:\s*(.*)$/gm) || [];
  if (bullets.length < 5) return false; // not the structured response we asked for
  const filled = bullets.filter(b => {
    const m = b.match(/^[-*]\s+\w+:\s*(.*)$/);
    const v = (m && m[1] ? m[1].trim().toLowerCase() : "");
    return v && v !== "(none observed)" && v !== "none observed" && v !== "none";
  });
  return filled.length === 0;
}

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
  // Detect gemini's "agentic chatter" output — when the CLI couldn't access the
  // file and emits its own internal reasoning instead of completing the task.
  // Heuristic: leading "I will" / "I am" / "I'll" lines without any bullets.
  const trimmed = stdout.trim();
  const looksAgentic = /^(I will|I am|I'll|I need to|I'd|Let me|Looking at|I notice)/i.test(trimmed);
  const hasBullets = /^[-*]\s+\w+:/m.test(trimmed);
  if (looksAgentic && !hasBullets) {
    throw new Error(`gemini returned agentic chatter (likely ignored file). first 200 chars: ${trimmed.slice(0, 200)}`);
  }
  // Detect gemini's "I could not read this file" error embedded INSIDE bullet
  // values (it complies with format but stuffs the apology into one field).
  // Seen wild: "Image inaccessible due to configured ignore patterns (.gitignore
  // or .geminiignore). Please move the file to a non-ignored directory ..."
  // Fall through to claude when this happens.
  if (GEMINI_ACCESS_ERROR_RE.test(trimmed)) {
    throw new Error(`gemini reported file-access error in output (likely sandbox or ignore-pattern issue). first 250 chars: ${trimmed.slice(0, 250)}`);
  }
  if (allBulletsEmpty(trimmed)) {
    throw new Error(`gemini returned all-empty bullet template (likely never saw any image). falling back to claude.`);
  }
  return trimmed;
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
