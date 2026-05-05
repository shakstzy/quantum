// public_id <-> profile URL <-> URN <-> slug helpers.
// Canonical forms per QUANTUM raw-deposit rule.

import { toSlug } from "./slug.mjs";

const PROFILE_URL_RE = /^https?:\/\/(?:www\.)?linkedin\.com\/in\/([^/?#]+)/i;

// Strictly validate a decoded public_id. LinkedIn vanities are alphanumeric + . _ -.
// User input flows into CSS selectors; anything outside this class is a bug or injection.
function validPublicId(s) {
  return typeof s === "string" && /^[A-Za-z0-9._-]+$/.test(s);
}

// Accepts: "janedoe", "/in/janedoe", "https://linkedin.com/in/janedoe/", "https://www.linkedin.com/in/janedoe?foo=bar".
// Returns the bare public_id (no slashes) or null.
export function urlOrIdToPublicId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(PROFILE_URL_RE);
  if (m) {
    const id = decodeURIComponent(m[1]);
    return validPublicId(id) ? id : null;
  }
  if (s.startsWith("/in/")) {
    const id = decodeURIComponent(s.slice(4).split(/[?#/]/)[0]);
    return validPublicId(id) ? id : null;
  }
  return validPublicId(s) ? s : null;
}

export { validPublicId };

export function publicIdToUrl(publicId) {
  return `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`;
}

// Build a slug from a profile dict. Prefers full name + first company.
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
