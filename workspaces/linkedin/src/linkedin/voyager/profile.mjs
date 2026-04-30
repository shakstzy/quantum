// Voyager profile reads. Endpoints chosen for browser-equivalent shape (the same calls Web
// LinkedIn fires when you visit /in/<id>).

import { extractProfile } from "./parse.mjs";
import { urlOrIdToPublicId, publicIdToUrl } from "../../runtime/identity.mjs";
import { ProfileInaccessibleError } from "../../runtime/exceptions.mjs";

// Self-profile: derived from /me redirect. The Web app reads `identity/dash/profiles?q=memberIdentity`.
export async function getSelfProfile(client) {
  const r = await client.get("/identity/dash/profiles", {
    params: { q: "memberIdentity", memberIdentity: "me", decorationId: "com.linkedin.voyager.dash.deco.identity.profile.FullProfile-150" },
    endpoint: "self_profile",
  });
  return extractProfile(r);
}

// Profile by public_id (or URL).
export async function getProfile(client, idOrUrl) {
  const publicId = urlOrIdToPublicId(idOrUrl);
  if (!publicId) throw new Error(`Cannot derive public_id from: ${idOrUrl}`);
  const r = await client.get("/identity/dash/profiles", {
    params: {
      q: "memberIdentity",
      memberIdentity: publicId,
      decorationId: "com.linkedin.voyager.dash.deco.identity.profile.FullProfile-150",
    },
    endpoint: "profile_by_public_id",
  });
  if (r._status === 404) {
    throw new ProfileInaccessibleError(`Profile not found: ${publicId}`, { publicId, status: 404 });
  }
  const out = extractProfile(r);
  if (!out.publicIdentifier) out.publicIdentifier = publicId;
  if (!out.profileUrl) out.profileUrl = publicIdToUrl(publicId);
  return out;
}

// Contact info (email/phone if the user shared it). Separate Voyager call.
export async function getContactInfo(client, publicId) {
  const r = await client.get(`/identity/profiles/${encodeURIComponent(publicId)}/profileContactInfo`, {
    endpoint: "profile_contact_info",
  });
  const ci = r?.data ?? {};
  return {
    publicIdentifier: publicId,
    emailAddress: ci?.emailAddress ?? null,
    phoneNumbers: (ci?.phoneNumbers ?? []).map((p) => ({ number: p?.number ?? null, type: p?.type ?? null })),
    twitterHandles: (ci?.twitterHandles ?? []).map((t) => t?.name ?? null).filter(Boolean),
    websites: (ci?.websites ?? []).map((w) => ({ url: w?.url ?? null, label: w?.label ?? null })),
  };
}
