import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RAW_SWIPES, RAW_MATCHES, RAW_THREADS, RAW_SENT, SESSION_LOG, STATE_HOME, monthShard } from "./paths.mjs";

async function appendNDJSON(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(obj) + "\n");
}

export async function logSwipe(entry) {
  await appendNDJSON(resolve(RAW_SWIPES, `${monthShard()}.ndjson`), { ts: new Date().toISOString(), ...entry });
}

export async function logMatch(entry) {
  await appendNDJSON(resolve(RAW_MATCHES, `${monthShard()}.ndjson`), { ts: new Date().toISOString(), ...entry });
}

export async function logThreadMessage(entry) {
  await appendNDJSON(resolve(RAW_THREADS, `${monthShard()}.ndjson`), { ts: new Date().toISOString(), ...entry });
}

export async function logSent(entry) {
  await appendNDJSON(resolve(RAW_SENT, `${monthShard()}.ndjson`), { ts: new Date().toISOString(), ...entry });
}

export async function logSession(entry) {
  await mkdir(STATE_HOME, { recursive: true });
  await appendFile(SESSION_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}
