// Session-level events that don't belong on a single entity (swipe sweeps, halts, etc.)
// Per-person data goes through entity-store.mjs, NOT this file.

import { appendFile, mkdir } from "node:fs/promises";
import { SESSION_LOG, STATE_HOME } from "./paths.mjs";

export async function logSession(entry) {
  await mkdir(STATE_HOME, { recursive: true });
  await appendFile(SESSION_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

// Swipe events fire so often that they would balloon entity files (most swipes are passes
// on women we never match with). Keep them as a session-level activity log only.
export async function logSwipe(entry) {
  await logSession({ event: "swipe", ...entry });
}
