#!/bin/bash
# zernio-ads.sh - direct REST wrapper for the Zernio Ads API (zernio.com/api/v1/ads)
#
# All read-only commands are safe to run anytime. Write commands move money: callers
# MUST gate them on the LAUNCH-AD confirmation token defined in rules/launch-gate.md.
#
# Read commands:
#   zernio-ads.sh ad-accounts [accountId]                        List platform ad accounts (filter to one social account if id given).
#   zernio-ads.sh list-ads [adAccountId] [platform]              List ads, optionally scoped to ad account or platform.
#   zernio-ads.sh get-ad <adId>                                  Get one ad (creative, targeting, status, metrics).
#   zernio-ads.sh ad-analytics <adId> [fromDate] [toDate]        Daily analytics for an ad. ISO dates; defaults to last 30 days.
#   zernio-ads.sh ad-comments <adId>                             List comments on an ad's underlying creative post.
#   zernio-ads.sh tree [adAccountId]                             Nested Campaign > Ad Set > Ad with rolled-up metrics.
#   zernio-ads.sh list-campaigns [adAccountId]                   List campaigns (virtual aggregations over ads).
#   zernio-ads.sh list-audiences [adAccountId]                   List custom audiences.
#   zernio-ads.sh get-audience <audienceId>                      Get one audience (local + Meta refresh).
#   zernio-ads.sh search-interests <q> <accountId> [platform]    Look up interest targeting options (Meta/TikTok/Pinterest).
#   zernio-ads.sh conversion-destinations <accountId>            List Meta pixels / Google conversion actions for the connected ads account.
#
# Write commands (require LAUNCH-AD gate):
#   zernio-ads.sh boost-post <payload.json>                      POST /v1/ads/boost - boost an existing Zernio post into a paid ad.
#   zernio-ads.sh create-ad <payload.json>                       POST /v1/ads/create - standalone ad with custom creative.
#   zernio-ads.sh create-ctwa <payload.json>                     POST /v1/ads/ctwa - Click-to-WhatsApp ad on Meta.
#   zernio-ads.sh update-ad <adId> <payload.json>                PUT  /v1/ads/{adId} - status, budget, name, targeting (Meta).
#   zernio-ads.sh cancel-ad <adId>                               DELETE /v1/ads/{adId} - cancel on platform, preserve history.
#   zernio-ads.sh update-campaign <campaignId> <payload.json>    PUT  /v1/ads/campaigns/{id} - CBO budget edits.
#   zernio-ads.sh campaign-status <campaignId> <ACTIVE|PAUSED>   PUT  /v1/ads/campaigns/{id}/status.
#   zernio-ads.sh delete-campaign <campaignId>                   DELETE /v1/ads/campaigns/{id} - cascades on Meta.
#   zernio-ads.sh duplicate-campaign <campaignId> [payload.json] POST /v1/ads/campaigns/{id}/duplicate.
#   zernio-ads.sh bulk-status <payload.json>                     POST /v1/ads/campaigns/bulk-status - up to 50 campaigns/call.
#   zernio-ads.sh update-ad-set <adSetId> <payload.json>         PUT  /v1/ads/ad-sets/{id} - ABO budgets, status.
#   zernio-ads.sh ad-set-status <adSetId> <ACTIVE|PAUSED>        PUT  /v1/ads/ad-sets/{id}/status.
#   zernio-ads.sh create-audience <payload.json>                 POST /v1/ads/audiences - PII syncs to Meta after this returns.
#   zernio-ads.sh add-audience-users <audienceId> <payload.json> POST /v1/ads/audiences/{id}/users - hashed server-side, max 10k/call.
#   zernio-ads.sh delete-audience <audienceId>                   DELETE /v1/ads/audiences/{id}.
#   zernio-ads.sh send-conversions <payload.json>                POST /v1/ads/conversions - Meta CAPI / Google ingestEvents.
#   zernio-ads.sh connect-ads <platform> [accountId]             GET  /v1/connect/{platform}/ads - opens OAuth or links token.
#
# Requires: ZERNIO_API_KEY in env (same key as zernio-post), curl, jq.
#
# Exits non-zero on any error. Callers should check $? and parse stderr.

