-- Remote Job Copilot schema extension
-- Compatible with local Docker Postgres and Supabase.
-- Run after sql/create_jobs_table.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Extend jobs with hard-condition + multi-dim scoring columns ──
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS work_mode TEXT
  CHECK (work_mode IS NULL OR work_mode IN ('fully_remote', 'hybrid', 'onsite', 'unknown'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hire_vehicle TEXT
  CHECK (hire_vehicle IS NULL OR hire_vehicle IN ('employee', 'eor', 'contractor', 'unknown'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS benefits_signal TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS track TEXT
  CHECK (track IS NULL OR track IN ('en', 'cn'));

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_tech NUMERIC CHECK (score_tech IS NULL OR (score_tech >= 0 AND score_tech <= 100));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_delivery NUMERIC CHECK (score_delivery IS NULL OR (score_delivery >= 0 AND score_delivery <= 100));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_level NUMERIC CHECK (score_level IS NULL OR (score_level >= 0 AND score_level <= 100));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_workstyle NUMERIC CHECK (score_workstyle IS NULL OR (score_workstyle >= 0 AND score_workstyle <= 100));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_comp NUMERIC CHECK (score_comp IS NULL OR (score_comp >= 0 AND score_comp <= 100));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_trust NUMERIC CHECK (score_trust IS NULL OR (score_trust >= 0 AND score_trust <= 100));

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS recommendation_status TEXT
  CHECK (recommendation_status IS NULL OR recommendation_status IN ('apply_now', 'verify', 'skip'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_reason TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS migration TEXT
  CHECK (migration IS NULL OR migration IN ('direct', 'near', 'far', ''));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS elig_labels TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hit_keywords TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_name TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS groq_skipped BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS jobs_recommendation_status_idx ON jobs (recommendation_status);
CREATE INDEX IF NOT EXISTS jobs_match_score_idx ON jobs (match_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS jobs_track_idx ON jobs (track);
CREATE INDEX IF NOT EXISTS jobs_china_eligible_idx ON jobs (china_eligible);

-- ── User preferences (only update after explicit Telegram confirm) ──
CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL UNIQUE DEFAULT 'iris',
  prefer_async BOOLEAN NOT NULL DEFAULT TRUE,
  prefer_few_meetings BOOLEAN NOT NULL DEFAULT TRUE,
  avoid_sales BOOLEAN NOT NULL DEFAULT TRUE,
  avoid_oncall BOOLEAN NOT NULL DEFAULT TRUE,
  avoid_late_us_overlap BOOLEAN NOT NULL DEFAULT TRUE,
  prefer_hire_vehicles TEXT[] NOT NULL DEFAULT ARRAY['employee', 'eor', 'contractor'],
  prefer_employment_types TEXT[] NOT NULL DEFAULT ARRAY['full_time', 'contract'],
  require_china_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  prefer_tracks TEXT[] NOT NULL DEFAULT ARRAY['en'],
  weight_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  preference_summary TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO user_preferences (user_key)
VALUES ('iris')
ON CONFLICT (user_key) DO NOTHING;

-- ── Conversations ──
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL DEFAULT 'iris',
  telegram_chat_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  tool_calls JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversations_user_created_idx
  ON conversations (user_key, created_at DESC);

-- ── Preference signals extracted from chat (pending until confirmed) ──
CREATE TABLE IF NOT EXISTS preference_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL DEFAULT 'iris',
  signal_type TEXT NOT NULL,
  signal_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'rejected')),
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS preference_signals_status_idx
  ON preference_signals (user_key, status, created_at DESC);

-- ── Interview / application feedback corpus ──
CREATE TABLE IF NOT EXISTS application_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL DEFAULT 'iris',
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  company TEXT,
  title TEXT,
  outcome TEXT
    CHECK (outcome IS NULL OR outcome IN (
      'applied', 'screen', 'interview', 'offer', 'rejected', 'ghosted', 'withdrew', 'other'
    )),
  liked TEXT,
  disliked TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS application_feedback_user_created_idx
  ON application_feedback (user_key, created_at DESC);
