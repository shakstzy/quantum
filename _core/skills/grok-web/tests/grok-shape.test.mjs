// Grok-shape integration tests using a real NDJSON capture from grok.com
// (POST /rest/app-chat/conversations/new) recorded 2026-04-30.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamAggregator } from '../scripts/stream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, 'fixtures', 'grok-stream-test.ndjson'), 'utf8');

function feed(agg) {
  for (const line of FIXTURE.split('\n')) {
    if (line.trim()) agg.ingestNDJSONLine(line);
  }
}

test('grok: assistant text is "test" (final-tag tokens only)', () => {
  const a = new StreamAggregator();
  feed(a);
  assert.equal(a.text, 'test');
});

test('grok: thinking-trace tokens captured in thinkingText, not text', () => {
  const a = new StreamAggregator();
  feed(a);
  assert.equal(a.thinkingText, 'Thinking about your request');
  assert.ok(!a.text.includes('Thinking about'), 'thinking trace must not leak into main text');
});

test('grok: terminal triggered by isSoftStop:true (sticky)', () => {
  const a = new StreamAggregator();
  feed(a);
  assert.equal(a.terminal, true);
  assert.equal(a.terminalReason, 'json-terminal');
});

test('grok: modelHash captured from llmInfo', () => {
  const a = new StreamAggregator();
  feed(a);
  assert.equal(a.modelHash, '+zjPDRTKcq2WwbreT0AQVY9kCVe2bExedPpWrAmPVLk=');
});

test('grok: modelName captured from final modelResponse.metadata.request_metadata.model', () => {
  const a = new StreamAggregator();
  feed(a);
  assert.equal(a.modelName, 'grok-3');
});

test('grok: citations pulled from modelResponse.webSearchResults', () => {
  const a = new StreamAggregator();
  feed(a);
  assert.equal(a.citations.length, 1);
  assert.equal(a.citations[0].url, 'https://en.wikipedia.org/wiki/Test');
  assert.equal(a.citations[0].title, 'Test - Wikipedia');
  assert.ok(a.citations[0].snippet.includes('quality'));
});

test('grok: images pulled from modelResponse.generatedImageUrls', () => {
  const a = new StreamAggregator();
  feed(a);
  assert.equal(a.images.length, 1);
  assert.equal(a.images[0].url, 'https://assets.grok.com/foo.webp');
});

test('grok: followUpSuggestions captured for caller use', () => {
  const a = new StreamAggregator();
  feed(a);
  assert.equal(a.followUpSuggestions.length, 2);
  assert.equal(a.followUpSuggestions[0].label, "Explain test's purpose");
  assert.equal(a.followUpSuggestions[0].type, 'DIVE_DEEPER');
});

test('grok: toJSON shape contains all live-extracted fields', () => {
  const a = new StreamAggregator();
  feed(a);
  const j = a.toJSON();
  assert.equal(j.text, 'test');
  assert.equal(j.thinkingText, 'Thinking about your request');
  assert.equal(j.modelName, 'grok-3');
  assert.equal(j.modeName, 'fast');
  assert.equal(j.citations.length, 1);
  assert.equal(j.images.length, 1);
  assert.equal(j.followUpSuggestions.length, 2);
  assert.equal(j.terminal, true);
});

test('grok: idempotent on duplicate citations across token + modelResponse passes', () => {
  // Simulate a citation appearing both in a token chunk and again in modelResponse.
  const a = new StreamAggregator();
  a.ingestObject({ result: { response: { webSearchResults: [{ url: 'https://x.example', title: 'X', snippet: 's' }] } } });
  a.ingestObject({ result: { response: { modelResponse: { webSearchResults: [{ url: 'https://x.example', title: 'X', snippet: 's' }] } } } });
  assert.equal(a.citations.length, 1, 'duplicate URL must not double-count');
});

test('grok: non-JSON NDJSON lines silently dropped', () => {
  const a = new StreamAggregator();
  a.ingestNDJSONLine('not json');
  a.ingestNDJSONLine('');
  a.ingestNDJSONLine('   ');
  feed(a);
  assert.equal(a.text, 'test');
});
