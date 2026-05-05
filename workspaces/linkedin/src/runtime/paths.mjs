import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const WORKSPACE_ROOT = resolve(__dirname, "../..");
export const QUANTUM_ROOT = resolve(WORKSPACE_ROOT, "../..");

export const CONFIG_DIR = resolve(WORKSPACE_ROOT, "config");
export const CAPS_FILE = resolve(CONFIG_DIR, "caps.json");

export const PROFILE_DIR = resolve(WORKSPACE_ROOT, ".profile");

export const RAW_DIR = resolve(QUANTUM_ROOT, "raw/linkedin");

export const STATE_HOME = resolve(homedir(), ".quantum/linkedin");
export const HALT_FILE = resolve(STATE_HOME, ".halt");
export const RATE_STATE_FILE = resolve(STATE_HOME, "state/rate-state.json");
export const ACTIONS_LOG = resolve(STATE_HOME, "state/actions.ndjson");
export const QUARANTINE_DIR = resolve(STATE_HOME, "quarantine");
export const ALERTS_DIR = resolve(STATE_HOME, "alerts");
