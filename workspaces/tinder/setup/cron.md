# Cron (launchd) install

Three plists in this directory schedule the bot. They live in QUANTUM under version control as the source of truth; you symlink them into `~/Library/LaunchAgents/` and load them.

## Install

```
cd workspaces/tinder/setup
for plist in com.shakstzy.quantum-tinder-*.plist; do
  ln -sf "$(pwd)/$plist" ~/Library/LaunchAgents/$plist
  launchctl load -w ~/Library/LaunchAgents/$plist
done
```

## Uninstall

```
for plist in com.shakstzy.quantum-tinder-*.plist; do
  launchctl unload -w ~/Library/LaunchAgents/$plist
  rm ~/Library/LaunchAgents/$plist
done
```

## What runs when (Adithya local time, CST)

| Plist | Calendar | Behavior |
|-------|----------|----------|
| swipe | 12:30 lunch + 21:00 evening | Each fire sleeps 0-30 min then runs one swipe session. Self-skips on random days (~18% probability) to mimic real human gaps. |
| pull  | 15:00 + 23:00 | Each fire sleeps 0-30 min, runs `pull` (matches + threads scrape) then `decide` (drafts + queues). |
| send  | 8 fires across 9:15-22:30 | Each fire sleeps 0-10 min, sends ONE message from approved queue (or noop if empty). The hourly cap (20/hr) is enforced by the rate limiter regardless of cron frequency. |

## Logs

```
~/Library/Logs/quantum-tinder.log         (combined)
~/Library/Logs/quantum-tinder.stdout.log
~/Library/Logs/quantum-tinder.stderr.log
~/.quantum/tinder/sessions.ndjson         (structured session events)
```

## Env vars launchd needs

The plists set a baseline PATH but launchd doesn't inherit your shell env. You need:

- `ANTHROPIC_API_KEY`  -  for the drafting model
- `QUANTUM_SELF_PHONE`  -  your number in E.164 (e.g. `+15125551234`) for HITL nudges

The cleanest way is to add an `EnvironmentVariables` block to each plist OR (better) edit `bot/scripts/decide.mjs` and `send.mjs` to source `~/.quantum/tinder/env` at the top. The latter avoids checking secrets into git.

Recommended `~/.quantum/tinder/env`:

```
ANTHROPIC_API_KEY=sk-ant-...
QUANTUM_SELF_PHONE=+15125551234
```

Then in each script (TODO: not auto-wired in v0.1; do this manually before installing the plists):

```
import "dotenv/config";
```

Or set them inline in each plist's `EnvironmentVariables` dict (less clean, but works).
