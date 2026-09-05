ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS target_relevant BOOLEAN,
  ADD COLUMN IF NOT EXISTS prefilter_score INTEGER;

CREATE INDEX IF NOT EXISTS idx_jobs_prefilter_pending
  ON jobs (target_relevant)
  WHERE target_relevant IS NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_target_relevant
  ON jobs (target_relevant, prefilter_score DESC);
