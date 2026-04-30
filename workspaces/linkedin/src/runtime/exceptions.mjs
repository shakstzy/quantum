// Typed errors for the LinkedIn capability layer.
// Each subclass carries a `code` field so callers / CLI can branch without instanceof chains.

export class AuthError extends Error {
  constructor(message, { hint = null } = {}) {
    super(message);
    this.name = "AuthError";
    this.code = "AUTH";
    this.hint = hint;
  }
}

export class CheckpointError extends AuthError {
  constructor(message, { kind = "unknown", hint = null } = {}) {
    super(message, { hint });
    this.name = "CheckpointError";
    this.code = "CHECKPOINT";
    this.kind = kind; // otp | captcha | comply | device | unknown
  }
}

export class BanSignalError extends Error {
  constructor(message, { signal = "unknown", url = null } = {}) {
    super(message);
    this.name = "BanSignalError";
    this.code = "BAN_SIGNAL";
    this.signal = signal;
    this.url = url;
  }
}

export class RateLimitExceeded extends Error {
  constructor(message, { action = null, scope = "daily" } = {}) {
    super(message);
    this.name = "RateLimitExceeded";
    this.code = "RATE_LIMIT";
    this.action = action;
    this.scope = scope; // daily | weekly | pending_ceiling | active_hours | burst_cooldown
  }
}

export class BrowserUnresponsiveError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserUnresponsiveError";
    this.code = "BROWSER_UNRESPONSIVE";
  }
}

export class ProfileInaccessibleError extends Error {
  constructor(message, { publicId = null, status = null } = {}) {
    super(message);
    this.name = "ProfileInaccessibleError";
    this.code = "PROFILE_INACCESSIBLE";
    this.publicId = publicId;
    this.status = status;
  }
}

export class HaltedError extends Error {
  constructor(message) {
    super(message);
    this.name = "HaltedError";
    this.code = "HALTED";
  }
}
