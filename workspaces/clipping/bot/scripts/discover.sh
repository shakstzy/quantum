#!/bin/bash
# Verify and persist a clipper bounty.
# Usage:
#   bash discover.sh --file ~/inbox/whop-page.md --source whop
#   bash discover.sh --url https://whop.com/... --source whop
source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"
python "$SRC/discover.py" "$@"
