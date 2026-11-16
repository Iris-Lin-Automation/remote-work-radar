# Audit: Cloud Deploy Dependencies (2026-11-15)

## Who talks to Postgres

| Component | Access | Env | Today |
|-----------|--------|-----|-------|
| `scripts/db.js` | `pg` Pool + SQL | `DATABASE_URL` | Soft-fail; localhost in local `.env` → ECONNREFUSED |
| `scripts/run-radar-cycle.js` | via `db.js` upsert + prefs | `DATABASE_URL` | Dual-write optional |
| `scripts/telegram-chat-poll.js` | via `db.js`; fallback JSON | `DATABASE_URL` + `data/pushed_jobs.json` | KB fallback when DB down |
| `workers/telegram-webhook` | **Supabase REST only** | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | No `pg` |
| GitHub Actions | via radar → `db.js` | `secrets.DATABASE_URL` | Secret may be unset/localhost |

## Hardcoded localhost

- Local `.env`: `DATABASE_URL=...@localhost:5432/job_monitor` (**broken without Docker**)
- Docs / old scripts: `IMPLEMENTATION-GUIDE.md`, `setup-n8n-workflow.js`, `score-domestic-pool.js` fallbacks
- **Radar/Copilot runtime must not default to localhost** — require explicit `DATABASE_URL`

## JSON-only paths

- `data/seen_jobs.json` — dedup across Actions (committed)
- `data/pushed_jobs.json` — push history (~300); chat poll fallback KB

## Env matrix

| Var | Actions | Worker | Local radar | Local chat |
|-----|---------|--------|-------------|------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | ✅ | ✅ | ✅ |
| `TELEGRAM_CHAT_ID` / `ALLOWED_TELEGRAM_USER_ID` | ✅ | ✅ | ✅ | ✅ |
| `GROQ_API_KEY` | ✅ | ✅ | ✅ | ✅ |
| `GROQ_MODEL` | add | add | add | add |
| `DATABASE_URL` (Supabase pooler) | ✅ radar | — | ✅ | optional |
| `SUPABASE_URL` | optional | ✅ | optional | — |
| `SUPABASE_SERVICE_ROLE_KEY` | optional | ✅ | optional | — |
| `TELEGRAM_WEBHOOK_SECRET` | — | ✅ | — | — |

## Minimal change plan (P0)

1. Cloud SQL bootstrap migration (jobs + copilot cols + score_status/legacy + source_runs + scoring_cache + apps UUID-safe)
2. Harden `db.js`: require URL, SSL for Supabase, health check, fail loud
3. `import-legacy-jobs.js` from pushed/seen
4. `quick-match.js`: `GROQ_MODEL`, no fake scores, `score_status=error` → verify/unscored
5. Worker tools + secret header + whitelist; docs + `.env.example` + smoke tests
6. Tag Growix/OpenTrain source buckets without collector rewrite
