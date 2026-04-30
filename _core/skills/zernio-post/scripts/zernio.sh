#!/bin/bash
# zernio.sh - direct REST wrapper for the Zernio API (zernio.com/api/v1)
#
# Usage:
#   zernio.sh accounts                           List connected accounts (JSON array).
#   zernio.sh creator-info <accountId> [type]    TikTok creator-info precheck. type=video (default) or photo.
#   zernio.sh preflight <file> <platform> [surface]  Local file checks. surface = feed|story|reels|carousel (optional, IG-specific). No network. Exit 0 on pass.
#   zernio.sh presign <file>                     Get {uploadUrl, publicUrl, expires} for a local file.
#   zernio.sh upload <file>                      Presign, PUT bytes, return {publicUrl}. Guards against expired presigned URLs.
#   zernio.sh post <payload.json>                POST /posts with payload. Returns response JSON.
#   zernio.sh status <postId>                    GET /posts/{postId}. Use to poll post status.
#
# Requires: ZERNIO_API_KEY in env, curl, jq, file, stat, ffprobe (optional, for video preflight).
#
# Exits non-zero on any error. Callers should check $? and parse stderr.

set -euo pipefail

BASE_URL="https://zernio.com/api/v1"

die() { echo "zernio.sh: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[[ -n "${ZERNIO_API_KEY:-}" ]] || die "ZERNIO_API_KEY not set"
have curl || die "curl not found"
have jq   || die "jq not found"
have file || die "file (libmagic) not found"

# Portable stat -> bytes
filesize() {
  if stat -f%z "$1" >/dev/null 2>&1; then stat -f%z "$1"; else stat -c%s "$1"; fi
}

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -f -X "$method" \
      -H "Authorization: Bearer ${ZERNIO_API_KEY}" \
      -H "Content-Type: application/json" \
      --data "$body" \
      "${BASE_URL}${path}"
  else
    curl -sS -f -X "$method" \
      -H "Authorization: Bearer ${ZERNIO_API_KEY}" \
      "${BASE_URL}${path}"
  fi
}

cmd="${1:-}"; shift || true

