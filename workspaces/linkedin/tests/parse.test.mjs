import { test } from "node:test";
import assert from "node:assert/strict";
import { extractProfile, extractThreads, extractMessages, extractInvitations, extractConnections, indexIncluded, resolveRef } from "../src/linkedin/voyager/parse.mjs";

test("indexIncluded keys by entityUrn", () => {
  const idx = indexIncluded({
    included: [
      { entityUrn: "urn:li:fsd_profile:abc", firstName: "Jane" },
      { entityUrn: "urn:li:fsd_profile:def", firstName: "John" },
    ],
  });
  assert.equal(idx.size, 2);
  assert.equal(idx.get("urn:li:fsd_profile:abc").firstName, "Jane");
});

test("resolveRef returns string when not in index", () => {
  const idx = new Map();
  assert.equal(resolveRef("urn:li:nope", idx), "urn:li:nope");
});

test("extractProfile pulls fsd_profile from included", () => {
  const payload = {
    data: { entityUrn: "urn:li:fsd_profile:abc" },
    included: [
      {
        $type: "com.linkedin.voyager.dash.identity.profile.Profile",
        entityUrn: "urn:li:fsd_profile:abc",
        firstName: "Jane",
        lastName: "Doe",
        headline: "Founder at Acme",
        publicIdentifier: "janedoe",
      },
    ],
  };
  const p = extractProfile(payload);
  assert.equal(p.fullName, "Jane Doe");
  assert.equal(p.headline, "Founder at Acme");
  assert.equal(p.publicIdentifier, "janedoe");
});

test("extractThreads sorts by lastActivityAt desc", () => {
  const payload = {
    included: [
      { $type: "com.linkedin.voyager.dash.messaging.Conversation", entityUrn: "urn:li:msg:1", lastActivityAt: 100, participants: [] },
      { $type: "com.linkedin.voyager.dash.messaging.Conversation", entityUrn: "urn:li:msg:2", lastActivityAt: 200, participants: [] },
    ],
  };
  const t = extractThreads(payload);
  assert.equal(t[0].conversationUrn, "urn:li:msg:2");
  assert.equal(t[1].conversationUrn, "urn:li:msg:1");
});

test("extractMessages returns chronological", () => {
  const payload = {
    included: [
      { $type: "com.linkedin.voyager.dash.messaging.Message", entityUrn: "urn:li:msg:b", deliveredAt: 200, body: { text: "second" } },
      { $type: "com.linkedin.voyager.dash.messaging.Message", entityUrn: "urn:li:msg:a", deliveredAt: 100, body: { text: "first" } },
    ],
  };
  const m = extractMessages(payload);
  assert.equal(m[0].text, "first");
  assert.equal(m[1].text, "second");
});

test("extractInvitations picks Invitation entities", () => {
  const payload = {
    included: [
      { $type: "com.linkedin.voyager.dash.relationships.invitation.Invitation", entityUrn: "urn:li:inv:1", sharedSecret: "secret-1", sentTime: 12345 },
      { $type: "com.linkedin.voyager.dash.identity.profile.Profile", entityUrn: "urn:li:fsd_profile:abc" },
    ],
  };
  const invs = extractInvitations(payload);
  assert.equal(invs.length, 1);
  assert.equal(invs[0].sharedSecret, "secret-1");
});

test("extractConnections returns memberRelationships", () => {
  const payload = {
    included: [
      { $type: "com.linkedin.voyager.dash.relationships.MemberRelationship", entityUrn: "urn:li:mr:1", createdAt: 999, miniProfile: { publicIdentifier: "jane" } },
    ],
  };
  const cs = extractConnections(payload);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].publicIdentifier, "jane");
});
