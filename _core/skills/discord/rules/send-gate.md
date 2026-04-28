# Send Gate

Policy for when `dm` and `send` pause for human confirmation before hitting Discord's `POST /channels/<id>/messages`.

## Default: no gate

Mirrors the iMessage and slack skills. Adithya is driving the terminal in real time. The agent PREVIEWS the target and body to stderr, then sends immediately. The preview IS the gate.

Preview format:
```
DM <recipient> (channel <id>)
<body>
```
or
```
SEND to channel <id>
<body>
```

If the agent is wrong about target or body, Adithya sees the preview flash by and can follow up with a correction or a delete via Discord's own UI. The cost of an extra Discord message is much lower than the cost of a `CONFIRM` prompt on every send.

## When to enable the gate

Set `QUANTUM_DISCORD_REQUIRE_CONFIRM=1` in the environment when:

- **Unattended cron or scheduled agent.** No human at the keyboard. The gate becomes a stop-check: if the agent hit `dm` or `send` during an automation, the run will block on stdin and eventually time out rather than blasting a channel.
- **Ambiguous identity.** Friend resolution returned a partial match. The friends-list resolver already aborts on multi-match, but the gate adds a second look at the picked recipient.
- **Large audience channel.** Posting to a guild channel with 50+ members. One bad message is highly visible.
- **Public servers or community channels.** Anywhere your post is searchable by people outside your friends list. Permanent record, screenshot risk.

With the gate on, the script reads one line from stdin. Anything other than the literal string `CONFIRM` aborts with exit 2.

## When NOT to gate

- DMs to a single friend whose ID just resolved by exact match.
- Self-DM (confirmation lab).
- Replies in a channel where the agent already read context.
- Any read-only verb (`whoami`, `friends`, `read`, `search`, `list-dms`, `resolve-user`, `resolve-channel`, `status`).

## How the gate interacts with stdin body input

`dm` and `send` accept body via argv OR stdin. If the gate is on AND the body came from stdin, the script has already consumed stdin for the body, so the confirm prompt cannot read from it. Two options:

1. Pass the body as argv instead when gating is required.
2. Run interactively with a visible body:
   ```bash
   QUANTUM_DISCORD_REQUIRE_CONFIRM=1 node scripts/run.mjs dm friendname "hi"
   # script prints preview, waits on stdin, type CONFIRM
   ```

For fully-scripted workflows (e.g., a scheduled agent that DMs daily summaries), either pre-approve in a wrapper script that pipes `CONFIRM\n` after presenting the preview to a human through another channel, or leave the gate off and rely on the preview log as an audit trail.

## Why not always-gate

Always-gating makes every send require two round-trips (preview + CONFIRM) when Adithya is actively watching. That doubles latency and drowns the conversation in ritual. Preview-only is the right default for interactive sends. The gate is there for the narrow subset of flows where interactive eyes are not present.

## Discord-specific risk amplifier

Unlike Slack, where a bad post in a small workspace is contained, Discord channels are often public-facing or guild-wide. A misfired send into the wrong channel is harder to walk back. Lean toward enabling the gate any time `send <channel-id>` is used inside a guild you don't own.
