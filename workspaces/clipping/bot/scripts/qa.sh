#!/bin/bash
# Run the pre-publish gate against (candidate-id, account-id) and write qa_reviews
# Usage: bash qa.sh <candidate-id> <account-id> [--caption "..."]  [--apply]
source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"
python "$SRC/gate.py" "$@"
