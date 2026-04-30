// Auto-quarantine a poisoned Chrome profile. Per Gemini-Flash adversarial review (2026-04-30):
// LinkedIn 2026 monitors "repeated failed login attempts from a restricted profile" as a signal
// to permanent-ban the IP. On a hard ban signal we move the profile aside so future runs do
// NOT keep poking at it.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PROFILE_DIR, QUARANTINE_DIR } from "./paths.mjs";
import { trip } from "./halt.mjs";
import { alert } from "./notifier.mjs";

function tsForDir() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function quarantineProfile({ signal, url = null } = {}) {
  await fs.mkdir(QUARANTINE_DIR, { recursive: true });
  const dest = join(QUARANTINE_DIR, `profile-${tsForDir()}-${signal}`);
  let moved = false;
  try {
    await fs.rename(PROFILE_DIR, dest);
    moved = true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      // Non-fatal: still trip halt regardless. Operator can manually move the dir.
      process.stderr.write(`[quarantine] rename failed: ${err.message}\n`);
    }
  }
  await trip(`Ban signal: ${signal}${url ? ` at ${url}` : ""}. Profile quarantined: ${moved ? dest : "rename-failed"}`);
  await alert({
    kind: "ban-signal",
    summary: `LinkedIn ban signal: ${signal}`,
    detail: [
      `Signal: ${signal}`,
      `URL: ${url ?? "n/a"}`,
      `Profile moved to: ${moved ? dest : "rename failed (manual move required)"}`,
      `.halt tripped. Investigate before clearing.`,
      ``,
      `Recovery: log in manually via Chrome (NOT this workspace), confirm the account is healthy,`,
      `then run \`npm run login\` to create a fresh persistent profile.`,
    ].join("\n"),
    tags: ["ban", signal],
  });
  return { moved, dest: moved ? dest : null };
}
