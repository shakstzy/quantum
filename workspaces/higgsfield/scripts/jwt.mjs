// jwt.mjs -- capture a live Clerk JWT from the page's own outgoing requests.
// higgsfield uses @clerk/nextjs v5, which keeps Clerk in React context (not on window).
// So we piggyback on the page's own network activity: any request that goes out with
// "Authorization: Bearer ..." is using a freshly-refreshed Clerk JWT. We capture the
// most recent one and use it for our own calls.

const KNOWN_API_HOSTS = new Set(['fnf.higgsfield.ai', 'notification.higgsfield.ai']);

// Attach a capture listener to the context (not page) so it survives navigations.
// Caller stores the returned object and reads .token whenever a fresh token is needed.
// Headers that DataDome's client-side JS injects on outgoing fetches. We replay these
// on our own page.request.post calls so the backend sees the same fingerprint.
const DATADOME_HEADER_PATTERNS = [/^x-datadome/i, /^x-dd-/i, /^x-higgsfield/i];

export function attachJwtCapture(context) {
  const state = {
    token: null,
    capturedAt: 0,
    captureCount: 0,
    // Most recent full header set observed on a POST to fnf.higgsfield.ai
    // (POST headers are the gold standard — they'll match what submitJob needs).
    lastPostHeaders: null,
    lastPostCapturedAt: 0,
    // Same but any method — fallback if we never see a POST.
    lastAnyHeaders: null,
    lastAnyCapturedAt: 0
  };
  context.on('request', req => {
    try {
      const url = req.url();
      const u = new URL(url);
      if (!KNOWN_API_HOSTS.has(u.hostname)) return;
      const headers = req.headers();
      const auth = headers['authorization'] || headers['Authorization'];
      if (auth && auth.startsWith('Bearer ') && auth.length > 50) {
        state.token = auth.slice(7);
        state.capturedAt = Date.now();
        state.captureCount++;
      }
      state.lastAnyHeaders = headers;
      state.lastAnyCapturedAt = Date.now();
      if (req.method() === 'POST') {
        state.lastPostHeaders = headers;
        state.lastPostCapturedAt = Date.now();
      }
    } catch (_) {}
  });
  return state;
}

// Extract DataDome/fingerprint-like headers from a captured request's header set.
// Returns an object ready to merge into page.request.post headers.
export function extractReplayHeaders(headerSet) {
  if (!headerSet) return {};
  const out = {};
  for (const [k, v] of Object.entries(headerSet)) {
    if (DATADOME_HEADER_PATTERNS.some(p => p.test(k))) out[k] = v;
  }
  // Also replay the exact sec-* and accept-* set the page uses, to avoid
  // DataDome flagging us on UA-CH / accept mismatch.
  for (const k of ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-arch', 'sec-ch-ua-full-version-list', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'accept', 'accept-language', 'origin', 'referer']) {
    if (headerSet[k]) out[k] = headerSet[k];
  }
  return out;
}

// Wait until we've observed at least one outgoing auth'd request (proves we're signed in).
export async function waitForCapturedJwt(captureState, { timeoutMs = 30000, minTokens = 1 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (captureState.captureCount >= minTokens && captureState.token) {
      return { ok: true, token: captureState.token, capturedAt: captureState.capturedAt };
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return { ok: false, reason: 'timeout-waiting-for-jwt-capture' };
}

// Get the most recently observed JWT (caller should prompt the page to make activity first).
// If too old (>45s since capture), trigger a navigation-ish action to wake Clerk refresh.
export async function getFreshJwt(page, captureState, { maxAgeMs = 45000 } = {}) {
  const age = Date.now() - captureState.capturedAt;
  if (captureState.token && age < maxAgeMs) return captureState.token;

  // Trigger a request from within the page by reloading a harmless part.
  // A simple way: evaluate a dispatchEvent that Clerk listens for, or just wait for
  // any in-flight request to complete. For now we fall back to sleeping briefly
  // (the page makes periodic auth'd calls on its own).
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const age2 = Date.now() - captureState.capturedAt;
    if (captureState.token && age2 < maxAgeMs) return captureState.token;
    await new Promise(r => setTimeout(r, 300));
  }
  if (captureState.token) return captureState.token;
  const err = new Error('No Clerk JWT captured. Session may be expired. Run `node scripts/run.mjs login`.');
  err.code = 'SESSION_EXPIRED';
  throw err;
}

// Legacy compat: waitForClerkReady now just waits for captured JWT signal.
export async function waitForClerkReady(page, { timeoutMs = 30000 } = {}) {
  // This is now a no-op shim; real work is in attachJwtCapture/waitForCapturedJwt.
  // Kept so existing call sites don't break.
  return { loaded: true, hasSession: true };
}

export function extractUserIdFromJwt(jwt) {
  // JWT is three base64url segments separated by dots. We decode the payload safely.
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return { user_id: payload.sub, workspace_id: payload.workspace_id, email: payload.email, sid: payload.sid };
  } catch (_) { return null; }
}
