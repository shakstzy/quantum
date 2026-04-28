#!/bin/bash
# Integration smoke test: fake DB rows -> gate -> publish dry-run -> track northstar.
# Does NOT exercise yt-dlp / whisper / Remotion render (those require network + model dl).
# Run separately: bash bot/scripts/smoke-render.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

DB_PY="$SRC/db.py"
echo "== smoke 1/6: init DB =="
python "$DB_PY" init >/dev/null
python "$DB_PY" status

echo "== smoke 2/6: insert fake campaign + source + account + candidate =="
python <<'PY'
import sys, os, json
sys.path.insert(0, os.environ['CLIPPING_WS_ROOT'] + '/bot/src')
import db

cid = db.upsert_campaign(
    slug="smoke-saas-whop",
    source="whop",
    url="https://whop.com/smoke",
    payer="SmokeBrand",
    niche="ai-saas",
    rate_per_1k_usd=3.0,
    min_views=1000,
    max_payout_usd=200.0,
    total_paid_out_usd=5000.0,
    scam_score=10,
    scam_signals=json.dumps(["plausible_cpm","paid_out_over_1k"]),
    status="active",
    rules_json=json.dumps({"required_hashtags":["#ai"]}),
    notes="smoke test",
    verified_at="2026-04-28",
)
print(f"  campaign id={cid}")

with db.conn() as c:
    c.execute("""INSERT OR IGNORE INTO sources(source_video_id, url, title, creator, duration_s,
                  audio_hash, campaign_id, rights_status, rights_evidence, filepath)
                  VALUES (?,?,?,?,?,?,?,?,?,?)""",
              ("smoke-vid-1", "https://example.test/podcast/1", "Smoke Podcast Ep 1",
               "SmokeCreator", 1800.0, "abc123hash", cid, "campaign_allowed",
               "campaign rules permit clipping creator's public episodes",
               "/dev/null"))
    sid = c.execute("SELECT id FROM sources WHERE source_video_id='smoke-vid-1'").fetchone()["id"]
    c.execute("""INSERT OR IGNORE INTO accounts(alias, platform, niche, daily_post_cap,
                  hourly_post_cap, status, follower_count)
                  VALUES (?,?,?,?,?,?,?)""",
              ("smoke-tt-saas", "tiktok", "ai-saas", 3, 1, "active", 1500))
    aid = c.execute("SELECT id FROM accounts WHERE alias='smoke-tt-saas'").fetchone()["id"]

cand_id = db.insert_candidate(
    source_id=sid,
    campaign_id=cid,
    start_s=120.0,
    end_s=165.0,
    hook="Why most AI tools die in their first quarter",
    rank_score=78.0,
    rank_rationale="contrarian opening, named stat, clean close",
    transcript_excerpt="Most AI tools fail because they solve a problem that doesn't pay. Founders chase technical novelty over market urgency. The ones that survive treat every demo as a sales call.",
    ngram_hash="a"*64,
    perceptual_hash="b"*64,
    duplicate_score=0.1,
    status="candidate",
)
print(f"  source id={sid} account id={aid} candidate id={cand_id}")
PY

echo "== smoke 3/6: gate (expect rejection because no qa_review yet) =="
CAND_ID="$(python -c "
import sys, os; sys.path.insert(0, os.environ['CLIPPING_WS_ROOT']+'/bot/src')
import db
with db.conn() as c:
    print(c.execute('SELECT id FROM clip_candidates ORDER BY id DESC LIMIT 1').fetchone()['id'])")"
ACCT_ID="$(python -c "
import sys, os; sys.path.insert(0, os.environ['CLIPPING_WS_ROOT']+'/bot/src')
import db
with db.conn() as c:
    print(c.execute(\"SELECT id FROM accounts WHERE alias='smoke-tt-saas'\").fetchone()['id'])")"
python "$SRC/gate.py" "$CAND_ID" "$ACCT_ID" --caption "Why most AI tools die in their first quarter #ad #aisaas" || true

echo "== smoke 4/6: simulate qa approve, then re-gate (expect pass) =="
python <<PY
import sys, os; sys.path.insert(0, os.environ['CLIPPING_WS_ROOT']+'/bot/src')
import db
db.insert_qa(candidate_id=$CAND_ID, reviewer="smoke", decision="approve", reasons="manual smoke",
             rights_check=1, disclosure_check=1, originality_check=1, duplicate_check=1,
             account_fit_check=1, campaign_fit_check=1, platform_risk_score=10)
db.update_candidate_status($CAND_ID, "qa_approved")
PY
python "$SRC/gate.py" "$CAND_ID" "$ACCT_ID" --caption "Why most AI tools die in their first quarter #ad #aisaas"

echo "== smoke 5/6: insert fake render + run publish dry-run =="
python <<PY
import sys, os; sys.path.insert(0, os.environ['CLIPPING_WS_ROOT']+'/bot/src')
import db
db.insert_render(candidate_id=$CAND_ID, template="vertical-captions-v1",
                 filepath="/tmp/fake-render.mp4", duration_s=45.0,
                 render_hash="d"*64)
PY
python "$SRC/publish.py" "$CAND_ID" || true

echo "== smoke 6/6: track northstar + kill-list =="
python "$SRC/track.py" northstar
python "$SRC/track.py" kill-list

echo "=== smoke complete ==="
python "$DB_PY" status
