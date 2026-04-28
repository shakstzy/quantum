#!/bin/bash
# Download a long-form source for an active campaign.
# Usage: bash source.sh <campaign-slug> <url> --rights <authorized|campaign_allowed|fair_use_review> --evidence "<why>"
source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"
python "$SRC/source.py" "$@"
