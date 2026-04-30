// .halt file kill switch. Touched by ban-quarantine or operator. Every entrypoint must check this
// BEFORE doing any LinkedIn work. Mirrors workspaces/tinder/bot/src/runtime/halt.mjs.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { HALT_FILE } from "./paths.mjs";
import { HaltedError } from "./exceptions.mjs";

export async function isHalted() {
  try {
    await fs.stat(HALT_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function readHaltReason() {
  try {
    return (await fs.readFile(HALT_FILE, "utf8")).trim();
  } catch {
    return "";
  }
}

export async function abortIfHalted() {
  if (await isHalted()) {
    const reason = await readHaltReason();
    throw new HaltedError(
      `LinkedIn workspace is halted. ${reason ? `Reason: ${reason}. ` : ""}` +
        `Remove ${HALT_FILE} to resume.`
    );
  }
}

export async function trip(reason) {
  await fs.mkdir(dirname(HALT_FILE), { recursive: true });
  const ts = new Date().toISOString();
  const body = `${ts}\n${reason}\n`;
  await fs.writeFile(HALT_FILE, body, "utf8");
  // Also emit on stderr so any running script notices.
  process.stderr.write(`[HALT] ${ts} ${reason}\n`);
}

export async function clearHalt() {
  try {
    await fs.unlink(HALT_FILE);
  } catch {
    /* ignore */
  }
}
