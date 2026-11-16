-- Remote Job Copilot — Supabase / cloud Postgres bootstrap
-- Run once in Supabase SQL Editor (or any managed Postgres).
-- Safe to re-run: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Base jobs (compatible with create_jobs_table.sql) ──
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  source_job_id TEXT,
  title TEXT NOT NULL,
  company TEXT,
  company_url TEXT,
  description_raw TEXT NOT NULL DEFAULT '',
  description_clean TEXT NOT NULL DEFAULT '',
  location_raw TEXT,
  region_bucket TEXT NOT NULL DEFAULT 'unknown'
    CHECK (region_bucket IN ('eu', 'apac', 'sg_hk', 'us_ca', 'global', 'unknown')),
  china_eligible TEXT NOT NULL DEFAULT 'unclear'
    CHECK (china_eligible IN ('true', 'false', 'unclear')),
  china_eligibility_reason TEXT,
  timezone_overlap TEXT,
  employment_type TEXT
    CHECK (employment_type IS NULL OR employment_type IN ('full_time', 'part_time', 'contract', 'freelance', 'project')),
  experience_years_min NUMERIC,
  experience_years_max NUMERIC,
  seniority TEXT NOT NULL DEFAULT 'unknown'
    CHECK (seniority IN ('junior', 'mid', 'senior', 'unknown')),
  skills TEXT[] NOT NULL DEFAULT '{}',
  salary_raw TEXT,
  salary_min NUMERIC,
  salary_max NUMERIC,
  salary_currency TEXT,
  published_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  apply_url TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  match_score NUMERIC CHECK (match_score IS NULL OR (match_score >= 0 AND match_score <= 100)),
  trust_score NUMERIC CHECK (trust_score IS NULL OR (trust_score >= 0 AND trust_score <= 100)),
  recommendation_text TEXT,
  intent TEXT NOT NULL DEFAULT 'unknown'
    CHECK (intent IN ('hiring', 'sharing', 'seeking', 'discussing', 'unknown')),
  pipeline_status TEXT NOT NULL DEFAULT 'new'
    CHECK (pipeline_status IN ('new', 'shortlisted', 'applied', 'interview', 'offer', 'rejected')),
  is_stale BOOLEAN NOT NULL DEFAULT FALSE
);

-- Copilot score dims + status
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS work_mode TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hire_vehicle TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS benefits_signal TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS track TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_tech NUMERIC;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_delivery NUMERIC;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_level NUMERIC;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_workstyle NUMERIC;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_comp NUMERIC;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_trust NUMERIC;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS recommendation_status TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_reason TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS migration TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS elig_labels TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hit_keywords TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_name TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS groq_skipped BOOLEAN NOT NULL DEFAULT FALSE;

-- Cloud P0 columns
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (score_status IN ('pending', 'ok', 'error', 'cached', 'skipped'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_error TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS legacy_import BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS expired BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_bucket TEXT
  CHECK (source_bucket IS NULL OR source_bucket IN (
    'core_fulltime', 'evergreen_contractor', 'flexible_ai_tasks', 'manual', 'legacy', 'other'
  ));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS jd_hash TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS profile_version TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS prompt_version TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS evidence_snippets TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS jobs_recommendation_status_idx ON jobs (recommendation_status);
CREATE INDEX IF NOT EXISTS jobs_match_score_idx ON jobs (match_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS jobs_track_idx ON jobs (track);
CREATE INDEX IF NOT EXISTS jobs_china_eligible_idx ON jobs (china_eligible);
CREATE INDEX IF NOT EXISTS jobs_score_status_idx ON jobs (score_status);
CREATE INDEX IF NOT EXISTS jobs_legacy_import_idx ON jobs (legacy_import);
CREATE INDEX IF NOT EXISTS jobs_source_bucket_idx ON jobs (source_bucket);
CREATE INDEX IF NOT EXISTS jobs_jd_hash_idx ON jobs (jd_hash);
CREATE INDEX IF NOT EXISTS jobs_apply_url_idx ON jobs (apply_url);

-- Preferences
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
INSERT INTO user_preferences (user_key) VALUES ('iris') ON CONFLICT (user_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL DEFAULT 'iris',
  telegram_chat_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  tool_calls JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS conversations_user_created_idx ON conversations (user_key, created_at DESC);

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

-- UUID-safe applications (do not use legacy INTEGER FK schema on Supabase)
CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL DEFAULT 'iris',
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  source TEXT,
  company TEXT,
  title TEXT,
  apply_url TEXT,
  dedup_key TEXT,
  application_status TEXT NOT NULL DEFAULT 'new'
    CHECK (application_status IN (
      'new', 'shortlisted', 'applied', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted'
    )),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_key, dedup_key)
);
CREATE INDEX IF NOT EXISTS applications_status_idx ON applications (user_key, application_status);

-- Per-source crawl watermark
CREATE TABLE IF NOT EXISTS source_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  fetched_count INT NOT NULL DEFAULT 0,
  new_count INT NOT NULL DEFAULT 0,
  scored_ok INT NOT NULL DEFAULT 0,
  scored_error INT NOT NULL DEFAULT 0,
  pushed_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ok', 'error')),
  error_text TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS source_runs_source_started_idx ON source_runs (source, started_at DESC);

-- LLM score cache
CREATE TABLE IF NOT EXISTS scoring_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_dedup_key TEXT NOT NULL,
  jd_hash TEXT NOT NULL,
  profile_version TEXT NOT NULL DEFAULT 'v1',
  prompt_version TEXT NOT NULL DEFAULT 'v1',
  model TEXT,
  dims JSONB,
  total_score NUMERIC,
  reason TEXT,
  migration TEXT,
  score_status TEXT NOT NULL DEFAULT 'ok',
  raw_response TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_dedup_key, jd_hash, profile_version, prompt_version)
);
CREATE INDEX IF NOT EXISTS scoring_results_lookup_idx
  ON scoring_results (job_dedup_key, jd_hash, profile_version, prompt_version);

-- Radar cycle stats (for /status)
CREATE TABLE IF NOT EXISTS radar_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  scraped INT NOT NULL DEFAULT 0,
  new_items INT NOT NULL DEFAULT 0,
  l1 INT NOT NULL DEFAULT 0,
  scored_ok INT NOT NULL DEFAULT 0,
  scored_error INT NOT NULL DEFAULT 0,
  pushed INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  error_text TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- PostgREST / Cloudflare Worker need service_role table privileges
GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
