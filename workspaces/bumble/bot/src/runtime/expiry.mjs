// Bumble-specific: 24-hour match-expiry tracking.
//
// Bumble's rule (verified via help docs 2026-05):
//   - When two users match, the woman has 24h to send the first message (or it expires).
//   - If she sends the opener, the man has 24h to reply (or it expires).
//   - "Opening Moves" and Extend can change the timer; we record what we observed.
//
// `decide.mjs` triages by `time_to_expiry`, NOT by recency. A 5-minute-old match
// with 23h57m left is lower priority than a 22h-old match with 1h59m left.
//
// State is stored in entity frontmatter as `expires_at` (ISO-8601). This module
// computes when to refresh, and what triage bucket each match falls into.

const HOUR_MS = 3600 * 1000;

export function expiryTriage(expiresAtISO, { now = Date.now() } = {}) {
  if (!expiresAtISO) return { bucket: "unknown", hoursLeft: null };
  const ts = new Date(expiresAtISO).getTime();
  if (Number.isNaN(ts)) return { bucket: "unknown", hoursLeft: null };
  const ms = ts - now;
  const hoursLeft = ms / HOUR_MS;
  if (hoursLeft <= 0) return { bucket: "expired", hoursLeft };
  if (hoursLeft <= 1) return { bucket: "critical", hoursLeft };
  if (hoursLeft <= 4) return { bucket: "high", hoursLeft };
  if (hoursLeft <= 12) return { bucket: "medium", hoursLeft };
  return { bucket: "low", hoursLeft };
}

// Sort matches by expiry urgency: critical -> high -> medium -> low -> unknown.
// Within a bucket, earliest expiry first.
const BUCKET_ORDER = ["critical", "high", "medium", "low", "unknown", "expired"];
export function sortByExpiry(items, getExpires = (i) => i.meta?.expires_at) {
  return [...items].sort((a, b) => {
    const ta = expiryTriage(getExpires(a));
    const tb = expiryTriage(getExpires(b));
    const ai = BUCKET_ORDER.indexOf(ta.bucket);
    const bi = BUCKET_ORDER.indexOf(tb.bucket);
    if (ai !== bi) return ai - bi;
    return (ta.hoursLeft ?? Infinity) - (tb.hoursLeft ?? Infinity);
  });
}

// Parses Bumble's "X hours left" / "23 hours left" / "<1h left" string forms
// from an expiry indicator we observe in the DOM. Selector lives in
// config/selectors.json under `match_expiry_indicator` (filled post-discovery).
export function parseExpiryIndicatorText(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  // <1h forms
  if (/<\s*1\s*h/.test(t) || /less than (an?|1) hour/.test(t)) return { hoursLeft: 0.5 };
  // "X hours" or "X hr"
  let m = t.match(/(\d+)\s*(?:hours?|hrs?|h)/);
  if (m) return { hoursLeft: parseInt(m[1], 10) };
  // "X minutes" or "X min"
  m = t.match(/(\d+)\s*(?:minutes?|mins?|m)\b/);
  if (m) return { hoursLeft: parseInt(m[1], 10) / 60 };
  // "Expired" / "expires soon"
  if (/expired/.test(t)) return { hoursLeft: 0 };
  return null;
}
