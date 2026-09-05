# Phase 1 - Ingest and Seed List

## Scope

Phase 1 ingests, normalizes, and deduplicates job listings. It does not run
Claude scoring or build a dashboard.

## Initial no-auth sources

1. Himalayas: `GET https://himalayas.app/jobs/api?limit=20&offset=0`
2. Jobicy: `GET https://jobicy.com/api/v2/remote-jobs?count=50`
3. Arbeitnow: `GET https://www.arbeitnow.com/api/job-board-api`

These three sources are the initial validation set from the design document.

## Workflow behavior

1. Run every six hours.
2. Fetch all three sources.
3. Normalize each listing into the `jobs` table shape.
4. Calculate `dedup_key` from normalized company, normalized title, and the
   application URL domain.
5. Insert new jobs with `pipeline_status = 'new'`.
6. On an existing `dedup_key`, refresh `last_seen_at`; when title or raw
   description changes, clear `match_score` for later scoring.

## Planned later sources

We Work Remotely, RemoteOK, and Greenhouse seed companies are intentionally
not included in this first validation workflow. They are listed in the design
document for the next source-expansion step.

## Daily stale job task

A separate daily job should set `is_stale = true` for records whose
`last_seen_at` is older than seven days. It should not delete jobs.
