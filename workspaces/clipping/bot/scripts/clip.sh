#!/bin/bash
# transcribe + rank + cut + fingerprint + persist candidates for a source
# Usage: bash clip.sh <source-id> [--top 5]
source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"
python "$SRC/clip.py" "$@"
