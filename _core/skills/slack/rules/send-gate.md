# Send Gate

Policy for when the `send` verb pauses for human confirmation before hitting `chat.postMessage`.

## Default: no gate

Mirrors the iMessage skill. Adithya is driving the terminal in real time. The agent PREVIEWS the target and body to stderr, then sends immediately. The preview IS the gate.

Preview format:
```
SEND TO <target> (channel <id>)
---
<body>
---
```

If the agent is wrong about target or body, Adithya sees the preview flash by and can follow up with a correction or a delete via Slack's own UI. The cost of an extra Slack message is much lower than the cost of a `CONFIRM` prompt on every send.

## When to enable the gate

Set `QUANTUM_SLACK_REQUIRE_CONFIRM=1` in the environment when:

- **Unattended cron or scheduled agent.** No human at the keyboard. The gate becomes a stop-check: if the agent hit `send` during an automation, the run will block on stdin and eventually time out rather than blasting a channel.
- **Ambiguous identity.** The agent is about to post to a channel it cannot positively identify (name collision between `#eng-general` and `#eng-general-2`, or username shared between two Adithyas).
- **Large audience channel.** Posting to `#general` or any channel with 50+ members. One bad message is highly visible; the confirm cost is worth it.
- **External partner or customer channel.** Slack Connect channels where recipients are outside the workspace.

With the gate on, the script reads one line from stdin. Anything other than the literal string `CONFIRM` aborts with exit 2.

## When NOT to gate

- DMs to self (confirmation lab).
- DMs to a single teammate whose ID the agent just resolved by exact match.
- Replies in a channel where the agent is already reading and has established context (thread reply to a message the user just pointed at).
- Any read-only verb (`read`, `search`, `users`, `channels`, `whoami`).

## How the gate interacts with stdin body input

`send` accepts body via argv OR stdin. If the gate is on AND the body came from stdin, the script has already consumed stdin for the body, so the confirm prompt cannot read from it. Two options:

1. Pass the body as argv instead when gating is required.
2. Use a heredoc with a visible body, then confirm interactively:
   ```
   QUANTUM_SLACK_REQUIRE_CONFIRM=1 node scripts/run.mjs send "#channel" "hello team"
   # script prints preview, waits on stdin, types CONFIRM
   ```

For fully-scripted workflows (e.g., a scheduled agent that sends daily summaries), either pre-approve in a wrapper script that pipes `CONFIRM\n` after presenting the preview to a human through another channel, or leave the gate off and rely on the preview log as an audit trail.

## Why not always-gate

Always-gating makes every send require two round-trips (preview + CONFIRM) when Adithya is actively watching. That doubles latency and drowns the conversation in ritual. The iMessage experience proved preview-only is the right default for interactive sends. The gate is there for the narrow subset of flows where interactive eyes are not present.
