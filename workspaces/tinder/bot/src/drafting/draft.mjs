import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { loadVoice } from "./voice-loader.mjs";
import { lintDraft } from "./voice-lint.mjs";

const MODEL = process.env.QUANTUM_TINDER_MODEL || "claude-sonnet-4-6";

const client = new Anthropic();

function systemBlocks(voice) {
  return [
    {
      type: "text",
      text: "You are drafting a single Tinder message in Adithya's voice. You write the message, nothing else. No quotes, no preamble, no explanation. Output is the literal message text only.",
    },
    {
      type: "text",
      text: "Voice profile and playbooks below. Follow them strictly. Hard constraints: no em dashes, max 3 sentences, max 1 exclamation, no looks compliments, no 'how was your day' variants, no AI-tells, no formal greetings.\n\n" + voice,
      cache_control: { type: "ephemeral" },
    },
  ];
}

function buildUserPrompt({ context, intent }) {
  return [
    "## Context",
    `Intent: ${intent}`,
    "",
    "## Match profile",
    `name: ${context.name || "?"}`,
    `age: ${context.age ?? "?"}`,
    `bio: ${context.bio || "—"}`,
    `interests: ${(context.interests || []).join(", ") || "—"}`,
    `schools: ${(context.schools || []).join(", ") || "—"}`,
    `jobs: ${(context.jobs || []).join(", ") || "—"}`,
    "",
    "## Thread so far (oldest first; empty if first message)",
    (context.thread || []).map(m => `${m.direction === "out" ? "you" : "her"}: ${m.text}`).join("\n") || "(empty)",
    "",
    "## Side-channel signal",
    context.imessage_summary || "(none)",
    "",
    "Write the next message now. Just the message text.",
  ].join("\n");
}

export async function draftMessage({ context, intent }) {
  const voice = await loadVoice();
  const draftId = randomUUID();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: systemBlocks(voice),
    messages: [{ role: "user", content: buildUserPrompt({ context, intent }) }],
  });
  const text = resp.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("")
    .trim()
    .replace(/^["']|["']$/g, "");
  const lint = lintDraft(text);
  return {
    draftId,
    text,
    lint,
    model: MODEL,
    usage: resp.usage,
    intent,
  };
}
