// Append-only NDJSON action log. One line per action.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { ACTIONS_LOG } from "./paths.mjs";

async function ensureLogFile() {
  await fs.mkdir(dirname(ACTIONS_LOG), { recursive: true });
  try {
    await fs.access(ACTIONS_LOG);
  } catch {
    await fs.writeFile(ACTIONS_LOG, "", "utf8");
  }
}

export async function logAction(record) {
  await ensureLogFile();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
  // proper-lockfile guarantees no interleaved writes across CLIs.
  const release = await lockfile.lock(ACTIONS_LOG, { retries: { retries: 8, minTimeout: 50 } });
  try {
    await fs.appendFile(ACTIONS_LOG, line, "utf8");
  } finally {
    await release();
  }
}

export async function tailLog(n = 50) {
  try {
    const text = await fs.readFile(ACTIONS_LOG, "utf8");
    const lines = text.trimEnd().split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { _raw: l };
      }
    });
  } catch {
    return [];
  }
}
