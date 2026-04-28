import { access, writeFile, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { HALT_FILE } from "./paths.mjs";

export async function isHalted() {
  try { await access(HALT_FILE); return true; } catch { return false; }
}

export async function readHaltReason() {
  try { return (await readFile(HALT_FILE, "utf8")).trim(); } catch { return null; }
}

export async function setHalt(reason) {
  await mkdir(dirname(HALT_FILE), { recursive: true });
  await writeFile(HALT_FILE, `${new Date().toISOString()}: ${reason}\n`);
}

export async function clearHalt() {
  try { await unlink(HALT_FILE); } catch {}
}

export async function abortIfHalted() {
  if (await isHalted()) {
    const reason = await readHaltReason();
    throw new Error(`HALTED: ${reason}`);
  }
}
