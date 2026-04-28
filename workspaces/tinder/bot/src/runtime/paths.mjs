import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const BOT_ROOT = resolve(__dirname, "../..");
export const WORKSPACE_ROOT = resolve(BOT_ROOT, "..");
export const QUANTUM_ROOT = resolve(WORKSPACE_ROOT, "../..");

export const CONFIG_DIR = resolve(WORKSPACE_ROOT, "config");
export const VOICE_DIR = resolve(CONFIG_DIR, "voice");
export const CAPS_FILE = resolve(CONFIG_DIR, "caps.json");
export const SCHEDULE_FILE = resolve(CONFIG_DIR, "schedule.json");
export const FILTER_FILE = resolve(CONFIG_DIR, "filter.json");
export const SELECTORS_FILE = resolve(CONFIG_DIR, "selectors.json");

export const PROFILE_DIR = resolve(WORKSPACE_ROOT, ".profile");

export const RAW_DIR = resolve(QUANTUM_ROOT, "raw/tinder");
export const INGEST_LOG = resolve(QUANTUM_ROOT, "raw/.ingest-log");
export const WATERMARK_FILE = resolve(INGEST_LOG, "tinder.watermark");

export const OUTBOUND_DIR = resolve(WORKSPACE_ROOT, "04-outbound");
export const OB_DRAFTS = resolve(OUTBOUND_DIR, "drafts");
export const OB_PENDING = resolve(OUTBOUND_DIR, "pending");
export const OB_APPROVED = resolve(OUTBOUND_DIR, "approved");
export const OB_SENT = resolve(OUTBOUND_DIR, "sent");
export const OB_EXPIRED = resolve(OUTBOUND_DIR, "expired");
export const OB_AUTO_SENT = resolve(OUTBOUND_DIR, "auto-sent");

export const STATE_HOME = resolve(homedir(), ".quantum/tinder");
export const HALT_FILE = resolve(STATE_HOME, ".halt");
export const RATE_STATE_FILE = resolve(STATE_HOME, ".rate-state.json");
export const SESSION_LOG = resolve(STATE_HOME, "sessions.ndjson");

export function monthShard(date = new Date()) {
  return date.toISOString().slice(0, 7);
}
