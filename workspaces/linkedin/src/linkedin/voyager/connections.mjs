// Voyager connections. Invitations + connection list + pending counts.

import { extractInvitations, extractConnections } from "./parse.mjs";

const PENDING_DECO = "com.linkedin.voyager.dash.deco.relationships.PendingInvitations-15";
const SENT_DECO = "com.linkedin.voyager.dash.deco.relationships.SentInvitations-15";

export async function listPendingInvites(client, { direction = "received", limit = 50 } = {}) {
  // direction: received | sent
  const params = direction === "sent"
    ? { q: "invitationType", invitationType: "CONNECTION", facetInvitationType: "List(SENT_INVITATIONS)", count: String(limit), decorationId: SENT_DECO }
    : { q: "invitationType", invitationType: "CONNECTION", facetInvitationType: "List(PENDING_INVITATIONS)", count: String(limit), decorationId: PENDING_DECO };
  const r = await client.get("/relationships/dash/invitations", { params, endpoint: `list_invites_${direction}` });
  return extractInvitations(r);
}

export async function pendingSentCount(client) {
  // Cheap header-only count: ask for 1 and read paging.total.
  const r = await client.get("/relationships/dash/invitations", {
    params: { q: "invitationType", invitationType: "CONNECTION", facetInvitationType: "List(SENT_INVITATIONS)", count: "1", decorationId: SENT_DECO },
    endpoint: "pending_sent_count",
  });
  return r?.paging?.total ?? r?.data?.paging?.total ?? null;
}

export async function acceptInvite(client, { invitationUrn, sharedSecret }) {
  const id = invitationUrn.split(":").pop();
  const r = await client.post(`/relationships/invitations/${encodeURIComponent(id)}?action=accept`, {
    body: JSON.stringify({ sharedSecret, isGenericInvitation: false }),
    endpoint: "accept_invite",
    headers: { "content-type": "application/json" },
  });
  return r;
}

export async function ignoreInvite(client, { invitationUrn, sharedSecret }) {
  const id = invitationUrn.split(":").pop();
  const r = await client.post(`/relationships/invitations/${encodeURIComponent(id)}?action=ignore`, {
    body: JSON.stringify({ sharedSecret, isGenericInvitation: false }),
    endpoint: "ignore_invite",
    headers: { "content-type": "application/json" },
  });
  return r;
}

export async function withdrawInvite(client, { invitationUrn }) {
  const id = invitationUrn.split(":").pop();
  const r = await client.post(`/relationships/invitations/${encodeURIComponent(id)}?action=withdraw`, {
    body: JSON.stringify({}),
    endpoint: "withdraw_invite",
    headers: { "content-type": "application/json" },
  });
  return r;
}

export async function listConnections(client, { start = 0, count = 100, sort = "RECENTLY_ADDED" } = {}) {
  const r = await client.get("/relationships/dash/connections", {
    params: { decorationId: "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16", q: "search", start: String(start), count: String(count), sortType: sort },
    endpoint: "list_connections",
  });
  return extractConnections(r);
}
