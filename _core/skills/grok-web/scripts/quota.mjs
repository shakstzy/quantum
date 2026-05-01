// quota.mjs -- normalize grok.com rate-limit signals into a single shape.
//
// Two paths:
//  1. /api/rate-limits style JSON (observed via public Grok rate-limit
//     extensions): { remainingQueries, totalQueries, windowSizeSeconds,
//     waitTimeSeconds, highEffortRateLimits, lowEffortRateLimits }.
//  2. HTTP 429 with optional Retry-After header (seconds or HTTP-date).
//
// Output shape (consumer-friendly):
//   {
//     ok: bool,                  // true if request can proceed now
//     remaining: number | null,
//     total: number | null,
//     windowSeconds: number | null,
//     waitSeconds: number | null,    // seconds until the oldest request rolls off
//     resetAt: ISO string | null,    // absolute UTC time when waitSeconds expires
//     effort: 'high' | 'low' | null, // which bucket this object describes
//     reason: string | null,         // 'rate-limited' | '429' | null
//     raw: object                    // original JSON for debugging
//   }

export function parseRateLimitJSON(json, { effort = null } = {}) {
  if (!json || typeof json !== 'object') {
    return makeResult({ ok: true, raw: json });
  }

  // High/low effort wrapper: prefer the explicitly requested effort, else
  // pick the worst-off bucket so the caller defaults to safety.
  if (json.highEffortRateLimits || json.lowEffortRateLimits) {
    const high = json.highEffortRateLimits || null;
    const low = json.lowEffortRateLimits || null;
    if (effort === 'high' && high) return parseRateLimitJSON(high, { effort: 'high' });
    if (effort === 'low' && low) return parseRateLimitJSON(low, { effort: 'low' });
    const candidates = [high, low].filter(Boolean).map(b => parseRateLimitJSON(b, { effort: b === high ? 'high' : 'low' }));
    if (!candidates.length) return makeResult({ ok: true, raw: json });
    candidates.sort((a, b) => (a.remaining ?? 0) - (b.remaining ?? 0));
    const worst = candidates[0];
    return { ...worst, raw: json };
  }

  const remaining = numOrNull(json.remainingQueries);
  const total = numOrNull(json.totalQueries);
  const windowSeconds = numOrNull(json.windowSizeSeconds);
  const waitSeconds = numOrNull(json.waitTimeSeconds);
  const ok = remaining == null ? true : remaining > 0;
  const reason = ok ? null : 'rate-limited';
  const resetAt = waitSeconds != null && waitSeconds > 0
    ? new Date(Date.now() + waitSeconds * 1000).toISOString()
    : null;

  return makeResult({ ok, remaining, total, windowSeconds, waitSeconds, resetAt, effort, reason, raw: json });
}

export function parse429Response({ status, headers = {}, body = null } = {}) {
  if (status !== 429) {
    return makeResult({ ok: true, raw: { status, headers, body } });
  }
  const retryAfterRaw = pickHeader(headers, 'retry-after');
  let waitSeconds = null;
  if (retryAfterRaw != null) {
    const asNum = Number(retryAfterRaw);
    if (Number.isFinite(asNum) && asNum >= 0) {
      waitSeconds = asNum;
    } else {
      const ts = Date.parse(String(retryAfterRaw));
      if (!Number.isNaN(ts)) {
        waitSeconds = Math.max(0, Math.round((ts - Date.now()) / 1000));
      }
    }
  }
  // Try to enrich with body-side fields (some 429 responses include the
  // same /api/rate-limits shape inline).
  let bodyParse = null;
  if (body && typeof body === 'object') {
    bodyParse = parseRateLimitJSON(body);
  }
  return makeResult({
    ok: false,
    reason: '429',
    waitSeconds: waitSeconds ?? bodyParse?.waitSeconds ?? null,
    remaining: bodyParse?.remaining ?? 0,
    total: bodyParse?.total ?? null,
    windowSeconds: bodyParse?.windowSeconds ?? null,
    resetAt: waitSeconds != null && waitSeconds > 0
      ? new Date(Date.now() + waitSeconds * 1000).toISOString()
      : (bodyParse?.resetAt ?? null),
    effort: bodyParse?.effort ?? null,
    raw: { status, headers, body }
  });
}

function makeResult(partial) {
  return {
    ok: partial.ok ?? true,
    remaining: partial.remaining ?? null,
    total: partial.total ?? null,
    windowSeconds: partial.windowSeconds ?? null,
    waitSeconds: partial.waitSeconds ?? null,
    resetAt: partial.resetAt ?? null,
    effort: partial.effort ?? null,
    reason: partial.reason ?? null,
    raw: partial.raw ?? null
  };
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickHeader(headers, name) {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return null;
}
