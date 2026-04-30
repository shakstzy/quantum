// Voyager normalized+json+2.1 parser. LinkedIn returns a {data, included} shape where `data`
// has $type'd entity refs and `included` is a flat list of entities keyed by entityUrn.
// Resolving means walking $ref pointers into included to inline real values.
//
// We do NOT try to be a complete deserializer (the Voyager schema is huge). We resolve enough
// to produce stable typed dicts for the verbs we ship: profile, thread, message, invite, connection.

export function indexIncluded(payload) {
  const idx = new Map();
  const included = payload?.included ?? [];
  for (const item of included) {
    if (item?.entityUrn) idx.set(item.entityUrn, item);
    if (item?.["*entityUrn"]) idx.set(item["*entityUrn"], item);
  }
  return idx;
}

export function resolveRef(ref, idx, depth = 0) {
  if (!ref || typeof ref !== "string" || depth > 6) return ref;
  return idx.get(ref) ?? ref;
}

// --- Profile ----------------------------------------------------------

export function extractProfile(payload) {
  const idx = indexIncluded(payload);
  const data = payload?.data ?? {};
  const entityUrn = data.entityUrn ?? data["*entityUrn"];
  // Voyager returns a profile_view collection; look for fsd_profile in included.
  let profile = null;
  for (const v of idx.values()) {
    if (v?.$type === "com.linkedin.voyager.dash.identity.profile.Profile" || v?.$type === "com.linkedin.voyager.identity.profile.Profile") {
      profile = v;
      break;
    }
  }
  // Fallback: data may already be the profile entity.
  profile = profile ?? data;

  const out = {
    urn: profile.entityUrn ?? entityUrn ?? null,
    publicIdentifier: profile.publicIdentifier ?? profile.publicId ?? null,
    firstName: profile.firstName ?? null,
    lastName: profile.lastName ?? null,
    headline: profile.headline ?? null,
    summary: profile.summary ?? null,
    locationName: profile.locationName ?? profile.geoLocationName ?? null,
    countryCode: profile.geoCountryUrn ?? profile.locationCountry ?? null,
    industryName: profile.industryName ?? null,
    profileUrl: profile.publicIdentifier ? `https://www.linkedin.com/in/${profile.publicIdentifier}/` : null,
    raw: profile,
  };
  out.fullName = [out.firstName, out.lastName].filter(Boolean).join(" ").trim() || null;
  out.experience = extractExperience(profile, idx);
  return out;
}

function extractExperience(profile, idx) {
  const refs = profile?.profilePositionGroupsResolution
    ?? profile?.profilePositionGroups
    ?? profile?.experienceResolutionResult
    ?? [];
  const out = [];
  if (Array.isArray(refs)) {
    for (const r of refs) {
      const item = typeof r === "string" ? resolveRef(r, idx) : r;
      if (!item || typeof item !== "object") continue;
      out.push({
        companyName: item?.companyName ?? item?.miniCompany?.name ?? null,
        title: item?.title ?? item?.name ?? null,
        timePeriod: item?.timePeriod ?? null,
      });
    }
  }
  return out;
}

// --- Thread / message -------------------------------------------------

export function extractThreads(payload) {
  const idx = indexIncluded(payload);
  const out = [];
  for (const v of idx.values()) {
    if (v?.$type !== "com.linkedin.voyager.dash.messaging.Conversation"
        && v?.$type !== "com.linkedin.messaging.Conversation") continue;
    const lastMessage = v?.lastMessage ?? null;
    const msg = typeof lastMessage === "string" ? resolveRef(lastMessage, idx) : lastMessage;
    out.push({
      conversationUrn: v.entityUrn,
      title: v?.title ?? null,
      participantUrns: (v?.participants ?? []).map((p) => (typeof p === "string" ? p : p?.entityUrn)).filter(Boolean),
      lastActivityAt: v?.lastActivityAt ?? msg?.deliveredAt ?? null,
      unreadCount: v?.unreadCount ?? 0,
      lastMessagePreview: msg?.body?.text ?? null,
    });
  }
  return out.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

export function extractMessages(payload) {
  const idx = indexIncluded(payload);
  const out = [];
  for (const v of idx.values()) {
    if (v?.$type !== "com.linkedin.voyager.dash.messaging.Message"
        && v?.$type !== "com.linkedin.messaging.MessageEvent") continue;
    out.push({
      messageUrn: v.entityUrn,
      conversationUrn: v?.conversationUrn ?? null,
      senderUrn: v?.sender?.entityUrn ?? v?.fromParticipant?.entityUrn ?? null,
      text: v?.body?.text ?? v?.eventContent?.attributedBody?.text ?? null,
      deliveredAt: v?.deliveredAt ?? v?.createdAt ?? null,
    });
  }
  return out.sort((a, b) => (a.deliveredAt ?? 0) - (b.deliveredAt ?? 0));
}

// --- Invitations / connections ---------------------------------------

export function extractInvitations(payload) {
  const idx = indexIncluded(payload);
  const out = [];
  for (const v of idx.values()) {
    if (v?.$type !== "com.linkedin.voyager.dash.relationships.invitation.Invitation"
        && v?.$type !== "com.linkedin.voyager.relationships.invitation.Invitation"
        && v?.$type !== "com.linkedin.voyager.relationships.invitation.MailboxItem") continue;
    out.push({
      invitationUrn: v.entityUrn,
      sharedSecret: v?.sharedSecret ?? null,
      inviterUrn: v?.fromMember?.entityUrn ?? v?.inviter?.entityUrn ?? null,
      inviteeUrn: v?.toMember?.entityUrn ?? null,
      sentAt: v?.sentTime ?? v?.createdAt ?? null,
      message: v?.customMessage ?? null,
      type: v?.invitationType ?? null,
    });
  }
  return out;
}

export function extractConnections(payload) {
  const idx = indexIncluded(payload);
  const out = [];
  for (const v of idx.values()) {
    if (v?.$type !== "com.linkedin.voyager.dash.relationships.MemberRelationship"
        && v?.$type !== "com.linkedin.voyager.relationships.Connection") continue;
    out.push({
      memberRelationshipUrn: v.entityUrn,
      connectedAt: v?.createdAt ?? null,
      connectionUrn: v?.miniProfile?.entityUrn ?? v?.profile?.entityUrn ?? null,
      publicIdentifier: v?.miniProfile?.publicIdentifier ?? v?.profile?.publicIdentifier ?? null,
      firstName: v?.miniProfile?.firstName ?? null,
      lastName: v?.miniProfile?.lastName ?? null,
      headline: v?.miniProfile?.occupation ?? v?.miniProfile?.headline ?? null,
    });
  }
  return out;
}
