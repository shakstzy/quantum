// High-level "should I act" gate. Wraps caps + halt + active-hours + pending-ceiling.

import { abortIfHalted } from "../runtime/halt.mjs";
import { checkBudget, recordAction } from "../runtime/caps.mjs";
import { logAction } from "../runtime/logger.mjs";

export async function gate(action, { skipActiveHours = false } = {}) {
  await abortIfHalted();
  await checkBudget(action, { skipActiveHours });
  return true;
}

export async function record(action, { target = null, success = true, error = null, extra = {} } = {}) {
  await recordAction(action);
  await logAction({ action, target, success, error, ...extra });
}
