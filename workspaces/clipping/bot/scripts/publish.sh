#!/bin/bash
# Publish an approved candidate. Default dry-run; LIVE=1 to actually post.
# Usage: bash publish.sh <candidate-id>            # dry-run
#        LIVE=1 bash publish.sh <candidate-id>     # real
source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"
python "$SRC/publish.py" "$@"
