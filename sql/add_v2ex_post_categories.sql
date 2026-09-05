ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS v2ex_post_category TEXT,
  ADD COLUMN IF NOT EXISTS v2ex_direction_tags TEXT[],
  ADD COLUMN IF NOT EXISTS v2ex_classification_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_v2ex_category
  ON jobs (source, v2ex_post_category, published_at DESC);
