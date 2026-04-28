// Sends a self-iMessage via AppleScript when pending queue grows past threshold.
// Cron has no Claude, so we can't use the iMessage MCP — falling back to osascript.
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(_execFile);

const SELF_PHONE = process.env.QUANTUM_SELF_PHONE;

export async function notifySelf(text) {
  if (process.env.QUANTUM_NOTIFY_DISABLE === "1") return;
  if (!SELF_PHONE) {
    console.error("notifier: QUANTUM_SELF_PHONE env var not set, skipping");
    return;
  }
  const escaped = text.replace(/"/g, '\\"');
  const script = `
    tell application "Messages"
      set targetService to 1st service whose service type = iMessage
      set targetBuddy to buddy "${SELF_PHONE}" of targetService
      send "${escaped}" to targetBuddy
    end tell`;
  try { await execFile("osascript", ["-e", script], { timeout: 8000 }); }
  catch (e) { console.error(`notifier: failed: ${e.message}`); }
}
