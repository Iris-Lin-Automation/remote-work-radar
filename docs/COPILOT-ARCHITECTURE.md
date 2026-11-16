# Remote Job Copilot Architecture

Incremental Node.js upgrade on the existing radar — no n8n / LangGraph / TypeScript rewrite.

## Data flow

```
Collectors (RSS/JSON/HTML/ATS)
        │
        ▼
Layer 1 keyword whitelist  →  Layer 1.5 eligibility
        │
        ▼
Hard rules: china_eligible / work_mode / hire_vehicle / employment_type
        │
        ▼
Layer 2 Groq 6-dim score (tech/delivery/level/workstyle/comp/trust)
        │  + preference_summary + recent interview feedback
        ▼
recommendation_status: apply_now | verify | skip
        │
        ├──► Postgres upsert (DATABASE_URL)
        ├──► data/seen_jobs.json (always)
        └──► Telegram digests by status (apply_now first, then verify)
                    │
                    ▼
         Cloudflare Worker webhook (bidirectional)
           query / explain / propose prefs / confirm / feedback
```

## Hard rule

**Worldwide ≠ China eligible.**  
If `china_eligible=unclear`, status maxes at `verify` — never `apply_now`.

## Key files

| Path | Role |
|------|------|
| `sql/create_radar_copilot_tables.sql` | jobs score dims + prefs / conversations / signals / feedback |
| `config/scoring-weights.json` | six-dim weights + apply_now_min / verify_min |
| `scripts/quick-match.js` | L1 / eligibility / hard / Groq 6-dim / status |
| `scripts/db.js` | Postgres upsert + preference context |
| `scripts/run-radar-cycle.js` | main cycle: score → upsert → push by status |
| `scripts/notify-telegram.js` | `formatStatusDigest` |
| `workers/telegram-webhook/` | CF Worker Telegram tools |

## Env

| Var | Used by |
|-----|---------|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Actions + Worker |
| `GROQ_API_KEY` | scoring + Worker agent |
| `DATABASE_URL` | radar upsert / prefs load (Actions or local) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Worker REST |
| `WEBHOOK_SECRET` | optional Worker path token |
| `RADAR_USER_KEY` | default `iris` |

## Deploy checklist

1. Run `sql/create_radar_copilot_tables.sql` on Supabase (or local Docker).
2. Set GitHub Actions secret `DATABASE_URL` so radar dual-writes.
3. Deploy Worker: `cd workers/telegram-webhook && wrangler secret put … && wrangler deploy`
4. `setWebhook` to `https://<worker>/webhook/<WEBHOOK_SECRET>`
5. Chat: `/help` · `apply_now` · propose preference · `/confirm <uuid>` · `反馈：…`

## Preference loop

1. User says preference in Telegram → `preference_signals` row `pending`.
2. User `/confirm <id>` → flags + `preference_summary` updated.
3. Next `run-radar-cycle` loads `buildScoringPreferenceContext()` into Groq prompt.
4. Interview feedback via `反馈：` or tool `log_feedback` feeds the same context.
