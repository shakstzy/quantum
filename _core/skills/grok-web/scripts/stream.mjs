// stream.mjs -- aggregator for grok.com chat responses.
//
// Live-discovered 2026-04-30: grok.com's chat surface is
//   POST https://grok.com/rest/app-chat/conversations/new   (NDJSON body)
// with each line wrapped as `{"result": {"response"|"conversation": {...}}}`.
// Token shape:
//   { token: "<text>", isThinking: bool, messageTag: "header"|"final", isSoftStop: bool }
// Terminal: `isSoftStop: true` (with empty token), or appearance of
//   `finalMetadata` / `modelResponse`. Citations and images come in the
//   final `modelResponse.steps[].webSearchResults` / `modelResponse.generatedImageUrls`.
//
// This parser also handles the OpenAI-compatible shape (xAI's API doc
// advertises it) so the same code works against api.x.ai if a future
// grok-cli skill wants to reuse it.

const TERMINAL_BOOL_FIELDS = ['done', 'final', 'completed', 'isFinal', 'is_final', 'responseComplete', 'isSoftStop'];
const TERMINAL_STR_FIELDS = ['finishReason', 'finish_reason'];

export class StreamAggregator {
  constructor() {
    this._textParts = [];
    this._thinkingParts = [];
    this.citations = [];
    this.images = [];
    this.terminal = false;
    this.terminalReason = null;
    this.objectsSeen = 0;
    this.firstChunkAt = null;
    this.lastChunkAt = null;
    this.modelHash = null;
    this.modelName = null;
    this.modeName = null;
    this.followUpSuggestions = [];
    this._citationUrls = new Set();
    this._imageUrls = new Set();
  }

  get text() { return this._textParts.join(''); }
  get thinkingText() { return this._thinkingParts.join(''); }

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

    const u = unwrapGrok(obj);
    const text = extractDeltaText(u);
    if (text) {
      // Grok separates thinking-trace tokens from final-answer tokens.
      // Keep them apart so callers can render or discard the trace.
      if (u.isThinking === true) this._thinkingParts.push(text);
      else this._textParts.push(text);
    }

    // Capture model identity when grok exposes it.
    if (u.llmInfo?.modelHash && !this.modelHash) this.modelHash = u.llmInfo.modelHash;
    if (u.metadata?.request_metadata?.model && !this.modelName) {
      this.modelName = u.metadata.request_metadata.model;
    }

    // Citations + images can come in token chunks OR in the final modelResponse.
    // Dedupe by URL across the whole aggregator lifetime, not just per-call.
    for (const c of extractCitations(u)) {
      if (!this._citationUrls.has(c.url)) {
        this._citationUrls.add(c.url);
        this.citations.push(c);
      }
    }
    for (const im of extractImages(u)) {
      if (!this._imageUrls.has(im.url)) {
        this._imageUrls.add(im.url);
        this.images.push(im);
      }
    }

    // Final-metadata follow-ups (grok-specific, useful for callers).
    if (u.finalMetadata?.followUpSuggestions && Array.isArray(u.finalMetadata.followUpSuggestions)) {
      for (const s of u.finalMetadata.followUpSuggestions) {
        if (s?.label) this.followUpSuggestions.push({ label: s.label, type: s.properties?.followUpType || null });
      }
    }
    // The terminal modelResponse carries the canonical model name.
    if (u.modelResponse?.metadata?.request_metadata?.model && !this.modelName) {
      this.modelName = u.modelResponse.metadata.request_metadata.model;
    }
    if (u.modelResponse?.metadata?.request_metadata?.mode && !this.modeName) {
      this.modeName = u.modelResponse.metadata.request_metadata.mode;
    }

