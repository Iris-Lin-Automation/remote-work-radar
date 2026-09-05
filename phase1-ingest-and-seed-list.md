# Phase 1 — Ingest Workflow (Himalayas + Jobicy + Arbeitnow) + ATS Seed List

## 1. Postgres schema — single `jobs` table

```sql
CREATE TABLE jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source              TEXT NOT NULL,              -- 'himalayas' | 'jobicy' | 'arbeitnow'
  source_job_id       TEXT NOT NULL,               -- source's own id/slug
  title               TEXT NOT NULL,
  company             TEXT NOT NULL,
  company_url         TEXT,
  description_raw     TEXT,
  description_clean   TEXT,
  location_raw        TEXT,
  region_bucket       TEXT,                        -- filled later by LLM step
  china_eligible      TEXT,                        -- 'true' | 'false' | 'unclear', filled later
  china_eligibility_reason TEXT,
  timezone_overlap    TEXT,
  employment_type     TEXT,
  experience_years_min NUMERIC,
  experience_years_max NUMERIC,
  seniority           TEXT,
  skills              TEXT[],
  salary_raw          TEXT,
  salary_min          NUMERIC,
  salary_max          NUMERIC,
  salary_currency     TEXT,
  published_at        TIMESTAMPTZ,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  apply_url           TEXT NOT NULL,
  dedup_key           TEXT NOT NULL UNIQUE,
  match_score         NUMERIC,
  trust_score         NUMERIC,
  recommendation_text TEXT,
  pipeline_status     TEXT NOT NULL DEFAULT 'new'
);

CREATE INDEX idx_jobs_dedup_key ON jobs(dedup_key);
CREATE INDEX idx_jobs_match_score ON jobs(match_score DESC NULLS LAST);
CREATE INDEX idx_jobs_last_seen ON jobs(last_seen_at);
```

Phase 1 only ever writes: `source`, `source_job_id`, `title`, `company`, `company_url`, `description_raw`, `description_clean`, `location_raw`, `employment_type`, `salary_*`, `published_at`, `first_seen_at`, `last_seen_at`, `apply_url`, `dedup_key`. Everything scoring-related stays NULL until the Claude step runs later — don't build that logic yet.

## 2. n8n workflow — node by node

```
[Schedule Trigger: every 4h]
        |
        +--> [HTTP Request: Himalayas]  --> [Code: normalizeHimalayas]  --+
        +--> [HTTP Request: Jobicy]     --> [Code: normalizeJobicy]      --+--> [Merge (append)] --> [Code: computeDedupKey] --> [Postgres: Upsert]
        +--> [HTTP Request: Arbeitnow]  --> [Code: normalizeArbeitnow]   --+
```

### HTTP Request nodes (GET, no auth, no headers needed)

- Himalayas: `https://himalayas.app/jobs/api?limit=20&offset=0`
  (Phase 1: single page is fine — 20 most recent. Add offset-loop pagination later if you want full backfill.)
- Jobicy: `https://jobicy.com/api/v2/remote-jobs?count=50`
- Arbeitnow: `https://www.arbeitnow.com/api/job-board-api`
  (Arbeitnow already returns ~100 jobs per page with a `links.next` cursor — Phase 1: just take page 1.)

### Code node: `normalizeHimalayas`

Himalayas response shape: `{ title, excerpt, companyName, companySlug, employmentType, locationRestrictions[], timezoneRestriction[], minSalary, maxSalary, salaryPeriod, currency, description, pubDate, applicationLink, guid }`

```javascript
const items = $input.first().json.jobs || $input.first().json; // array of job objects
return items.map(job => ({
  json: {
    source: 'himalayas',
    source_job_id: job.guid,
    title: job.title,
    company: job.companyName,
    company_url: null,
    description_raw: job.description || job.excerpt || '',
    description_clean: (job.description || job.excerpt || '').replace(/<[^>]*>/g, '').trim(),
    location_raw: (job.locationRestrictions && job.locationRestrictions.length)
      ? job.locationRestrictions.join(', ')
      : 'Worldwide',
    employment_type: job.employmentType || null,
    salary_min: job.minSalary || null,
    salary_max: job.maxSalary || null,
    salary_currency: job.currency || null,
    published_at: job.pubDate ? new Date(job.pubDate).toISOString() : null,
    apply_url: job.applicationLink
  }
}));
```

