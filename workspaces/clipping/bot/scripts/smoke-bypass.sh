#!/bin/bash
# Bypass-attempt test: try to insert a publish_attempts row WITHOUT a gate_decision_id.
# The schema's NOT NULL constraint on gate_decision_id must reject this.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

echo "== bypass attempt: insert publish_attempts without gate_decision_id =="
python <<'PY'
import sys, os, sqlite3
sys.path.insert(0, os.environ['CLIPPING_WS_ROOT'] + '/bot/src')
import db

# Find or create at least one row in dependent tables so the FK refs hit
with db.conn() as c:
    cand = c.execute("SELECT id FROM clip_candidates LIMIT 1").fetchone()
    rend = c.execute("SELECT id FROM renders LIMIT 1").fetchone()
    acct = c.execute("SELECT id FROM accounts LIMIT 1").fetchone()
    if not (cand and rend and acct):
        print("no fixture rows; run smoke.sh first"); sys.exit(2)

    try:
        c.execute(
            "INSERT INTO publish_attempts(candidate_id, render_id, account_id, status) VALUES (?,?,?,?)",
            (cand['id'], rend['id'], acct['id'], 'queued'),
        )
        print("BYPASS SUCCEEDED: this should not happen, schema is broken")
        sys.exit(1)
    except sqlite3.IntegrityError as e:
        print(f"OK: bypass blocked by schema: {e}")
        sys.exit(0)
PY