    if (hasTerminalMarker(u, obj)) this._terminate('json-terminal');
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
      thinkingText: this.thinkingText,
      citations: this.citations,
      images: this.images,
      followUpSuggestions: this.followUpSuggestions,
      modelName: this.modelName,
      modelHash: this.modelHash,
      modeName: this.modeName ?? null,
      terminal: this.terminal,
      terminalReason: this.terminalReason,
      objectsSeen: this.objectsSeen,
      firstChunkAt: this.firstChunkAt,
      lastChunkAt: this.lastChunkAt
    };
  }
}

// grok wraps every event as `{result: {response: {...}}}` or `{result: {conversation: {...}}}`.
// Unwrap to the inner shape so generic extractors work on both grok and OpenAI-style payloads.
function unwrapGrok(obj) {
  if (obj?.result && typeof obj.result === 'object') {
    if (obj.result.response && typeof obj.result.response === 'object') return obj.result.response;
    return obj.result;
  }
  return obj;
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
  const seen = new Set();
  const push = (c) => {
    if (!c?.url || seen.has(c.url)) return;
    seen.add(c.url);
    out.push({
      url: c.url,
      title: typeof c.title === 'string' ? c.title : null,
      snippet: typeof c.snippet === 'string' ? c.snippet
              : (typeof c.text === 'string' ? c.text
              : (typeof c.preview === 'string' ? c.preview : null))
    });
  };
  // Generic
  if (Array.isArray(obj.citations)) for (const c of obj.citations) push(c);
  if (Array.isArray(obj.sources)) for (const c of obj.sources) push(c);
  // Grok shape: webSearchResults / citedWebSearchResults at multiple levels.
  for (const key of ['webSearchResults', 'citedWebSearchResults']) {
    if (Array.isArray(obj[key])) for (const c of obj[key]) push(c);
  }
  // Grok modelResponse + nested steps.
  const mr = obj.modelResponse;
  if (mr) {
    for (const key of ['webSearchResults', 'citedWebSearchResults']) {
      if (Array.isArray(mr[key])) for (const c of mr[key]) push(c);
    }
    if (Array.isArray(mr.steps)) {
      for (const s of mr.steps) {
        for (const key of ['webSearchResults', 'citedWebSearchResults']) {
          if (Array.isArray(s[key])) for (const c of s[key]) push(c);
        }
      }
    }
  }
  return out;
}

function extractImages(obj) {
  const out = [];
  const seen = new Set();
  const push = (url, im = {}) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, w: im.width ?? null, h: im.height ?? null });
  };
  if (typeof obj.imageUrl === 'string') push(obj.imageUrl);
  if (Array.isArray(obj.images)) for (const im of obj.images) if (im?.url) push(im.url, im);
  // Grok-specific
  if (Array.isArray(obj.generatedImageUrls)) for (const url of obj.generatedImageUrls) push(url);
  if (Array.isArray(obj.imageAttachments)) for (const im of obj.imageAttachments) if (im?.url) push(im.url, im);
  // Final modelResponse
  const mr = obj.modelResponse;
  if (mr) {
    if (Array.isArray(mr.generatedImageUrls)) for (const url of mr.generatedImageUrls) push(url);
    if (Array.isArray(mr.imageAttachments)) for (const im of mr.imageAttachments) if (im?.url) push(im.url, im);
  }
  return out;
}

function hasTerminalMarker(unwrapped, original) {
  // OpenAI shape: choices[0].finish_reason
  if (original?.choices?.[0]?.finish_reason) return true;
  // Grok soft-stop: the empty-token event with isSoftStop:true is the canonical end-of-stream signal.
  if (unwrapped.isSoftStop === true) return true;
  // Grok's modelResponse wrapper appearance with a final message also signals end.
  if (unwrapped.modelResponse && typeof unwrapped.modelResponse.message === 'string') return true;
  if (unwrapped.finalMetadata) return true;
  for (const k of TERMINAL_BOOL_FIELDS) {
    if (unwrapped[k] === true) return true;
  }
  for (const k of TERMINAL_STR_FIELDS) {
    const v = unwrapped[k];
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