### Code node: `normalizeJobicy`

Jobicy response shape: `{ jobs: [{ id, url, jobTitle, companyName, jobIndustry[], jobType[], jobGeo, jobLevel, jobExcerpt, jobDescription, pubDate, annualSalaryMin, annualSalaryMax, salaryCurrency }] }`

```javascript
const items = $input.first().json.jobs;
return items.map(job => ({
  json: {
    source: 'jobicy',
    source_job_id: String(job.id),
    title: job.jobTitle,
    company: job.companyName,
    company_url: null,
    description_raw: job.jobDescription || job.jobExcerpt || '',
    description_clean: (job.jobDescription || job.jobExcerpt || '').replace(/<[^>]*>/g, '').trim(),
    location_raw: job.jobGeo || 'Anywhere',
    employment_type: (job.jobType && job.jobType[0]) || null,
    salary_min: job.annualSalaryMin ? Number(job.annualSalaryMin) : null,
    salary_max: job.annualSalaryMax ? Number(job.annualSalaryMax) : null,
    salary_currency: job.salaryCurrency || null,
    published_at: job.pubDate ? new Date(job.pubDate.replace(' ', 'T') + 'Z').toISOString() : null,
    apply_url: job.url
  }
}));
```

### Code node: `normalizeArbeitnow`

Arbeitnow response shape: `{ data: [{ slug, company_name, title, description, remote, url, tags[], job_types[], location, created_at (unix seconds), visa_sponsorship }] }`

```javascript
const items = $input.first().json.data;
return items.map(job => ({
  json: {
    source: 'arbeitnow',
    source_job_id: job.slug,
    title: job.title,
    company: job.company_name,
    company_url: null,
    description_raw: job.description || '',
    description_clean: (job.description || '').replace(/<[^>]*>/g, '').trim(),
    location_raw: job.remote ? `Remote (${job.location || 'EU'})` : (job.location || 'Unknown'),
    employment_type: (job.job_types && job.job_types[0]) || null,
    salary_min: null,          // Arbeitnow rarely publishes structured salary
    salary_max: null,
    salary_currency: null,
    published_at: job.created_at ? new Date(job.created_at * 1000).toISOString() : null,
    apply_url: job.url
  }
}));
```

### Code node: `computeDedupKey` (runs after Merge)

```javascript
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

return $input.all().map(item => {
  const job = item.json;
  const key = normalize(job.company) + '|' + normalize(job.title);
  return {
    json: {
      ...job,
      dedup_key: key
    }
  };
});
```

**Updated for MVP:** the key is just `company|title`, no apply-URL domain. Testing against live data showed content aggregators (Himalayas, Jobicy) point to their own listing page rather than the employer's site, so the same job posted on two aggregators got different domains and dodged the dedup check entirely. Dropping the domain catches that case. Trade-off: two genuinely different roles with an identical title at the same company (rare, but happens with generic titles like "Software Engineer") will incorrectly merge into one row — acceptable for MVP, revisit with fuzzy matching later if it becomes a real problem.

### Postgres node: Upsert

Use n8n's Postgres node in "Execute Query" mode with a parameterized query (or the built-in Upsert operation if your n8n version has it):

```sql
INSERT INTO jobs (
  source, source_job_id, title, company, company_url,
  description_raw, description_clean, location_raw,
  employment_type, salary_min, salary_max, salary_currency,
  published_at, apply_url, dedup_key, first_seen_at, last_seen_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), now()
)
ON CONFLICT (dedup_key) DO UPDATE SET
  last_seen_at = now(),
  title = EXCLUDED.title,
  description_raw = EXCLUDED.description_raw,
  description_clean = EXCLUDED.description_clean;
```

