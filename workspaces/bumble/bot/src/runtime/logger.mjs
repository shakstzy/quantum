import { appendFile, mkdir } from "node:fs/promises";
import { SESSION_LOG, STATE_HOME } from "./paths.mjs";

export async function logSession(entry) {
  await mkdir(STATE_HOME, { recursive: true });
  await appendFile(SESSION_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

export async function logSwipe(entry) {
  await logSession({ event: "swipe", ...entry });
}
