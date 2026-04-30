// Ban-signal helpers. Selector-light (per MCP "minimize DOM dependence").
// Page-level rate-limit + auth detection lives in page-actions.mjs; this module
// re-exports for compatibility and adds the typed wrappers used by the rest
// of the workspace.

export { detectRateLimit, handleModalClose, isLoggedIn } from "./page-actions.mjs";
import { quarantineProfile } from "../runtime/ban-quarantine.mjs";
import { BanSignalError, CheckpointError } from "../runtime/exceptions.mjs";

// Convert a hard ban signal into an auto-quarantine + halt. Use sparingly; only
// after a verified hard signal (auth_wall, http_401 inside Voyager — not present
// in v0.5 — or a checkpoint we cannot recover from).
export async function quarantineOnSignal(err) {
  if (err instanceof BanSignalError) {
    return quarantineProfile({ signal: err.signal, url: err.url });
  }
  if (err instanceof CheckpointError) {
    return quarantineProfile({ signal: `checkpoint_${err.kind}`, url: null });
  }
  return null;
}