`first_seen_at` is only set on insert (it's outside the `DO UPDATE SET` clause, so it never changes on conflict). `last_seen_at` updates every run the job still appears. That's the entire Phase 1 loop — no scoring, no dashboard, nothing else.

---

## 3. ATS seed list — 25 companies for later Greenhouse/Lever/Ashby polling

Not for Phase 1 — save this for when you add ATS polling. Each entry lists the company, the ATS they're **most recently known** to use, and the likely board slug. **Verify each slug with one GET request before wiring it into n8n** — companies migrate ATS providers and slugs occasionally change, and I can't guarantee every one of these is still accurate at build time.

| Company | ATS | Likely slug / board URL pattern |
|---|---|---|
| Zapier | Greenhouse | `boards-api.greenhouse.io/v1/boards/zapier/jobs` |
| Anthropic | Greenhouse | `boards-api.greenhouse.io/v1/boards/anthropic/jobs` |
| GitLab | Greenhouse | `boards-api.greenhouse.io/v1/boards/gitlab/jobs` |
| DigitalOcean | Greenhouse | `boards-api.greenhouse.io/v1/boards/digitalocean/jobs` |
| Grafana Labs | Greenhouse | `boards-api.greenhouse.io/v1/boards/grafanalabs/jobs` |
| Miro | Greenhouse | `boards-api.greenhouse.io/v1/boards/miro/jobs` |
| Postman | Greenhouse | `boards-api.greenhouse.io/v1/boards/postman/jobs` |
| Weights & Biases | Greenhouse | `boards-api.greenhouse.io/v1/boards/wandb/jobs` |
| Scale AI | Greenhouse | `boards-api.greenhouse.io/v1/boards/scaleai/jobs` |
| Plaid | Greenhouse | `boards-api.greenhouse.io/v1/boards/plaid/jobs` |
| Remote.com | Greenhouse | `boards-api.greenhouse.io/v1/boards/remotecom/jobs` |
| Airtable | Greenhouse | `boards-api.greenhouse.io/v1/boards/airtable/jobs` |
| Vercel | Greenhouse | `boards-api.greenhouse.io/v1/boards/vercel/jobs` |
| Sourcegraph | Ashby | `jobs.ashbyhq.com/sourcegraph` |
| Notion | Ashby | `jobs.ashbyhq.com/notion` |
| OpenAI | Ashby | `jobs.ashbyhq.com/openai` |
| Retool | Ashby | `jobs.ashbyhq.com/retool` |
| Hex | Ashby | `jobs.ashbyhq.com/hex` |
| Modal | Ashby | `jobs.ashbyhq.com/modal` |
| Replit | Ashby | `jobs.ashbyhq.com/replit` |
| Ramp | Ashby | `jobs.ashbyhq.com/ramp` |
| Vanta | Ashby | `jobs.ashbyhq.com/vanta` |
| LangChain | Ashby | `jobs.ashbyhq.com/langchain` |
| dbt Labs | Ashby | `jobs.ashbyhq.com/dbtlabs` |
| Airbyte | Greenhouse or Ashby | check both — migrated ATS in the past |
| Superhuman | Ashby | `jobs.ashbyhq.com/superhuman` |

Note on API shape once you get here:
- Greenhouse: `GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` → `{ jobs: [{ id, title, absolute_url, location: { name }, content, updated_at }] }`
- Ashby: `GET https://api.ashbyhq.com/posting-api/job-board/{slug}` → `{ jobs: [{ title, location, jobUrl, publishedAt, isRemote, descriptionHtml }] }` (this endpoint is undocumented-but-stable; treat as best-effort)

---

## 4. What's next

Once you've got the Phase 1 workflow inserting/updating rows correctly (check with `SELECT source, count(*) FROM jobs GROUP BY source;` and confirm `last_seen_at` bumps on re-runs), we add the Claude scoring step from the earlier design doc — that reads rows where `match_score IS NULL` and fills in the eligibility/scoring fields.
