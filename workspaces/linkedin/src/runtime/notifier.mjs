// Alert writer. Drops a markdown file into ~/.quantum/linkedin/alerts/ and yells on stderr.
// Used by ban-signal handler and CLI on hard failures.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ALERTS_DIR } from "./paths.mjs";

function tsForFilename() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function alert({ kind, summary, detail = "", tags = [] } = {}) {
  await fs.mkdir(ALERTS_DIR, { recursive: true });
  const ts = new Date().toISOString();
  const file = join(ALERTS_DIR, `${tsForFilename()}-${kind}.md`);
  const body =
    `---\n` +
    `kind: ${kind}\n` +
    `ts: ${ts}\n` +
    `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]\n` +
    `---\n\n` +
    `# ${summary}\n\n` +
    `${detail}\n`;
  await fs.writeFile(file, body, "utf8");
  process.stderr.write(`[ALERT:${kind}] ${summary} -> ${file}\n`);
  return file;
}
