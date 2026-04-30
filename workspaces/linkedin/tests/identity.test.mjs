import { test } from "node:test";
import assert from "node:assert/strict";
import { urlOrIdToPublicId, publicIdToUrl, profileToSlug } from "../src/runtime/identity.mjs";
import { toSlug, rawFilename } from "../src/runtime/slug.mjs";

test("urlOrIdToPublicId accepts bare id", () => {
  assert.equal(urlOrIdToPublicId("janedoe"), "janedoe");
});

test("urlOrIdToPublicId accepts /in/ path", () => {
  assert.equal(urlOrIdToPublicId("/in/janedoe"), "janedoe");
});

test("urlOrIdToPublicId accepts full URL with trailing slash and query", () => {
  assert.equal(
    urlOrIdToPublicId("https://www.linkedin.com/in/jane-doe-123/?miniProfile=foo"),
    "jane-doe-123"
  );
});

test("urlOrIdToPublicId returns null for nonsense", () => {
  assert.equal(urlOrIdToPublicId("not a profile at all"), null);
});

test("publicIdToUrl round-trip", () => {
  const id = "jane.doe-123";
  assert.equal(urlOrIdToPublicId(publicIdToUrl(id)), id);
});

test("toSlug strips diacritics + emojis + apostrophes", () => {
  assert.equal(toSlug("Élodie O'Brien 🌸"), "elodie-obrien");
});

test("toSlug clamps length", () => {
  const long = "a".repeat(200);
  assert.ok(toSlug(long).length <= 80);
});

test("rawFilename appends -linkedin.md", () => {
  assert.equal(rawFilename("jane-doe"), "jane-doe-linkedin.md");
});

test("profileToSlug uses name + first company when available", () => {
  const slug = profileToSlug({ firstName: "Jane", lastName: "Doe", experience: [{ companyName: "Acme" }] });
  assert.equal(slug, "jane-doe-acme");
});

test("profileToSlug falls back to publicIdentifier when name missing", () => {
  const slug = profileToSlug({ publicIdentifier: "jane-d-123", experience: [] });
  assert.equal(slug, "jane-d-123");
});
