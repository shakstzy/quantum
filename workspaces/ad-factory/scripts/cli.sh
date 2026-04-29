#!/usr/bin/env bash
set -euo pipefail

# ad-factory top-level CLI
# Subcommands: new, host-new, run

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cmd="${1:-}"
case "$cmd" in
  new)
    slug="${2:?usage: cli.sh new <product-slug>}"
    target="$ROOT/inbox/$slug"
    if [[ -d "$target" ]]; then
      echo "inbox/$slug already exists" >&2
      exit 1
    fi
    mkdir -p "$target/product"
    cat > "$target/brief.md" <<EOF
# $slug

## Product
- Name:
- Niche:
- Link:
- USP (one sentence):
- CTA:

## Audience
- Age band:
- Gender:
- Pain point:

## Hashtags (for research stage, comma-separated)
-

## Tone
- e.g., authoritative-skeptic, hype-bro, casual-friend

## Host
- (filled at stage 02 after picking from shared/hosts/)

## Notes
-
EOF
    echo "scaffolded inbox/$slug/"
    echo "  fill brief.md, drop product images into product/, then run:"
    echo "  bash stages/01-research/scripts/run.sh $slug"
    ;;

  host-new)
    topic="${2:?usage: cli.sh host-new <topic> <handle>}"
    handle="${3:?usage: cli.sh host-new <topic> <handle>}"
    target="$ROOT/shared/hosts/${topic}-${handle}"
    if [[ -d "$target" ]]; then
      echo "host shared/hosts/${topic}-${handle} already exists" >&2
      exit 1
    fi
    cp -R "$ROOT/shared/hosts/_template" "$target"
    echo "scaffolded shared/hosts/${topic}-${handle}/"
    echo "  fill persona.md, look.md, voice.md, drop reference images into reference-images/"
    ;;

  run)
    slug="${2:?usage: cli.sh run <product-slug>}"
    echo "[ad-factory/cli] run $slug -> 01-research -> 02-script -> 03-render -> 04-edit"
    echo "all stages currently unwired (v0 scaffold). exiting."
    exit 1
    ;;

  *)
    echo "usage: cli.sh {new <slug> | host-new <topic> <handle> | run <slug>}" >&2
    exit 2
    ;;
esac
