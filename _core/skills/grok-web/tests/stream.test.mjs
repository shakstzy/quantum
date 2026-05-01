import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamAggregator, parseSSEChunk } from '../scripts/stream.mjs';

test('SSE: OpenAI-shape deltas concatenate to full text', () => {
  const a = new StreamAggregator();
  a.ingestSSE(JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }));
  a.ingestSSE(JSON.stringify({ choices: [{ delta: { content: ' ' } }] }));
  a.ingestSSE(JSON.stringify({ choices: [{ delta: { content: 'world' } }] }));
  a.ingestSSE('[DONE]');
  assert.equal(a.text, 'Hello world');
  assert.equal(a.terminal, true);
  assert.equal(a.terminalReason, 'sse-done');
});

test('SSE: finish_reason terminates before [DONE] marker arrives', () => {
  const a = new StreamAggregator();
  a.ingestSSE(JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }));
  a.ingestSSE(JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] }));
  assert.equal(a.terminal, true);
  assert.equal(a.terminalReason, 'json-terminal');
});

test('SSE: empty payload and whitespace are no-ops', () => {
  const a = new StreamAggregator();
  a.ingestSSE('');
  a.ingestSSE('   ');
  a.ingestSSE(null);
  assert.equal(a.text, '');
  assert.equal(a.terminal, false);
  assert.equal(a.objectsSeen, 0);
});

test('SSE: malformed JSON is silently dropped (no crash)', () => {
  const a = new StreamAggregator();
  a.ingestSSE('this is not json {{{');
  a.ingestSSE(JSON.stringify({ choices: [{ delta: { content: 'after' } }] }));
  a.ingestSSE('[DONE]');
  assert.equal(a.text, 'after');
  assert.equal(a.terminal, true);
});

test('NDJSON: bare {content} shape', () => {
  const a = new StreamAggregator();
  a.ingestNDJSONLine(JSON.stringify({ content: 'one' }));
  a.ingestNDJSONLine(JSON.stringify({ content: 'two' }));
  a.ingestNDJSONLine(JSON.stringify({ done: true }));
  assert.equal(a.text, 'onetwo');
  assert.equal(a.terminal, true);
});

test('NDJSON: token field shape', () => {
  const a = new StreamAggregator();
  a.ingestNDJSONLine(JSON.stringify({ token: 'a' }));
  a.ingestNDJSONLine(JSON.stringify({ token: 'b' }));
  a.ingestNDJSONLine(JSON.stringify({ isFinal: true }));
  assert.equal(a.text, 'ab');
  assert.equal(a.terminal, true);
});

test('Citations accumulate across chunks', () => {
  const a = new StreamAggregator();
  a.ingestObject({ citations: [{ url: 'https://a.example', title: 'A' }] });
  a.ingestObject({ sources: [{ url: 'https://b.example', title: 'B', text: 'snip' }] });
  assert.equal(a.citations.length, 2);
  assert.equal(a.citations[0].url, 'https://a.example');
  assert.equal(a.citations[1].snippet, 'snip');
});

test('Images: bare imageUrl + array of images', () => {
  const a = new StreamAggregator();
  a.ingestObject({ imageUrl: 'https://img.example/1.png' });
  a.ingestObject({ images: [{ url: 'https://img.example/2.png', width: 1024, height: 768 }] });
  assert.equal(a.images.length, 2);
  assert.equal(a.images[1].w, 1024);
});

test('Late citations after text stable: still captured before terminal', () => {
  const a = new StreamAggregator();
  a.ingestSSE(JSON.stringify({ choices: [{ delta: { content: 'final answer' } }] }));
  // text stable here, but citations event arrives next
  a.ingestSSE(JSON.stringify({ citations: [{ url: 'https://late.example', title: 'late' }] }));
  a.ingestSSE('[DONE]');
  assert.equal(a.text, 'final answer');
  assert.equal(a.citations.length, 1);
  assert.equal(a.terminal, true);
});

test('Transport close before any chunk = terminated but no text (shadow-ban shape)', () => {
  const a = new StreamAggregator();
  a.markTransportClose('ws-close');
  assert.equal(a.terminal, true);
  assert.equal(a.terminalReason, 'ws-close');
  assert.equal(a.text, '');
  assert.equal(a.objectsSeen, 0);
});

test('markIdle: only terminates if we received at least one chunk', () => {
  const a = new StreamAggregator();
  a.markIdle();
  assert.equal(a.terminal, false, 'idle without data must NOT terminate (caller treats as shadow-ban)');

  const b = new StreamAggregator();
  b.ingestObject({ delta: 'x' });
  b.markIdle();
  assert.equal(b.terminal, true);
  assert.equal(b.terminalReason, 'idle-after-data');
});

test('Terminal markers are sticky: first reason wins', () => {
  const a = new StreamAggregator();
  a.ingestSSE('[DONE]');
  a.markTransportClose('ws-close');
  assert.equal(a.terminalReason, 'sse-done');
});

test('parseSSEChunk: splits multi-event payload, strips data: prefix', () => {
  const chunk = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
  const events = parseSSEChunk(chunk);
  assert.deepEqual(events, ['{"a":1}', '{"b":2}', '[DONE]']);
});

test('parseSSEChunk: handles multi-line data fields (joined with newline)', () => {
  const chunk = 'data: line1\ndata: line2\n\n';
  const events = parseSSEChunk(chunk);
  assert.equal(events.length, 1);
  assert.equal(events[0], 'line1\nline2');
});

test('parseSSEChunk: ignores non-data lines (event:, id:, retry:)', () => {
  const chunk = 'event: message\nid: 42\ndata: {"x":1}\nretry: 1000\n\n';
  const events = parseSSEChunk(chunk);
  assert.deepEqual(events, ['{"x":1}']);
});

test('toJSON: serializable shape for metadata.json', () => {
  const a = new StreamAggregator();
  a.ingestSSE(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }));
  a.ingestSSE(JSON.stringify({ citations: [{ url: 'https://x', title: 't' }] }));
  a.ingestSSE('[DONE]');
  const j = a.toJSON();
  assert.equal(j.text, 'hi');
  assert.equal(j.citations.length, 1);
  assert.equal(j.terminal, true);
  assert.equal(j.objectsSeen, 2);
  assert.ok(typeof j.firstChunkAt === 'number');
});
