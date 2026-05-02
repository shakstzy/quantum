# Cron (launchd) install

Three plists in this directory schedule the bot. Source of truth lives here under version control; symlink into `~/Library/LaunchAgents/` and load.

## Install

```
cd workspaces/bumble/setup
for plist in com.shakstzy.quantum-bumble-*.plist; do
  ln -sf "$(pwd)/$plist" ~/Library/LaunchAgents/$plist
  launchctl load -w ~/Library/LaunchAgents/$plist
done
```

## Uninstall

```
for plist in com.shakstzy.quantum-bumble-*.plist; do
  launchctl unload -w ~/Library/LaunchAgents/$plist
  rm ~/Library/LaunchAgents/$plist
done
```

## What runs when (Adithya local time, CST)

| Plist | Calendar | Behavior |
|-------|----------|----------|
| swipe | 12:30 lunch + 21:00 evening | Each fire sleeps 0-30 min then runs one swipe session. Self-skips on random days (~20% probability). |
| pull  | 15:00 + 23:00 | Each fire sleeps 0-30 min, runs `pull` then `decide`. |
| send  | 10 fires across 9:15-22:30 | Each fire sleeps 0-15 min, sends ONE message from approved queue. The hourly cap (10/hr) is enforced regardless. |

## Logs

```
~/Library/Logs/quantum-bumble.log         (combined)
~/Library/Logs/quantum-bumble.stdout.log
~/Library/Logs/quantum-bumble.stderr.log
~/.quantum/bumble/sessions.ndjson         (structured session events)
```

## Env vars launchd needs

Set in each plist's `EnvironmentVariables` block OR source `~/.quantum/bumble/env` at script top:
- `QUANTUM_SELF_PHONE` (E.164, for HITL nudges)
- `QUANTUM_BUMBLE_MODEL` (optional, defaults to `sonnet`)

Recommended `~/.quantum/bumble/env`:
```
QUANTUM_SELF_PHONE=+15125551234
QUANTUM_BUMBLE_MODEL=sonnet
```

## Important

DO NOT load the plists until selectors are wired and a manual end-to-end test against one real match has passed. Before then, the cron will fire scripts that throw `pre-discovery` errors and accumulate noise in the halt file.