case "$cmd" in
  accounts)
    api GET /accounts
    ;;

  creator-info)
    accountId="${1:?accountId required}"
    mediaType="${2:-video}"
    api GET "/accounts/${accountId}/tiktok/creator-info?mediaType=${mediaType}"
    ;;

  preflight)
    file="${1:?file required}"
    platform="${2:?platform required (instagram|youtube|tiktok|discord)}"
    surface="${3:-}"
    [[ -f "$file"  ]] || die "file not found: $file"
    [[ -s "$file"  ]] || die "file is empty: $file"
    size=$(filesize "$file")
    mime=$(file -b --mime-type "$file")
    case "$platform" in
      instagram)
        case "$mime" in
          image/jpeg|image/png) max=$((8*1024*1024)) ;;
          video/mp4|video/quicktime)
            case "$surface" in
              story)              max=$((100*1024*1024)) ;;
              reels|feed|carousel|"") max=$((300*1024*1024)) ;;
              *) die "instagram: unknown surface '$surface' (use feed|story|reels|carousel)" ;;
            esac
            ;;
          *) die "instagram: unsupported mime: $mime (expected image/jpeg, image/png, video/mp4, video/quicktime)" ;;
        esac
        [[ "$size" -le "$max" ]] || die "instagram: file size $size exceeds cap $max for surface=${surface:-feed}"
        ;;
      youtube)
        case "$mime" in
          video/mp4|video/quicktime|video/x-msvideo|video/x-ms-wmv|video/x-flv|video/3gpp|video/webm) ;;
          *) die "youtube: unsupported mime: $mime" ;;
        esac
        ;;
      tiktok)
        case "$mime" in
          video/mp4|video/quicktime|video/webm)
            max=$((4*1024*1024*1024))
            [[ "$size" -le "$max" ]] || die "tiktok: video size $size exceeds 4GB cap"
            ;;
          image/jpeg|image/png|image/webp)
            max=$((20*1024*1024))
            [[ "$size" -le "$max" ]] || die "tiktok: image size $size exceeds 20MB cap"
            ;;
          *) die "tiktok: unsupported mime: $mime" ;;
        esac
        ;;
      discord)
        # Discord caps default to 25MB. Boosted servers go up to 500MB but Zernio
        # cannot detect boost level cheaply. Pass surface=boosted to opt into the
        # higher cap; otherwise the conservative 25MB applies.
        case "$mime" in
          image/jpeg|image/png|image/gif|image/webp)
            max=$((25*1024*1024))
            [[ "$size" -le "$max" ]] || die "discord: image size $size exceeds 25MB cap"
            ;;
          video/mp4|video/quicktime|video/webm)
            case "$surface" in
              boosted) max=$((500*1024*1024)) ;;
              ""|standard) max=$((25*1024*1024)) ;;
              *) die "discord: unknown surface '$surface' (use standard|boosted)" ;;
            esac
            [[ "$size" -le "$max" ]] || die "discord: video size $size exceeds ${max} cap (surface=${surface:-standard}; pass 'boosted' for boosted-server cap)"
            ;;
          *) die "discord: unsupported mime: $mime (expected image/jpeg|png|gif|webp or video/mp4|quicktime|webm)" ;;
        esac
        ;;
      *) die "unknown platform: $platform" ;;
    esac
    result=$(jq -n \
      --arg file "$file" --argjson size "$size" --arg mime "$mime" --arg platform "$platform" --arg surface "$surface" \
      '{file:$file, size:$size, mime:$mime, platform:$platform, surface:$surface, warnings:[]}')
    # Probe aspect + duration if ffprobe is available. FATAL when a violation is provably wrong.
    if have ffprobe && [[ "$mime" == video/* ]]; then
      duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$file" 2>/dev/null || echo "")
      dims=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$file" 2>/dev/null || echo "")
      result=$(echo "$result" | jq --arg d "$duration" --arg dims "$dims" '. + {duration_s:$d, dims:$dims}')
      width="${dims%%x*}"; height="${dims##*x}"
      if [[ "$platform" == "instagram" && "$surface" == "reels" ]]; then
        awk "BEGIN{exit !($duration > 90)}" && die "instagram reels: duration ${duration}s exceeds 90s cap"
      fi
      if [[ "$platform" == "instagram" && "$surface" == "story" ]]; then
        awk "BEGIN{exit !($duration > 60)}" && die "instagram story: duration ${duration}s exceeds 60s cap"
      fi
      if [[ "$platform" == "tiktok" ]]; then
        awk "BEGIN{exit !($duration < 3)}"   && die "tiktok: duration ${duration}s under 3s minimum"
        awk "BEGIN{exit !($duration > 600)}" && die "tiktok: duration ${duration}s over 10min cap"
        [[ -n "$width" && -n "$height" && "$height" -gt "$width" ]] || die "tiktok: aspect must be 9:16 vertical (got ${dims})"
      fi
      if [[ "$platform" == "youtube" ]]; then
        # Warn (not fail) if not a Short aspect/duration; YT Shorts auto-detects.
        :
      fi
    fi
    echo "$result"
    ;;

  presign)
    file="${1:?file required}"
    [[ -f "$file" ]] || die "file not found: $file"
    fileName=$(basename "$file")
    mime=$(file -b --mime-type "$file")
    # Zernio API requires `filename` (lowercase) and `contentType`, despite the docs showing fileName/fileType.
    # Verified against live API 2026-04-20.
    body=$(jq -n --arg fn "$fileName" --arg ct "$mime" '{filename:$fn, contentType:$ct}')
    api POST /media/presign "$body"
    ;;

  upload)
    file="${1:?file required}"
    [[ -f "$file" ]] || die "file not found: $file"
    mime=$(file -b --mime-type "$file")
    # Zernio presign returns `expiresIn` in seconds (TTL), not an absolute timestamp.
    # Verified against live API 2026-04-20.
    for attempt in 1 2; do
      resp=$("$0" presign "$file")
      uploadUrl=$(echo "$resp" | jq -r .uploadUrl)
      publicUrl=$(echo "$resp" | jq -r .publicUrl)
      expiresIn=$(echo "$resp" | jq -r .expiresIn)
      [[ "$uploadUrl" != "null" && -n "$uploadUrl" ]] || die "presign returned no uploadUrl: $resp"
      if [[ "$expiresIn" != "null" && -n "$expiresIn" && "$expiresIn" -lt 60 ]]; then
        [[ $attempt -lt 2 ]] && continue || die "upload: presigned URL TTL ${expiresIn}s under 60s after refresh"
      fi
      curl -sS -f -X PUT -H "Content-Type: $mime" --data-binary "@${file}" "$uploadUrl" >/dev/null
      jq -n --arg u "$publicUrl" --argjson e "${expiresIn:-0}" '{publicUrl:$u, expiresIn:$e}'
      exit 0
    done
    ;;

  post)
    payload="${1:?payload.json required}"
    [[ -f "$payload" ]] || die "payload file not found: $payload"
    api POST /posts "$(cat "$payload")"
    ;;

  discord-channels)
    accountId="${1:?accountId required}"
    api GET "/accounts/${accountId}/discord-channels"
    ;;

  discord-settings)
    accountId="${1:?accountId required}"
    api GET "/accounts/${accountId}/discord-settings"
    ;;

  discord-settings-update)
    accountId="${1:?accountId required}"
    payload="${2:?payload.json required}"
    [[ -f "$payload" ]] || die "payload file not found: $payload"
    api PATCH "/accounts/${accountId}/discord-settings" "$(cat "$payload")"
    ;;

  status)
    postId="${1:?postId required}"
    api GET "/posts/${postId}"
    ;;

  *)
    grep "^# " "$0" | head -20 >&2
    die "unknown command: ${cmd:-<none>}"
    ;;
esac
