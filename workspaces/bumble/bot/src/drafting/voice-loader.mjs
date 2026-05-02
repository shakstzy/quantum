import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { VOICE_DIR } from "../runtime/paths.mjs";

let _voiceCache = null;

export async function loadVoice() {
  if (_voiceCache) return _voiceCache;
  const files = (await readdir(VOICE_DIR)).filter(f => f.endsWith(".md")).sort();
  const sections = [];
  for (const f of files) {
    const body = await readFile(resolve(VOICE_DIR, f), "utf8");
    sections.push(`# ${f}\n\n${body}`);
  }
  _voiceCache = sections.join("\n\n---\n\n");
  return _voiceCache;
}
