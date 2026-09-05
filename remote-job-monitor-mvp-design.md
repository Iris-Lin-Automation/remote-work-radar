# Remote Job Monitor — MVP Design

## 1. Normalized Job Schema

Every source gets mapped into this shape before hitting the database. Keep it flat where possible — nested JSON makes SQL filtering/sorting harder later.

```json
{
  "id": "uuid, generated on insert",
  "source": "himalayas | jobicy | arbeitnow | wwr | remoteok | greenhouse:{company} | ...",
  "source_job_id": "the ID/slug from the source, for re-fetch and audit",
  "title": "string",
  "company": "string",
  "company_url": "string | null",
  "description_raw": "string, original text, kept for re-scoring if prompt changes",
  "description_clean": "string, whitespace/HTML stripped, used for embedding/LLM calls",
  "location_raw": "string, exactly as source wrote it, e.g. 'Remote - US only'",
  "region_bucket": "eu | apac | sg_hk | us_ca | global | unknown",
  "china_eligible": "true | false | unclear",
  "china_eligibility_reason": "short string from the LLM extraction",
  "timezone_overlap": "string, e.g. 'UTC+1 to UTC+3, up to 4h overlap with CST'",
  "employment_type": "full_time | part_time | contract | freelance | project",
  "experience_years_min": "number | null",
  "experience_years_max": "number | null",
  "seniority": "junior | mid | senior | unknown",
  "skills": ["array", "of", "extracted", "tags"],
  "salary_raw": "string | null",
  "salary_min": "number | null",
  "salary_max": "number | null",
  "salary_currency": "string | null",
  "published_at": "timestamp, from source",
  "first_seen_at": "timestamp, when our system first ingested it",
  "last_seen_at": "timestamp, updated every refresh cycle it still appears",
  "apply_url": "string",
  "dedup_key": "hash of normalized(company+title) + apply_url domain",
  "match_score": "0-100 | null, set by LLM scoring step",
  "trust_score": "0-100 | null, set by LLM/heuristic step",
  "recommendation_text": "short string, e.g. '88/100 — Recommended'",
  "pipeline_status": "new | shortlisted | applied | interview | offer | rejected"
}
```

Notes:
- `region_bucket` and `china_eligible` are separate fields on purpose — region tells you *where* the team is, eligibility tells you whether *you* can take the role. A Germany-based team can still be globally remote.
- Store `description_raw` even though it's redundant — you'll want to re-run the LLM scoring later with a better prompt without re-fetching every source.

## 2. n8n Workflow — Phase 1 (Ingest → Normalize → Dedupe)

**Trigger:** Schedule node, every 4–6 hours.

**Per-source branch** (one branch per source, all feeding into a shared "Normalize" function node):

1. `HTTP Request` node — call the source's JSON/RSS endpoint.
   - Himalayas: `GET https://himalayas.app/jobs/api?limit=20&offset=...` (paginate)
   - Jobicy: `GET https://jobicy.com/api/v2/remote-jobs?count=50`
   - Arbeitnow: `GET https://www.arbeitnow.com/api/job-board-api`
   - We Work Remotely: `GET https://weworkremotely.com/categories/remote-programming-jobs.rss` (XML — use n8n's `XML` node to parse)
   - RemoteOK: `GET https://remoteok.com/api`
   - Greenhouse (per company): `GET https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
2. `Function` (Code) node — map source-specific fields into the shared schema above. This is where `location_raw` gets set; do NOT attempt eligibility logic here, that's the LLM's job downstream.
3. Merge all branches into one list.

**Dedup step:**
4. `Function` node — compute `dedup_key` (lowercase, strip punctuation from company+title, combine with apply URL domain).
5. `Postgres` node — `UPSERT` on `dedup_key`:
   - If new: insert with `first_seen_at = now()`, `pipeline_status = 'new'`.
   - If existing: update `last_seen_at = now()`, and if `title`/`description_raw` changed materially, flag for re-scoring (`match_score = null`).
6. Separate scheduled job (daily): mark anything with `last_seen_at` older than 7 days as stale/hidden from the dashboard, rather than deleting it.

## 3. Claude Scoring Prompt (per job)

Call this only for rows where `match_score IS NULL` (new or changed jobs) — no need to re-score unchanged listings every cycle.

```
System: You are extracting structured facts and a fit score for a remote job listing.
The candidate is based in mainland China and needs roles that are genuinely
accessible from there — not just labeled "remote."

Target profile:
- Skills: AI automation, AI agents, workflow automation (n8n, Make), data
  analysis/automation, Python automation, API integration
- Experience: 0-3 years, junior-to-mid level
- Preference: async-first, flexible hours, infrequent synchronous meetings
- Priority regions (in order): Europe (esp. Germany/Netherlands) > Singapore/HK
  > worldwide/APAC > US/Canada (only if genuinely async-friendly)

Given the job title, company, and description below, return ONLY a JSON object
with these fields:
- china_eligible: true | false | unclear
- china_eligibility_reason: one short sentence
- region_bucket: eu | apac | sg_hk | us_ca | global | unknown
- timezone_overlap: short string describing overlap with China time (UTC+8)
- employment_type: full_time | part_time | contract | freelance | project
- experience_years_min: number or null
- experience_years_max: number or null
- seniority: junior | mid | senior | unknown
- skills: array of relevant skill tags found in the text
- salary_min, salary_max, salary_currency: numbers/string or null
- match_score: 0-100, weighting china_eligible as a hard gate (if false, cap at 20)
- trust_score: 0-100, based on presence of a real company site, plausible
  salary, consistent details, absence of scam patterns
- recommendation_text: one short line, e.g. "88/100 — Recommended: remote-
  eligible, Germany-based team, strong n8n overlap"

Job title: {{title}}
Company: {{company}}
Location as posted: {{location_raw}}
Description: {{description_clean}}
```

Parse the response, strip code fences if present, and write the fields back to the row.

## 4. Suggested build order for you

1. Stand up Postgres + the schema above (a single `jobs` table is enough for MVP).
2. Build the n8n ingest workflow for 3 sources first (Himalayas, Jobicy, Arbeitnow — all no-auth JSON) to validate the normalize/dedupe logic before adding more.
3. Add the Claude scoring step, test on ~20 real jobs, and hand-check the `china_eligible` calls for accuracy — this is the part most worth iterating on.
4. Add remaining sources (WWR, RemoteOK, Greenhouse seed companies).
5. Build the dashboard as a simple table view (sort by `match_score DESC`, filter `china_eligible = true`, editable `pipeline_status` dropdown).
