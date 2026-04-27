# quantum-sync

Periodic git auto-sync daemon for this repo. Runs every 60s via macOS launchd.

## What it does
On each tick:
1. Skips if another sync is running, or if git is mid-operation (rebase/merge/index.lock).
2. Stages all changes (`git add -A`).
3. **Secret scan** on the staged diff (AWS, OpenAI/Anthropic, GitHub PAT, Slack, private keys). Aborts and unstages if hit.
4. Auto-commits as `quantum-sync <auto-sync@local>` with message `chore(auto-sync): <timestamp>`.
5. `git pull --rebase --autostash origin main`.
6. `git push` if local is ahead.

Logs to `~/Library/Logs/quantum-sync.log`.

## Install
```bash
cp scripts/com.shakstzy.quantum-sync.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.shakstzy.quantum-sync.plist
```

## Status / control
```bash
launchctl list | grep quantum-sync          # check it's loaded
tail -f ~/Library/Logs/quantum-sync.log     # watch activity
launchctl unload ~/Library/LaunchAgents/com.shakstzy.quantum-sync.plist   # stop
```

## Run once manually
```bash
bash scripts/sync.sh
```

## Notes
- Auto-commits fragment history. Squash before merging anywhere that cares.
- Conflict during rebase → daemon stops touching the repo and logs. Resolve manually, then it resumes next tick.
- Branch is hardcoded to `main` in `sync.sh`.
