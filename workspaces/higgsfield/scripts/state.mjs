// state.mjs -- atomic state.json reads and writes for resumable runs
// Schema documented in rules/output-conventions.md

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateUlid() {
  // Minimal ULID: 48-bit time + 80-bit random, Crockford base32
  const time = Date.now();
  let t = '';
  let n = time;
  for (let i = 9; i >= 0; i--) {
    t = CROCKFORD[n % 32] + t;
    n = Math.floor(n / 32);
  }
  let r = '';
  for (let i = 0; i < 16; i++) {
    r += CROCKFORD[Math.floor(Math.random() * 32)];
  }
  return t + r;
}

export function slugFromPrompt(prompt) {
  const cleaned = (prompt || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/\s/g, '-');
  return cleaned || 'untitled';
}

export function timestampForRunId(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    '-' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

export async function initState(runDir, partial) {
  await mkdir(runDir, { recursive: true });
  const now = new Date().toISOString();
  const state = {
    schema_version: 1,
    run_id: partial.run_id,
    cmd: partial.cmd,
    model_frontend: partial.model_frontend || null,
    model_backend: partial.model_backend || null,
    tool_url: partial.tool_url || null,
    prompt: partial.prompt || null,
    params: partial.params || {},
    cost_credits_expected: partial.cost_credits_expected ?? null,
    cost_credits_actual: null,
    idempotency_key: partial.idempotency_key || generateUlid(),
    job_uuid: null,
    status: 'pending',
    created_at: now,
    updated_at: now,
    attempts: 1,
    last_error: null,
    force_used: partial.force_used || false,
    notes: []
  };
  await writeState(runDir, state);
  return state;
}

export async function readState(runDir) {
  const p = join(runDir, 'state.json');
  if (!existsSync(p)) return null;
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw);
}

export async function writeState(runDir, state) {
  state.updated_at = new Date().toISOString();
  const p = join(runDir, 'state.json');
  const tmp = p + '.tmp';
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, p);
}

export async function transition(runDir, newStatus, patch = {}) {
  const state = await readState(runDir);
  if (!state) throw new Error('No state.json at ' + runDir);
  state.status = newStatus;
  for (const [k, v] of Object.entries(patch)) state[k] = v;
  if (patch.error) state.last_error = patch.error;
  state.notes.push({ at: new Date().toISOString(), event: newStatus, ...patch });
  await writeState(runDir, state);
  return state;
}

export function nextAllowed(from) {
  const legal = {
    pending: ['submitted', 'aborted_precheck', 'failed', 'datadome_flagged'],
    submitted: ['polling', 'failed', 'datadome_flagged'],
    polling: ['downloading', 'failed', 'timeout', 'datadome_flagged'],
    downloading: ['saved', 'failed'],
    saved: [],
    failed: [],
    timeout: [],
    aborted_precheck: [],
    datadome_flagged: []
  };
  return legal[from] || [];
}
