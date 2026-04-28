# Install the contacts cron

```
ln -sf "$(pwd)/com.shakstzy.quantum-contacts.plist" ~/Library/LaunchAgents/com.shakstzy.quantum-contacts.plist
launchctl load -w ~/Library/LaunchAgents/com.shakstzy.quantum-contacts.plist
```

Daily 4am. Logs at `~/Library/Logs/quantum-contacts.{log,stdout.log,stderr.log}`.

## Permissions

First run will prompt macOS for **Contacts access** for `osascript`. Grant it once. After that the cron runs unattended.

If you ever revoke and re-grant: `launchctl unload && load` the plist to re-trigger the prompt.

## Uninstall

```
launchctl unload -w ~/Library/LaunchAgents/com.shakstzy.quantum-contacts.plist
rm ~/Library/LaunchAgents/com.shakstzy.quantum-contacts.plist
```

## Manual run

```
cd workspaces/contacts && bash scripts/pull.sh
```

Idempotent. Safe to run repeatedly.
