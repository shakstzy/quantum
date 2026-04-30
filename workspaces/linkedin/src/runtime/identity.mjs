// public_id <-> profile URL <-> URN <-> slug helpers.
// Canonical forms per QUANTUM raw-deposit rule.

import { toSlug } from "./slug.mjs";

const PROFILE_URL_RE = /^https?:\/\/(?:www\.)?linkedin\.com\/in\/([^/?#]+)/i;
const URN_RE = /^urn:li:fsd_profile:([A-Za-z0-9_-]+)$/;

// Accepts: "janedoe", "/in/janedoe", "https://linkedin.com/in/janedoe/", "https://www.linkedin.com/in/janedoe?foo=bar".
// Returns the bare public_id (no slashes) or null.
export function urlOrIdToPublicId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(PROFILE_URL_RE);
  if (m) return decodeURIComponent(m[1]);
  if (s.startsWith("/in/")) return s.slice(4).split(/[?#/]/)[0];
  if (/^[A-Za-z0-9._-]+$/.test(s)) return s;
  return null;
}

export function publicIdToUrl(publicId) {
  return `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`;
}

export function isFsdProfileUrn(urn) {
  return typeof urn === "string" && URN_RE.test(urn);
}

// Voyager messaging URNs are URL-encoded twice in some endpoints. Encode once here; callers can
// double-encode when an endpoint requires it.
export function encodeUrn(urn) {
  return encodeURIComponent(urn);
}

// Build a slug from a Voyager profile dict. Prefers full name + first company.
export function profileToSlug(profile) {
  const first = profile?.firstName ?? "";
  const last = profile?.lastName ?? "";
  const name = `${first} ${last}`.trim();
  const company =
    profile?.experience?.[0]?.companyName ??
    profile?.headline?.split(/\s+at\s+/i)?.[1] ??
    "";
  const parts = [name, company].filter(Boolean);
  if (parts.length === 0) return toSlug(profile?.publicIdentifier ?? "unknown");
  return toSlug(parts.join(" "));
}
