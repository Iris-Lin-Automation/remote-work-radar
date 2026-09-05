CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  source_job_id TEXT,
  title TEXT NOT NULL,
  company TEXT,
  company_url TEXT,
  description_raw TEXT NOT NULL,
  description_clean TEXT NOT NULL,
  location_raw TEXT,
  region_bucket TEXT NOT NULL DEFAULT 'unknown'
    CHECK (region_bucket IN ('eu', 'apac', 'sg_hk', 'us_ca', 'global', 'unknown')),
  china_eligible TEXT NOT NULL DEFAULT 'unclear'
    CHECK (china_eligible IN ('true', 'false', 'unclear')),
  china_eligibility_reason TEXT,
  timezone_overlap TEXT,
  employment_type TEXT
    CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'freelance', 'project')),
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
  match_score NUMERIC CHECK (match_score >= 0 AND match_score <= 100),
  trust_score NUMERIC CHECK (trust_score >= 0 AND trust_score <= 100),
  recommendation_text TEXT,
  intent TEXT NOT NULL DEFAULT 'unknown'
    CHECK (intent IN ('hiring', 'sharing', 'seeking', 'discussing', 'unknown')),
  pipeline_status TEXT NOT NULL DEFAULT 'new'
    CHECK (pipeline_status IN ('new', 'shortlisted', 'applied', 'interview', 'offer', 'rejected')),
  is_stale BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS jobs_last_seen_at_idx ON jobs (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS jobs_pipeline_status_idx ON jobs (pipeline_status);
CREATE INDEX IF NOT EXISTS jobs_published_at_idx ON jobs (published_at DESC);

-- Run daily. Keep stale jobs for audit; hide them in the dashboard later.
UPDATE jobs
SET is_stale = TRUE
WHERE last_seen_at < NOW() - INTERVAL '7 days'
  AND is_stale = FALSE;
