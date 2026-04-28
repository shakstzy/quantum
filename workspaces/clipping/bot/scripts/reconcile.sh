#!/bin/bash
# Refresh metrics, recompute north-star, surface kill-list.
source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"
python "$SRC/track.py" refresh
python "$SRC/track.py" northstar
python "$SRC/track.py" kill-list
python "$SRC/track.py" ingest-payouts
