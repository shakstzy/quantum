// Voyager messaging. Backed by /voyagerMessagingDashMessenger* endpoints (the Web Messenger).

import { randomUUID, randomBytes } from "node:crypto";
import { extractThreads, extractMessages } from "./parse.mjs";
import { encodeUrn } from "../../runtime/identity.mjs";

export async function listThreads(client, { limit = 20 } = {}) {
  const r = await client.get("/voyagerMessagingDashMessengerConversations", {
    params: { q: "syncToken", count: String(limit) },
    endpoint: "list_threads",
  });
  return extractThreads(r);
}

export async function getThread(client, conversationUrn, { limit = 50 } = {}) {
  const enc = encodeUrn(conversationUrn);
  const r = await client.get("/voyagerMessagingDashMessengerMessages", {
    params: { q: "messages", conversationUrn: enc, count: String(limit) },
    endpoint: "get_thread",
  });
  return extractMessages(r);
}

export async function sendMessage(client, { conversationUrn, mailboxUrn, text }) {
  const originToken = randomUUID();
  const trackingId = randomBytes(16).toString("hex");
  const payload = {
    message: {
      body: { attributes: [], text },
      renderContentUnions: [],
      conversationUrn,
      originToken,
    },
    mailboxUrn,
    trackingId,
    dedupeByClientGeneratedToken: false,
  };
  const r = await client.post("/voyagerMessagingDashMessengerMessages?action=createMessage", {
    body: JSON.stringify(payload),
    endpoint: "send_message",
  });
  return r;
}

export async function markThreadRead(client, conversationUrn) {
  const payload = { patch: { $set: { read: true } } };
  const r = await client.post(`/voyagerMessagingDashMessengerConversations/${encodeURIComponent(conversationUrn)}`, {
    body: JSON.stringify(payload),
    endpoint: "mark_thread_read",
    headers: { "content-type": "application/json" },
  });
  return r;
}

// New-thread compose without an existing conversationUrn. Falls back to navigating to
// /messaging/thread/new/?recipient=<urn> and using the DOM (when Voyager rejects createConversation
// for non-connections / out-of-network targets).
export async function findOrCreateConversation(client, page, { targetUrn, mailboxUrn, text }) {
  // First attempt: use createConversation Voyager action.
  const payload = {
    message: { body: { attributes: [], text }, renderContentUnions: [], originToken: randomUUID() },
    recipients: [targetUrn],
    mailboxUrn,
    trackingId: randomBytes(16).toString("hex"),
  };
  const r = await client.post(
    "/voyagerMessagingDashMessengerMessages?action=createMessage",
    { body: JSON.stringify(payload), endpoint: "create_conversation" }
  );
  if (r?._status >= 200 && r?._status < 300) {
    const convUrn = r?.value?.conversationUrn ?? r?.data?.conversationUrn ?? null;
    return { conversationUrn: convUrn, viaApi: true };
  }
  // Fallback: open the new-thread URL in the browser. Caller will use DOM compose.
  await page.goto(`https://www.linkedin.com/messaging/thread/new/?recipient=${encodeURIComponent(targetUrn)}`, {
    waitUntil: "domcontentloaded",
  });
  return { conversationUrn: null, viaApi: false, dom: true };
}