set -euo pipefail

BASE_URL="https://zernio.com/api/v1"

die() { echo "zernio-ads.sh: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[[ -n "${ZERNIO_API_KEY:-}" ]] || die "ZERNIO_API_KEY not set (lives in QUANTUM .claude/settings.local.json)"
have curl || die "curl not found"
have jq   || die "jq not found"

# Platform enum guard: ads platforms differ from organic platforms.
ads_platform_ok() {
  case "$1" in
    metaads|googleads|linkedinads|tiktokads|pinterestads|xads) return 0 ;;
    *) return 1 ;;
  esac
}

# Connect-ads platform enum: lowercase posting-platform name (Zernio derives the ads variant).
connect_platform_ok() {
  case "$1" in
    facebook|instagram|linkedin|pinterest|tiktok|twitter|googleads) return 0 ;;
    *) return 1 ;;
  esac
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

# Build a query string from key=value pairs, skipping empty values.
qs() {
  local out=""
  for kv in "$@"; do
    local k="${kv%%=*}" v="${kv#*=}"
    [[ -z "$v" ]] && continue
    if [[ -z "$out" ]]; then out="?${k}=${v}"; else out="${out}&${k}=${v}"; fi
  done
  printf '%s' "$out"
}

cmd="${1:-}"; shift || true

