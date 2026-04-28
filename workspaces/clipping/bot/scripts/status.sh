#!/bin/bash
# Print pipeline status: DB counts + queue depths + most-recent activity
source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"
python "$SRC/db.py" status
