# Send Confirmation Gate (opt-in)

Default behavior: **the skill sends immediately**. It prints the assembled payload to stdout for the audit trail, then fires `imessage.sh send` (or `send-file`). No `SEND` token required.

Adithya's running mode is "just send" -- interactive confirmation adds latency without value when a human is already watching the conversation. The gate exists only for contexts where a human is NOT watching (scheduled agents, pre-review tooling, CI).

## When to re-enable the gate

Set `MACOS_IMSG_REQUIRE_CONFIRM=1` when:
- A scheduled/cron agent calls this skill and no human is in the loop at run time.
- A new agent or skill is under test and you want one more pair of eyes on every outbound message.
- The caller cannot verify the recipient identity from prior context (ambiguous name lookup, new contact).

With the gate on, present the assembled payload like this:

```
About to send:
  To:       +15125550199
  Service:  iMessage
  Body:     hey! just confirming tomorrow 7pm at Comedor still works for you?

Reply SEND to confirm, anything else aborts.
```

Accept literal `SEND` (case-insensitive) as confirmation. Any other response aborts.

## Preview format (default, gate off)

Before sending, always print:

```
Sending iMessage:
  To:       +17372262287
  Service:  iMessage
  Body:     how many dosas do you want
```

Then send without waiting. The preview is still required for the audit trail even when the gate is off.

## Environment variables

| Variable | Effect |
|----------|--------|
| `MACOS_IMSG_REQUIRE_CONFIRM=1` | Force the `SEND`-token gate back on for this caller. |
| `MACOS_IMSG_NO_CONFIRM=1` | Legacy opt-out. Redundant with the new default; still honored so existing callers (e.g., relationships stage 05 batch loop) keep working without changes. |
| `MACOS_IMSG_SKIP_PERMCHECK=1` | Skip the macOS permissions self-test when the caller has verified permissions this session. |

When `MACOS_IMSG_REQUIRE_CONFIRM` is set, the skill logs one line to stderr: `macos-imessage: gate enabled via MACOS_IMSG_REQUIRE_CONFIRM`.

## Batch sends

If the caller loops over multiple recipients:
- The loop itself MUST confirm the whole batch once before the first send (summary table: count, first recipient, sample body). This is a higher-level gate and is separate from the per-send gate.
- Per-send gates stay off (either by default, or by `MACOS_IMSG_NO_CONFIRM=1`).
- The loop MUST rate-limit: minimum 2 seconds between sends. Faster triggers macOS spam heuristics and messages silently fail.

## What the preview does NOT check

- Whether the recipient wants to hear from you. That is upstream logic (relationships voice rules, escalation playbook, etc.).
- Whether the body has typos. The agent that drafted the body owns that.
- Whether the recipient is on the caller's allowlist. Out of scope.

## Why the gate is off by default

AppleScript sends are irreversible. The old gate defended against typos and wrong-recipient sends, but in practice Adithya reviews the drafted body in the conversation *before* it reaches the send step. Adding a second gate after that review is friction, not safety. Scripted callers with no human watching should set `MACOS_IMSG_REQUIRE_CONFIRM=1` explicitly.