case "$cmd" in
  # ---------- read ----------
  ad-accounts)
    accountId="${1:-}"
    api GET "/ads/accounts$(qs accountId="$accountId")"
    ;;

  list-ads)
    adAccountId="${1:-}"; platform="${2:-}"
    if [[ -n "$platform" ]] && ! ads_platform_ok "$platform"; then
      die "list-ads: bad platform '$platform' (use metaads|googleads|linkedinads|tiktokads|pinterestads|xads)"
    fi
    api GET "/ads$(qs adAccountId="$adAccountId" platform="$platform")"
    ;;

  get-ad)
    adId="${1:?adId required}"
    api GET "/ads/${adId}"
    ;;

  ad-analytics)
    adId="${1:?adId required}"; fromDate="${2:-}"; toDate="${3:-}"
    api GET "/ads/${adId}/analytics$(qs fromDate="$fromDate" toDate="$toDate")"
    ;;

  ad-comments)
    adId="${1:?adId required}"
    api GET "/ads/${adId}/comments"
    ;;

  tree)
    adAccountId="${1:-}"
    api GET "/ads/tree$(qs adAccountId="$adAccountId")"
    ;;

  list-campaigns)
    adAccountId="${1:-}"
    api GET "/ads/campaigns$(qs adAccountId="$adAccountId")"
    ;;

  list-audiences)
    adAccountId="${1:-}"
    api GET "/ads/audiences$(qs adAccountId="$adAccountId")"
    ;;

  get-audience)
    audienceId="${1:?audienceId required}"
    api GET "/ads/audiences/${audienceId}"
    ;;

  search-interests)
    q="${1:?query required}"; accountId="${2:?accountId required}"; platform="${3:-}"
    if [[ -n "$platform" ]] && ! ads_platform_ok "$platform"; then
      die "search-interests: bad platform '$platform'"
    fi
    api GET "/ads/interests$(qs q="$q" accountId="$accountId" platform="$platform")"
    ;;

  conversion-destinations)
    accountId="${1:?accountId required}"
    api GET "/accounts/${accountId}/conversion-destinations"
    ;;

  # ---------- write (LAUNCH-AD gate enforced by caller) ----------
  boost-post)
    payload="${1:?payload.json required}"
    [[ -f "$payload" ]] || die "payload not found: $payload"
    api POST /ads/boost "$(cat "$payload")"
    ;;

  create-ad)
    payload="${1:?payload.json required}"
    [[ -f "$payload" ]] || die "payload not found: $payload"
    api POST /ads/create "$(cat "$payload")"
    ;;

  create-ctwa)
    payload="${1:?payload.json required}"
    [[ -f "$payload" ]] || die "payload not found: $payload"
    api POST /ads/ctwa "$(cat "$payload")"
    ;;

  update-ad)
    adId="${1:?adId required}"; payload="${2:?payload.json required}"
    [[ -f "$payload" ]] || die "payload not found: $payload"
    api PUT "/ads/${adId}" "$(cat "$payload")"
    ;;

  cancel-ad)
    adId="${1:?adId required}"
    api DELETE "/ads/${adId}"
    ;;

  update-campaign)
    campaignId="${1:?campaignId required}"; payload="${2:?payload.json required}"
    [[ -f "$payload" ]] || die "payload not found: $payload"
    api PUT "/ads/campaigns/${campaignId}" "$(cat "$payload")"
    ;;

  campaign-status)
    campaignId="${1:?campaignId required}"; status="${2:?status required (ACTIVE|PAUSED)}"
    [[ "$status" == "ACTIVE" || "$status" == "PAUSED" ]] || die "status must be ACTIVE or PAUSED, got '$status'"
    api PUT "/ads/campaigns/${campaignId}/status" "$(jq -n --arg s "$status" '{status:$s}')"
    ;;

  delete-campaign)
    campaignId="${1:?campaignId required}"
    api DELETE "/ads/campaigns/${campaignId}"
    ;;

  duplicate-campaign)
    campaignId="${1:?campaignId required}"; payload="${2:-}"
    if [[ -n "$payload" ]]; then
      [[ -f "$payload" ]] || die "payload not found: $payload"
      api POST "/ads/campaigns/${campaignId}/duplicate" "$(cat "$payload")"
    else
      api POST "/ads/campaigns/${campaignId}/duplicate" "{}"
    fi
    ;;

  bulk-status)
    payload="${1:?payload.json required}"
    [[ -f "$payload" ]] || die "payload not found: $payload"
    api POST /ads/campaigns/bulk-status "$(cat "$payload")"
    ;;

  update-ad-set)
    adSetId="${1:?adSetId required}"; payload="${2:?payload.json required}"
    [[ -f "$payload" ]] || die "payload not found: $payload"
    api PUT "/ads/ad-sets/${adSetId}" "$(cat "$payload")"
    ;;

  ad-set-status)
    adSetId="${1:?adSetId required}"; status="${2:?status required (ACTIVE|PAUSED)}"
    [[ "$status" == "ACTIVE" || "$status" == "PAUSED" ]] || die "status must be ACTIVE or PAUSED, got '$status'"
    api PUT "/ads/ad-sets/${adSetId}/status" "$(jq -n --arg s "$status" '{status:$s}')"
    ;;

  create-audience)
    payload="${1:?payload.json required}"
    [[ -f "$payload" ]] || die "payload not found: $payload"
    api POST /ads/audiences "$(cat "$payload")"
    ;;

  add-audience-users)
    audienceId="${1:?audienceId required}"; payload="${2:?payload.json required}"
    [[ -f "$payload" ]] || die "payload not found: $payload"
    # Local guard: max 10,000 users per request per Zernio docs.
    n=$(jq '.users | length' "$payload" 2>/dev/null || echo 0)
    [[ "$n" -le 10000 ]] || die "add-audience-users: $n users in payload exceeds 10000 cap"
    api POST "/ads/audiences/${audienceId}/users" "$(cat "$payload")"
    ;;

  delete-audience)
    audienceId="${1:?audienceId required}"
    api DELETE "/ads/audiences/${audienceId}"
    ;;

  send-conversions)
    payload="${1:?payload.json required}"
    [[ -f "$payload" ]] || die "payload not found: $payload"
    api POST /ads/conversions "$(cat "$payload")"
    ;;

  connect-ads)
    platform="${1:?platform required (facebook|instagram|linkedin|pinterest|tiktok|twitter|googleads)}"
    accountId="${2:-}"
    connect_platform_ok "$platform" || die "connect-ads: bad platform '$platform'"
    api GET "/connect/${platform}/ads$(qs accountId="$accountId")"
    ;;

  # ---------- meta ----------
  help|"")
    grep "^# " "$0" | head -40 >&2
    [[ -z "$cmd" ]] && exit 1 || exit 0
    ;;

  *)
    grep "^# " "$0" | head -40 >&2
    die "unknown command: $cmd"
    ;;
esac
