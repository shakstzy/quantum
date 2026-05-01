import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRateLimitJSON, parse429Response } from '../scripts/quota.mjs';

test('parseRateLimitJSON: healthy quota with remaining > 0', () => {
  const r = parseRateLimitJSON({
    remainingQueries: 17,
    totalQueries: 20,
    windowSizeSeconds: 7200,
    waitTimeSeconds: 0
  });
  assert.equal(r.ok, true);
  assert.equal(r.remaining, 17);
  assert.equal(r.total, 20);
  assert.equal(r.windowSeconds, 7200);
  assert.equal(r.reason, null);
});

test('parseRateLimitJSON: zero remaining = not ok with resetAt populated', () => {
  const r = parseRateLimitJSON({
    remainingQueries: 0,
    totalQueries: 20,
    windowSizeSeconds: 7200,
    waitTimeSeconds: 1800
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rate-limited');
  assert.equal(r.waitSeconds, 1800);
  assert.ok(r.resetAt && new Date(r.resetAt).getTime() > Date.now() + 1700 * 1000);
});

test('parseRateLimitJSON: high/low effort wrapper, --effort=high picks high bucket', () => {
  const r = parseRateLimitJSON({
    highEffortRateLimits: { remainingQueries: 2, totalQueries: 10, waitTimeSeconds: 600, windowSizeSeconds: 3600 },
    lowEffortRateLimits:  { remainingQueries: 50, totalQueries: 200, waitTimeSeconds: 0, windowSizeSeconds: 3600 }
  }, { effort: 'high' });
  assert.equal(r.remaining, 2);
  assert.equal(r.effort, 'high');
  assert.equal(r.ok, true);
});

test('parseRateLimitJSON: high/low effort wrapper, --effort=low picks low bucket', () => {
  const r = parseRateLimitJSON({
    highEffortRateLimits: { remainingQueries: 0, waitTimeSeconds: 600 },
    lowEffortRateLimits:  { remainingQueries: 50, waitTimeSeconds: 0 }
  }, { effort: 'low' });
  assert.equal(r.remaining, 50);
  assert.equal(r.effort, 'low');
  assert.equal(r.ok, true);
});

test('parseRateLimitJSON: high/low wrapper without effort hint defaults to worst-off bucket (safe default)', () => {
  const r = parseRateLimitJSON({
    highEffortRateLimits: { remainingQueries: 0, waitTimeSeconds: 600 },
    lowEffortRateLimits:  { remainingQueries: 50, waitTimeSeconds: 0 }
  });
  assert.equal(r.remaining, 0);
  assert.equal(r.ok, false);
  assert.equal(r.effort, 'high');
});

test('parseRateLimitJSON: missing fields = ok=true (treat as no signal)', () => {
  const r = parseRateLimitJSON({});
  assert.equal(r.ok, true);
  assert.equal(r.remaining, null);
  assert.equal(r.total, null);
});

test('parseRateLimitJSON: handles non-numeric inputs gracefully', () => {
  const r = parseRateLimitJSON({ remainingQueries: 'three', totalQueries: null });
  assert.equal(r.remaining, null);
  assert.equal(r.total, null);
  assert.equal(r.ok, true);
});

test('parse429Response: 429 with numeric Retry-After', () => {
  const r = parse429Response({ status: 429, headers: { 'retry-after': '120' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, '429');
  assert.equal(r.waitSeconds, 120);
  assert.ok(r.resetAt);
});

test('parse429Response: 429 with HTTP-date Retry-After', () => {
  const future = new Date(Date.now() + 60 * 1000).toUTCString();
  const r = parse429Response({ status: 429, headers: { 'Retry-After': future } });
  assert.equal(r.ok, false);
  assert.ok(r.waitSeconds >= 50 && r.waitSeconds <= 70, `expected ~60s, got ${r.waitSeconds}`);
});

test('parse429Response: 429 with body containing rate-limit JSON', () => {
  const r = parse429Response({
    status: 429,
    headers: {},
    body: { remainingQueries: 0, totalQueries: 20, waitTimeSeconds: 900, windowSizeSeconds: 3600 }
  });
  assert.equal(r.ok, false);
  assert.equal(r.waitSeconds, 900);
  assert.equal(r.total, 20);
});

test('parse429Response: non-429 passes through ok=true', () => {
  const r = parse429Response({ status: 200, headers: {}, body: {} });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('parse429Response: case-insensitive header lookup', () => {
  const r = parse429Response({ status: 429, headers: { 'RETRY-AFTER': '30' } });
  assert.equal(r.waitSeconds, 30);
});
