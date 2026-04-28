#!/bin/bash
# Render a clip_candidate to vertical 9:16 mp4 with word-level captions.
# Usage: bash render.sh <candidate-id>
source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"
python "$SRC/compose.py" "$@"
