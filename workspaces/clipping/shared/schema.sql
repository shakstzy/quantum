-- clipping control plane schema
-- One source of truth at ~/.quantum/clipping/clipping.db
-- Bumped to v2 per Adv Review v2: every artifact on disk has a row here.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('whop','vyro','discord','direct','skool','clipster','other')),
  url TEXT,
  payer TEXT,
  niche TEXT,
  rate_per_1k_usd REAL,
  min_views INTEGER,
  max_payout_usd REAL,
  total_paid_out_usd REAL,
  scam_score INTEGER NOT NULL DEFAULT 50,
  scam_signals TEXT,
  verified_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','paused','dead')),
  rules_json TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_video_id TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  creator TEXT,
  duration_s REAL,
  audio_hash TEXT,
  campaign_id INTEGER REFERENCES campaigns(id),
  rights_status TEXT NOT NULL CHECK(rights_status IN ('authorized','campaign_allowed','fair_use_review','unauthorized','unknown')),
  rights_evidence TEXT,
  downloaded_at TEXT,
  filepath TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  model_version TEXT NOT NULL,
  audio_hash TEXT NOT NULL,
  filepath TEXT NOT NULL,
  word_count INTEGER,
  duration_s REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_id, model_version)
);

CREATE TABLE IF NOT EXISTS clip_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  hook TEXT,
  rank_score REAL,
  rank_rationale TEXT,
  transcript_excerpt TEXT,
  ngram_hash TEXT,
  perceptual_hash TEXT,
  duplicate_score REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','rendered','qa_approved','qa_rejected','published','dead')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS renders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES clip_candidates(id) ON DELETE CASCADE,
  template TEXT NOT NULL,
  filepath TEXT NOT NULL,
  duration_s REAL,
  render_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS qa_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES clip_candidates(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject','defer')),
  reasons TEXT,
  rights_check INTEGER,
  disclosure_check INTEGER,
  originality_check INTEGER,
  duplicate_check INTEGER,
  account_fit_check INTEGER,
  campaign_fit_check INTEGER,
  platform_risk_score REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT UNIQUE NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('tiktok','instagram','youtube','twitter')),
  zernio_account_id TEXT,
  niche TEXT NOT NULL,
  daily_post_cap INTEGER NOT NULL DEFAULT 3,
  hourly_post_cap INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'warmup' CHECK(status IN ('warmup','active','suspended','dead')),
  warmup_started_at TEXT,
  follower_count INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS publish_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES clip_candidates(id),
  render_id INTEGER NOT NULL REFERENCES renders(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  zernio_post_id TEXT,
  platform_url TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','posted','failed','removed','dry_run')),
  caption TEXT,
  hashtags TEXT,
  posted_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publish_attempt_id INTEGER NOT NULL REFERENCES publish_attempts(id) ON DELETE CASCADE,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  measured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payout_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  publish_attempt_id INTEGER NOT NULL REFERENCES publish_attempts(id),
  expected_usd REAL,
  paid_usd REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paid','disputed')),
  rejection_reason TEXT,
  claimed_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_sources_campaign ON sources(campaign_id);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON clip_candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidates_source ON clip_candidates(source_id);
CREATE INDEX IF NOT EXISTS idx_publish_status ON publish_attempts(status);
CREATE INDEX IF NOT EXISTS idx_publish_candidate ON publish_attempts(candidate_id);
CREATE INDEX IF NOT EXISTS idx_metrics_attempt ON metrics_snapshots(publish_attempt_id);
CREATE INDEX IF NOT EXISTS idx_payout_status ON payout_claims(status);

INSERT OR IGNORE INTO schema_version(version) VALUES (2);
