// stream.mjs -- transport-agnostic aggregator for grok.com chat responses.
//
// Grok streams over an unknown mix of SSE / fetch-stream NDJSON / WebSocket frames.
// This parser ingests raw payloads from any transport, classifies them, and
// builds a unified {text, citations, images, terminal, terminalReason} object.
//
// Design: handle the OpenAI-compatible shape that xAI's API doc advertises,
// plus generic terminal markers. Grok web-specific shapes get plugged in via
// `extractDeltaText` / `extractCitations` / `extractImages` once `diag.mjs`
// reveals the actual wire format. Do not speculate beyond what is observed.

const TERMINAL_BOOL_FIELDS = ['done', 'final', 'completed', 'isFinal', 'is_final', 'responseComplete'];
const TERMINAL_STR_FIELDS = ['finishReason', 'finish_reason'];

export class StreamAggregator {
  constructor() {
    this._textParts = [];
    this.citations = [];
    this.images = [];
    this.terminal = false;
    this.terminalReason = null;
    this.objectsSeen = 0;
    this.firstChunkAt = null;
    this.lastChunkAt = null;
  }

  get text() { return this._textParts.join(''); }

  // SSE event payload (the part after "data: ").
  ingestSSE(payload) {
    if (typeof payload !== 'string') return;
    const trimmed = payload.trim();
    if (!trimmed) return;
    if (trimmed === '[DONE]') {
      this._terminate('sse-done');
      return;
    }
    let obj;
    try { obj = JSON.parse(trimmed); } catch { return; }
    this.ingestObject(obj);
  }

  // NDJSON-style: one JSON object per line.
  ingestNDJSONLine(line) {
    if (typeof line !== 'string') return;
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { return; }
    this.ingestObject(obj);
  }

  // Pre-parsed JSON object from any transport.
  ingestObject(obj) {
    if (!obj || typeof obj !== 'object') return;
    this.objectsSeen += 1;
    const now = Date.now();
    if (this.firstChunkAt == null) this.firstChunkAt = now;
    this.lastChunkAt = now;

    const text = extractDeltaText(obj);
    if (text) this._textParts.push(text);

    const cites = extractCitations(obj);
    if (cites.length) this.citations.push(...cites);

    const imgs = extractImages(obj);
    if (imgs.length) this.images.push(...imgs);

    if (hasTerminalMarker(obj)) this._terminate('json-terminal');
  }

  // Transport-level close (WS close frame, HTTP loadingFinished).
  markTransportClose(reason = 'transport-close') {
    if (!this.terminal) this._terminate(reason);
  }

  // Caller declares idle: no chunks for N ms AND we've seen at least one chunk.
  // Conservative: only fire if we've actually received content.
  markIdle() {
    if (!this.terminal && this.objectsSeen > 0) {
      this._terminate('idle-after-data');
    }
  }

  _terminate(reason) {
    this.terminal = true;
    if (!this.terminalReason) this.terminalReason = reason;
  }

  toJSON() {
    return {
      text: this.text,
      citations: this.citations,
      images: this.images,
      terminal: this.terminal,
      terminalReason: this.terminalReason,
      objectsSeen: this.objectsSeen,
      firstChunkAt: this.firstChunkAt,
      lastChunkAt: this.lastChunkAt
    };
  }
}

function extractDeltaText(obj) {
  // OpenAI-compatible streaming: choices[0].delta.content
  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const c0 = choices[0];
    if (c0?.delta && typeof c0.delta.content === 'string') return c0.delta.content;
    if (c0?.message && typeof c0.message.content === 'string') return c0.message.content;
  }
  // Bare: { delta | content | token | text: "..." }
  if (typeof obj.delta === 'string') return obj.delta;
  if (typeof obj.content === 'string') return obj.content;
  if (typeof obj.token === 'string') return obj.token;
  if (typeof obj.text === 'string') return obj.text;
  return '';
}

function extractCitations(obj) {
  const out = [];
  const candidates = [];
  if (Array.isArray(obj.citations)) candidates.push(...obj.citations);
  if (Array.isArray(obj.sources)) candidates.push(...obj.sources);
  for (const c of candidates) {
    if (c && typeof c.url === 'string') {
      out.push({
        url: c.url,
        title: typeof c.title === 'string' ? c.title : null,
        snippet: typeof c.snippet === 'string' ? c.snippet : (typeof c.text === 'string' ? c.text : null)
      });
    }
  }
  return out;
}

function extractImages(obj) {
  const out = [];
  if (typeof obj.imageUrl === 'string') out.push({ url: obj.imageUrl });
  if (Array.isArray(obj.images)) {
    for (const im of obj.images) {
      if (im && typeof im.url === 'string') out.push({ url: im.url, w: im.width ?? null, h: im.height ?? null });
    }
  }
  return out;
}

function hasTerminalMarker(obj) {
  if (obj.choices?.[0]?.finish_reason) return true;
  for (const k of TERMINAL_BOOL_FIELDS) {
    if (obj[k] === true) return true;
  }
  for (const k of TERMINAL_STR_FIELDS) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0 && v !== 'null' && v !== 'pending') return true;
  }
  return false;
}

// Helper: parse a raw SSE chunk that may contain multiple `data: ` events
// separated by blank lines. Returns array of payload strings.
export function parseSSEChunk(chunk) {
  if (typeof chunk !== 'string') return [];
  const out = [];
  // Events are delimited by blank lines (\n\n). Within an event, lines
  // starting with "data:" are payload (concatenated).
  const events = chunk.split(/\n\n+/);
  for (const ev of events) {
    if (!ev.trim()) continue;
    const dataLines = ev.split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).replace(/^\s/, ''));
    if (dataLines.length) out.push(dataLines.join('\n'));
  }
  return out;
}
