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

function buildPrompt({ context, intent, voice }) {
  return [
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
    `  interests: ${(context.interests || []).join(", ") || "—"}`,
    `  schools: ${(context.schools || []).join(", ") || "—"}`,
    `  jobs: ${(context.jobs || []).join(", ") || "—"}`,
    "",
    "thread so far (oldest first; empty if first message):",
    (context.thread || []).map(m => `  ${m.direction === "out" ? "you" : "her"}: ${m.text}`).join("\n") || "  (empty)",
    "",
    "side-channel signal:",
    `  ${context.imessage_summary || "(none)"}`,
    "",
    "Write the next message now. Just the message text, nothing else.",
  ].join("\n");
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
