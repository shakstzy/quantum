// Draft via `claude -p` (Claude Code subscription, no API key needed).
// The voice profile + match context get composed into a single prompt and piped
// to claude headless. stdout is the drafted message text.

import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { loadVoice } from "./voice-loader.mjs";
import { lintDraft } from "./voice-lint.mjs";

const execFile = promisify(_execFile);

const SYSTEM = `You are drafting a single Tinder message in Adithya's voice.

Output: the literal message text only. No quotes, no preamble, no explanation, no emoji unless the voice profile calls for it.

Hard constraints (rejection if violated): no em dashes, max 3 sentences, max 1 exclamation, no looks compliments, no "how was your day" variants, no formal greetings, no AI-tells.`;

function formatBasicsLifestyle(obj) {
  if (!obj || Object.keys(obj).length === 0) return "—";
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(", ");
}

function formatProfileDiff(diff) {
  if (!diff) return null;
  const lines = [];
  for (const [k, v] of Object.entries(diff.added || {})) lines.push(`  she ADDED ${k}: ${JSON.stringify(v)}`);
  for (const [k, { from, to }] of Object.entries(diff.changed || {})) lines.push(`  she CHANGED ${k}: was ${JSON.stringify(from)}, now ${JSON.stringify(to)}`);
  for (const [k, v] of Object.entries(diff.removed || {})) lines.push(`  she REMOVED ${k}: ${JSON.stringify(v)}`);
  return lines.length ? lines.join("\n") : null;
}

function formatVisual(visual) {
  if (!visual || Object.keys(visual).length === 0) return null;
  return Object.entries(visual).map(([k, v]) => `  ${k}: ${v}`).join("\n");
}

function buildPrompt({ context, intent, voice }) {
  const diffBlock = formatProfileDiff(context.profile_diff);
  const visualBlock = formatVisual(context.visual);
  const lines = [
    SYSTEM,
    "",
    "## Voice profile and skills",
    voice,
    "",
    "## Now draft for this match",
    `intent: ${intent}`,
    "",
    "match profile:",
    `  name: ${context.name || "?"}`,
    `  age: ${context.age ?? "?"}`,
    `  bio: ${context.bio || "—"}`,
    `  looking_for: ${context.looking_for || "—"}`,
    `  dream_job: ${context.dream_job || "—"}`,
    `  interests: ${(context.interests || []).join(", ") || "—"}`,
    `  basics: ${formatBasicsLifestyle(context.basics)}`,
    `  lifestyle: ${formatBasicsLifestyle(context.lifestyle)}`,
    `  schools: ${(context.schools || []).join(", ") || "—"}`,
    `  jobs: ${(context.jobs || []).join(", ") || "—"}`,
    "",
  ];
  if (visualBlock) {
    lines.push("visual signal from her photos (NON-FACIAL — settings, props, vibe, activities):");
    lines.push(visualBlock);
    lines.push("Use these signals to anchor the opener on something specific and observable (a place, a prop, an activity, a notable_signal). NEVER reference how she looks, her body, or her face.");
    lines.push("");
  }
  if (diffBlock) {
    lines.push("PROFILE CHANGES SINCE LAST SCRAPE (recent edits she made):");
    lines.push(diffBlock);
    lines.push("If a change is recent and interesting, you MAY anchor the message on it. Don't force it. If she removed something, do not reference what was removed.");
    lines.push("");
  }
  lines.push(
    "thread so far (oldest first; empty if first message):",
    (context.thread || []).map(m => `  ${m.direction === "out" ? "you" : "her"}: ${m.text}`).join("\n") || "  (empty)",
    "",
    "side-channel signal:",
    `  ${context.imessage_summary || "(none)"}`,
    "",
    "Write the next message now. Just the message text, nothing else.",
  );
  return lines.join("\n");
}

export async function draftMessage({ context, intent }) {
  const voice = await loadVoice();
  const prompt = buildPrompt({ context, intent, voice });
  const draftId = randomUUID();

  const { stdout } = await execFile("claude", ["-p", prompt, "--model", process.env.QUANTUM_TINDER_MODEL || "sonnet"], {
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });

  const text = stdout.trim().replace(/^["']|["']$/g, "");
  const lint = lintDraft(text);
  return { draftId, text, lint, intent };
}
