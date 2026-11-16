/**
 * db.js — Postgres helper for Remote Job Copilot (Supabase pooler / managed PG)
 *
 * Requires DATABASE_URL (Transaction pooler recommended for Actions).
 * Never defaults to localhost. Failures throw DbError when hard=true.
 */

'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

class DbError extends Error {
  constructor(message, code = 'DB_ERROR', cause) {
    super(message);
    this.name = 'DbError';
    this.code = code;
    this.cause = cause;
  }
}

let pool = null;

function resolveDatabaseUrl() {
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) return '';
  // Guard against accidental local Docker URL in cloud mode
  if (process.env.RADAR_REQUIRE_CLOUD_DB === 'true' &&
      /localhost|127\.0\.0\.1/i.test(url)) {
    throw new DbError(
      'DATABASE_URL points to localhost but RADAR_REQUIRE_CLOUD_DB=true. Use Supabase pooler URL.',
      'LOCALHOST_FORBIDDEN'
    );
  }
  return url;
}

function sanitizeConnectionString(url) {
  // node-pg treats sslmode=require as verify-full; that fights rejectUnauthorized:false
  // and breaks Supabase (esp. behind corporate TLS / pooler). Strip sslmode from URI.
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('ssl');
    return u.toString();
  } catch {
    return url
      .replace(/([?&])sslmode=[^&]*/gi, '$1')
      .replace(/[?&]$/, '')
      .replace(/\?&/, '?');
  }
}

function getPool() {
  if (pool) return pool;
  const raw = resolveDatabaseUrl();
  if (!raw) return null;
  // Don't open a doomed pool when password placeholder still present — prefer REST
  if (/YOUR_PASSWORD|\[YOUR-PASSWORD\]|\[PASSWORD\]|changeme|GRANT |Run once in Supabase/i.test(raw)) {
    return null;
  }
  let url;
  try {
    url = sanitizeConnectionString(raw);
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    return null;
  }

  const needsSsl =
    /supabase|pooler\.supabase|sslmode=require/i.test(raw) ||
    process.env.DATABASE_SSL === 'true';

  pool = new Pool({
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: parseInt(process.env.DB_POOL_MAX || '4', 10),
    idleTimeoutMillis: 15000,
    connectionTimeoutMillis: 12000,
  });
  return pool;
}

function requirePool() {
  const p = getPool();
  if (!p) {
    throw new DbError(
      'DATABASE_URL is not set. Configure Supabase pooler URL (not localhost).',
      'NO_DATABASE_URL'
    );
  }
  return p;
}

async function query(sql, params = [], { hard = false } = {}) {
  const p = hard ? requirePool() : getPool();
  if (!p) return null;
  try {
    return await p.query(sql, params);
  } catch (err) {
    const wrapped = new DbError(
      err.message || err.code || 'query failed',
      err.code || 'QUERY_FAILED',
      err
    );
    if (hard) throw wrapped;
    console.log(`[db] query failed: ${wrapped.message}`);
    throw wrapped;
  }
}

async function healthCheck() {
  const p = requirePool();
  const started = Date.now();
  const res = await p.query(
    `SELECT current_database() AS db, current_user AS usr, NOW() AS ts,
            to_regclass('public.jobs') AS jobs_table,
            to_regclass('public.user_preferences') AS prefs_table`
  );
  const row = res.rows[0];
  if (!row.jobs_table) {
    throw new DbError(
      'Connected but public.jobs missing. Run sql/create_radar_cloud_bootstrap.sql in Supabase.',
      'SCHEMA_MISSING'
    );
  }
  return {
    ok: true,
    latencyMs: Date.now() - started,
    database: row.db,
    user: row.usr,
    ts: row.ts,
    jobsTable: !!row.jobs_table,
    prefsTable: !!row.prefs_table,
    hostHint: (process.env.DATABASE_URL || '').includes('supabase') ? 'supabase' : 'postgres',
  };
}

function sourceBucketOf(job) {
  const src = String(job.source || job.sourceName || '').toLowerCase();
  if (src.includes('growix') || job.source_bucket === 'evergreen_contractor') {
    return 'evergreen_contractor';
  }
  if (src.includes('opentrain') || job.source_bucket === 'flexible_ai_tasks') {
    return 'flexible_ai_tasks';
  }
  if (src === 'manual' || job.source_bucket === 'manual') return 'manual';
  if (job.legacy_import) return 'legacy';
  return job.source_bucket || 'core_fulltime';
}

function jdHashOf(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
}

/**
 * Upsert scored radar / legacy / manual job.
 */
async function upsertRadarJob(job, { hard = false } = {}) {
  const p = hard ? (() => { try { return requirePool(); } catch (e) { return null; } })()
    : getPool();
  // Prefer Postgres; fall back to Supabase REST when pool missing or soft mode
  if (!p) {
    if (restConfig()) {
      try {
        return await restUpsertRadarJob(job);
      } catch (err) {
        if (hard) throw err;
        console.log(`[db] REST upsert failed: ${err.message}`);
        return null;
      }
    }
    if (hard) throw new DbError('DATABASE_URL not set and REST unavailable', 'NO_DATABASE_URL');
    return null;
  }

  const hardCond = job.hard || {};
  const dims = job.dims || {};
  const dedup = job.dedupKey || `${job.source}|${job.url || job.title}`;
  const desc = String(job.contentText || job.content || job.title || '').slice(0, 20000);
  const applyUrl = job.url || job.apply_url || `https://example.invalid/${encodeURIComponent(dedup)}`;
  const hash = job.jd_hash || jdHashOf(desc);
  const bucket = sourceBucketOf(job);

  const sql = `
    INSERT INTO jobs (
      source, source_job_id, title, company, description_raw, description_clean,
      location_raw, china_eligible, china_eligibility_reason,
      employment_type, apply_url, dedup_key, published_at,
      match_score, recommendation_text, intent,
      work_mode, hire_vehicle, benefits_signal, track,
      score_tech, score_delivery, score_level, score_workstyle, score_comp, score_trust,
      recommendation_status, score_reason, migration,
      elig_labels, hit_keywords, source_name, groq_skipped,
      score_status, score_error, legacy_import, expired, source_bucket,
      jd_hash, profile_version, prompt_version, evidence_snippets,
      first_seen_at, last_seen_at
    ) VALUES (
      $1,$2,$3,$4,$5,$5,
      $6,$7,$8,
      $9,$10,$11,$12,
      $13,$14,'hiring',
      $15,$16,$17,$18,
      $19,$20,$21,$22,$23,$24,
      $25,$26,$27,
      $28,$29,$30,$31,
      $32,$33,$34,$35,$36,
      $37,$38,$39,$40,
      COALESCE($41::timestamptz, NOW()), NOW()
    )
    ON CONFLICT (dedup_key) DO UPDATE SET
      title = EXCLUDED.title,
      company = COALESCE(EXCLUDED.company, jobs.company),
      description_raw = CASE
        WHEN EXCLUDED.description_raw <> '' THEN EXCLUDED.description_raw
        ELSE jobs.description_raw END,
      description_clean = CASE
        WHEN EXCLUDED.description_clean <> '' THEN EXCLUDED.description_clean
        ELSE jobs.description_clean END,
      location_raw = COALESCE(EXCLUDED.location_raw, jobs.location_raw),
      china_eligible = COALESCE(EXCLUDED.china_eligible, jobs.china_eligible),
      china_eligibility_reason = COALESCE(EXCLUDED.china_eligibility_reason, jobs.china_eligibility_reason),
      employment_type = COALESCE(EXCLUDED.employment_type, jobs.employment_type),
      apply_url = EXCLUDED.apply_url,
      published_at = COALESCE(EXCLUDED.published_at, jobs.published_at),
      match_score = COALESCE(EXCLUDED.match_score, jobs.match_score),
      recommendation_text = COALESCE(EXCLUDED.recommendation_text, jobs.recommendation_text),
      work_mode = COALESCE(EXCLUDED.work_mode, jobs.work_mode),
      hire_vehicle = COALESCE(EXCLUDED.hire_vehicle, jobs.hire_vehicle),
      benefits_signal = COALESCE(EXCLUDED.benefits_signal, jobs.benefits_signal),
      track = COALESCE(EXCLUDED.track, jobs.track),
      score_tech = COALESCE(EXCLUDED.score_tech, jobs.score_tech),
      score_delivery = COALESCE(EXCLUDED.score_delivery, jobs.score_delivery),
      score_level = COALESCE(EXCLUDED.score_level, jobs.score_level),
      score_workstyle = COALESCE(EXCLUDED.score_workstyle, jobs.score_workstyle),
      score_comp = COALESCE(EXCLUDED.score_comp, jobs.score_comp),
      score_trust = COALESCE(EXCLUDED.score_trust, jobs.score_trust),
      recommendation_status = COALESCE(EXCLUDED.recommendation_status, jobs.recommendation_status),
      score_reason = COALESCE(EXCLUDED.score_reason, jobs.score_reason),
      migration = COALESCE(EXCLUDED.migration, jobs.migration),
      elig_labels = CASE WHEN cardinality(EXCLUDED.elig_labels)>0 THEN EXCLUDED.elig_labels ELSE jobs.elig_labels END,
      hit_keywords = CASE WHEN cardinality(EXCLUDED.hit_keywords)>0 THEN EXCLUDED.hit_keywords ELSE jobs.hit_keywords END,
      source_name = COALESCE(EXCLUDED.source_name, jobs.source_name),
      groq_skipped = EXCLUDED.groq_skipped,
      score_status = COALESCE(EXCLUDED.score_status, jobs.score_status),
      score_error = EXCLUDED.score_error,
      legacy_import = jobs.legacy_import OR EXCLUDED.legacy_import,
      expired = EXCLUDED.expired,
      source_bucket = COALESCE(EXCLUDED.source_bucket, jobs.source_bucket),
      jd_hash = COALESCE(EXCLUDED.jd_hash, jobs.jd_hash),
      profile_version = COALESCE(EXCLUDED.profile_version, jobs.profile_version),
      prompt_version = COALESCE(EXCLUDED.prompt_version, jobs.prompt_version),
      evidence_snippets = CASE
        WHEN cardinality(EXCLUDED.evidence_snippets)>0 THEN EXCLUDED.evidence_snippets
        ELSE jobs.evidence_snippets END,
      last_seen_at = NOW()
    RETURNING id, dedup_key, recommendation_status, match_score, score_status, legacy_import
  `;

  const publishedAt = job.publishedAt || job.published_at
    ? new Date(job.publishedAt || job.published_at)
    : null;
  const firstSeen = job.first_seen_at || job.at || null;

  const params = [
    job.source || 'radar',
    job.sourceJobId || null,
    String(job.title || 'Untitled').slice(0, 500),
    job.company || null,
    desc,
    job.location || job.location_raw || null,
    hardCond.china_eligible || job.china_eligible || 'unclear',
    hardCond.china_eligibility_reason || job.china_eligibility_reason || null,
    hardCond.employment_type || job.employment_type || null,
    applyUrl,
    dedup,
    publishedAt && !isNaN(publishedAt.getTime()) ? publishedAt.toISOString() : null,
    typeof job.groqScore === 'number' ? job.groqScore
      : (typeof job.score === 'number' ? job.score : null),
    job.groqReason || job.score_reason || null,
    hardCond.work_mode || job.work_mode || null,
    hardCond.hire_vehicle || job.hire_vehicle || null,
    hardCond.benefits_signal || null,
    job.track || null,
    dims.tech ?? job.score_tech ?? null,
    dims.delivery ?? job.score_delivery ?? null,
    dims.level ?? job.score_level ?? null,
    dims.workstyle ?? job.score_workstyle ?? null,
    dims.comp ?? job.score_comp ?? null,
    dims.trust ?? job.score_trust ?? null,
    job.recommendation_status || null,
    job.groqReason || job.score_reason || null,
    job.migration || null,
    Array.isArray(job.eligLabels) ? job.eligLabels : [],
    Array.isArray(job.hitKeywords) ? job.hitKeywords : [],
    job.sourceName || job.source_name || null,
    !!job.groqScoreSkipped,
    job.score_status || (job.groqScoreSkipped ? 'skipped' : 'pending'),
    job.score_error || null,
    !!job.legacy_import,
    !!job.expired,
    bucket,
    hash,
    job.profile_version || process.env.RADAR_PROFILE_VERSION || 'v1',
    job.prompt_version || process.env.RADAR_PROMPT_VERSION || 'v1',
    Array.isArray(job.evidence_snippets) ? job.evidence_snippets : [],
    firstSeen ? new Date(firstSeen).toISOString() : null,
  ];

  try {
    const res = await p.query(sql, params);
    return res.rows[0] || null;
  } catch (err) {
    if (restConfig()) {
      try {
        console.log(`[db] pg upsert failed (${err.message}); trying REST`);
        return await restUpsertRadarJob(job);
      } catch (restErr) {
        const wrapped = new DbError(restErr.message || 'upsert failed', restErr.code, restErr);
        console.log(`[db] REST upsert failed: ${wrapped.message}`);
        if (hard) throw wrapped;
        return null;
      }
    }
    const wrapped = new DbError(err.message || 'upsert failed', err.code, err);
    console.log(`[db] upsert failed: ${wrapped.message}`);
    if (hard) throw wrapped;
    return null;
  }
}

async function getCachedScore({ dedupKey, jdHash, profileVersion, promptVersion }) {
  const p = getPool();
  if (!p) return null;
  const res = await p.query(
    `SELECT * FROM scoring_results
     WHERE job_dedup_key = $1 AND jd_hash = $2
       AND profile_version = $3 AND prompt_version = $4
       AND score_status = 'ok'
     LIMIT 1`,
    [
      dedupKey,
      jdHash,
      profileVersion || 'v1',
      promptVersion || 'v1',
    ]
  );
  return res.rows[0] || null;
}

async function saveScoreCache(row) {
  const p = getPool();
  if (!p) return null;
  const res = await p.query(
    `INSERT INTO scoring_results (
       job_dedup_key, jd_hash, profile_version, prompt_version, model,
       dims, total_score, reason, migration, score_status, raw_response
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (job_dedup_key, jd_hash, profile_version, prompt_version) DO UPDATE SET
       dims = EXCLUDED.dims,
       total_score = EXCLUDED.total_score,
       reason = EXCLUDED.reason,
       migration = EXCLUDED.migration,
       score_status = EXCLUDED.score_status,
       model = EXCLUDED.model,
       raw_response = EXCLUDED.raw_response
     RETURNING id`,
    [
      row.job_dedup_key,
      row.jd_hash,
      row.profile_version || 'v1',
      row.prompt_version || 'v1',
      row.model || null,
      JSON.stringify(row.dims || {}),
      row.total_score ?? null,
      row.reason || null,
      row.migration || null,
      row.score_status || 'ok',
      row.raw_response || null,
    ]
  );
  return res.rows[0] || null;
}

async function getPreferenceSummary(userKey = 'iris') {
  const p = requirePool();
  const res = await p.query(
    `SELECT preference_summary, prefer_async, prefer_few_meetings,
            avoid_sales, avoid_oncall, avoid_late_us_overlap,
            prefer_hire_vehicles, prefer_employment_types,
            require_china_eligible, prefer_tracks, weight_overrides
     FROM user_preferences WHERE user_key = $1 LIMIT 1`,
    [userKey]
  );
  if (!res.rows.length) return '';
  const r = res.rows[0];
  if (r.preference_summary && r.preference_summary.trim()) return r.preference_summary.trim();
  const bits = [];
  if (r.prefer_async) bits.push('偏好异步');
  if (r.prefer_few_meetings) bits.push('少开会');
  if (r.avoid_sales) bits.push('回避销售岗');
  if (r.avoid_oncall) bits.push('回避 on-call');
  if (r.avoid_late_us_overlap) bits.push('回避深夜美西 overlapping 会议');
  if (r.require_china_eligible) bits.push('只要已确认中国可受雇');
  if (Array.isArray(r.prefer_hire_vehicles) && r.prefer_hire_vehicles.length) {
    bits.push(`雇佣载体偏好: ${r.prefer_hire_vehicles.join('/')}`);
  }
  if (Array.isArray(r.prefer_tracks) && r.prefer_tracks.length) {
    bits.push(`轨道: ${r.prefer_tracks.join('/')}`);
  }
  return bits.join('；');
}

async function getRecentFeedbackSummary(userKey = 'iris', limit = 8) {
  const p = requirePool();
  const res = await p.query(
    `SELECT company, title, outcome, liked, disliked, notes
     FROM application_feedback
     WHERE user_key = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userKey, limit]
  );
  if (!res.rows.length) return '';
  return res.rows.map((r) => {
    return [
      r.outcome || '?',
      r.company || '',
      r.title ? String(r.title).slice(0, 40) : '',
      r.liked ? `喜欢:${r.liked}` : '',
      r.disliked ? `不喜欢:${r.disliked}` : '',
    ].filter(Boolean).join(' · ');
  }).join('\n');
}

async function buildScoringPreferenceContext(userKey = 'iris') {
  const [prefs, feedback] = await Promise.all([
    getPreferenceSummary(userKey).catch(() => ''),
    getRecentFeedbackSummary(userKey).catch(() => ''),
  ]);
  const parts = [];
  if (prefs) parts.push(`偏好：${prefs}`);
  if (feedback) parts.push(`近期面试/投递反馈：\n${feedback}`);
  return parts.join('\n\n').slice(0, 1800);
}

async function getWeightOverrides(userKey = 'iris') {
  const p = getPool();
  if (!p) return {};
  try {
    const res = await p.query(
      `SELECT weight_overrides FROM user_preferences WHERE user_key = $1`,
      [userKey]
    );
    return res.rows[0]?.weight_overrides || {};
  } catch {
    return {};
  }
}

async function listJobsByStatus({
  status,
  track,
  chinaEligible,
  scoreStatus,
  sourceBucket,
  includeExpired = false,
  limit = 15,
} = {}) {
  const p = requirePool();
  const clauses = [];
  const params = [];
  if (!includeExpired) clauses.push('expired = FALSE');
  if (status) {
    params.push(status);
    clauses.push(`recommendation_status = $${params.length}`);
  }
  if (track) {
    params.push(track);
    clauses.push(`track = $${params.length}`);
  }
  if (chinaEligible) {
    params.push(chinaEligible);
    clauses.push(`china_eligible = $${params.length}`);
  }
  if (scoreStatus) {
    params.push(scoreStatus);
    clauses.push(`score_status = $${params.length}`);
  }
  if (sourceBucket) {
    params.push(sourceBucket);
    clauses.push(`source_bucket = $${params.length}`);
  }
  params.push(limit);
  const where = clauses.length ? clauses.join(' AND ') : 'TRUE';
  const res = await p.query(
    `SELECT id, title, company, apply_url, match_score, recommendation_status,
            track, score_reason, china_eligible, china_eligibility_reason,
            work_mode, hire_vehicle, employment_type, source, source_name,
            source_bucket, score_status, score_error, score_tech, score_delivery,
            score_level, score_workstyle, score_comp, score_trust, legacy_import,
            evidence_snippets, published_at, last_seen_at
     FROM jobs
     WHERE ${where}
     ORDER BY match_score DESC NULLS LAST, last_seen_at DESC
     LIMIT $${params.length}`,
    params
  );
  return res.rows;
}

async function listReviewQueue({ limit = 15 } = {}) {
  const p = requirePool();
  const res = await p.query(
    `SELECT id, title, company, apply_url, match_score, recommendation_status,
            china_eligible, china_eligibility_reason, score_status, score_error,
            source, source_bucket, work_mode, hire_vehicle, score_reason
     FROM jobs
     WHERE expired = FALSE
       AND (
         china_eligible = 'unclear'
         OR score_status = 'error'
         OR recommendation_status = 'verify'
       )
     ORDER BY
       CASE WHEN score_status = 'error' THEN 0
            WHEN china_eligible = 'unclear' THEN 1
            ELSE 2 END,
       last_seen_at DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function explainJob(jobIdOrDedup) {
  const p = requirePool();
  const res = await p.query(
    `SELECT * FROM jobs
     WHERE id::text = $1 OR dedup_key = $1 OR apply_url = $1
     ORDER BY last_seen_at DESC LIMIT 1`,
    [String(jobIdOrDedup)]
  );
  return res.rows[0] || null;
}

async function searchJobs({ q, track, status, limit = 15 } = {}) {
  const p = requirePool();
  const params = [];
  const clauses = ['expired = FALSE'];
  if (q) {
    params.push(`%${q}%`);
    clauses.push(`(title ILIKE $${params.length} OR company ILIKE $${params.length} OR apply_url ILIKE $${params.length})`);
  }
  if (track) {
    params.push(track);
    clauses.push(`track = $${params.length}`);
  }
  if (status) {
    params.push(status);
    clauses.push(`recommendation_status = $${params.length}`);
  }
  params.push(limit);
  const res = await p.query(
    `SELECT id, title, company, apply_url, match_score, recommendation_status,
            china_eligible, score_status, source, source_bucket, track
     FROM jobs WHERE ${clauses.join(' AND ')}
     ORDER BY match_score DESC NULLS LAST LIMIT $${params.length}`,
    params
  );
  return res.rows;
}

async function getRadarStats() {
  const p = requirePool();
  const [counts, lastRun, lastJobs] = await Promise.all([
    p.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE recommendation_status = 'apply_now')::int AS apply_now,
        count(*) FILTER (WHERE recommendation_status = 'verify')::int AS verify,
        count(*) FILTER (WHERE score_status = 'error')::int AS score_error,
        count(*) FILTER (WHERE china_eligible = 'unclear')::int AS china_unclear,
        count(*) FILTER (WHERE legacy_import)::int AS legacy,
        count(*) FILTER (WHERE expired)::int AS expired
      FROM jobs`),
    p.query(`SELECT * FROM radar_runs ORDER BY started_at DESC LIMIT 1`),
    p.query(`SELECT max(last_seen_at) AS last_seen FROM jobs`),
  ]);
  return {
    jobs: counts.rows[0],
    lastRun: lastRun.rows[0] || null,
    lastSeenAt: lastJobs.rows[0]?.last_seen || null,
  };
}

async function recordRadarRun(stats) {
  const p = getPool();
  if (!p) return null;
  const res = await p.query(
    `INSERT INTO radar_runs (
       finished_at, scraped, new_items, l1, scored_ok, scored_error, pushed, status, error_text, meta
     ) VALUES (NOW(), $1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      stats.scraped || 0,
      stats.newItems || 0,
      stats.l1 || 0,
      stats.scored_ok || 0,
      stats.scored_error || 0,
      stats.sent || stats.pushed || 0,
      stats.status || 'ok',
      stats.error_text || null,
      JSON.stringify(stats.meta || {}),
    ]
  );
  return res.rows[0] || null;
}

async function listApplications({ userKey = 'iris', status, limit = 20 } = {}) {
  const p = requirePool();
  const params = [userKey];
  let sql = `SELECT * FROM applications WHERE user_key = $1`;
  if (status) {
    params.push(status);
    sql += ` AND application_status = $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY updated_at DESC LIMIT $${params.length}`;
  const res = await p.query(sql, params);
  return res.rows;
}

async function updateApplicationStatus({
  userKey = 'iris',
  jobId,
  status,
  title,
  company,
  applyUrl,
  source,
  dedupKey,
  notes,
}) {
  const p = requirePool();
  const key = dedupKey || (jobId ? `job:${jobId}` : `url:${applyUrl || title}`);
  const res = await p.query(
    `INSERT INTO applications (
       user_key, job_id, source, company, title, apply_url, dedup_key,
       application_status, notes, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (user_key, dedup_key) DO UPDATE SET
       application_status = EXCLUDED.application_status,
       notes = COALESCE(EXCLUDED.notes, applications.notes),
       job_id = COALESCE(EXCLUDED.job_id, applications.job_id),
       updated_at = NOW()
     RETURNING *`,
    [
      userKey,
      jobId || null,
      source || null,
      company || null,
      title || null,
      applyUrl || null,
      key,
      status,
      notes || null,
    ]
  );
  return res.rows[0] || null;
}

async function saveConversation({ userKey = 'iris', chatId, role, content, toolCalls }) {
  const p = requirePool();
  const res = await p.query(
    `INSERT INTO conversations (user_key, telegram_chat_id, role, content, tool_calls)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [userKey, chatId || null, role, content, toolCalls ? JSON.stringify(toolCalls) : null]
  );
  return res.rows[0]?.id || null;
}

async function insertPreferenceSignal(row) {
  const p = requirePool();
  const res = await p.query(
    `INSERT INTO preference_signals
       (user_key, signal_type, signal_value, raw_text, status, conversation_id, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $5 = 'confirmed' THEN NOW() ELSE NULL END)
     RETURNING id, status`,
    [
      row.userKey || 'iris',
      row.signalType,
      JSON.stringify(row.signalValue || {}),
      row.rawText || null,
      row.status || 'pending',
      row.conversationId || null,
    ]
  );
  return res.rows[0] || null;
}

async function confirmPreferenceSignal(signalId, userKey = 'iris') {
  const p = requirePool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const sig = await client.query(
      `UPDATE preference_signals
       SET status = 'confirmed', confirmed_at = NOW()
       WHERE id = $1 AND user_key = $2 AND status = 'pending'
       RETURNING *`,
      [signalId, userKey]
    );
    if (!sig.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'signal not found or already handled' };
    }
    const s = sig.rows[0];
    const val = s.signal_value || {};
    const updates = ['updated_at = NOW()'];
    const params = [userKey];
    for (const k of [
      'prefer_async', 'prefer_few_meetings', 'avoid_sales',
      'avoid_oncall', 'avoid_late_us_overlap', 'require_china_eligible',
    ]) {
      if (typeof val[k] === 'boolean') {
        params.push(val[k]);
        updates.push(`${k} = $${params.length}`);
      }
    }
    if (typeof val.preference_summary_append === 'string' && val.preference_summary_append.trim()) {
      params.push(val.preference_summary_append.trim());
      updates.push(`preference_summary = TRIM(BOTH FROM (preference_summary || E'\\n' || $${params.length}))`);
    } else if (s.raw_text) {
      params.push(s.raw_text.slice(0, 200));
      updates.push(`preference_summary = TRIM(BOTH FROM (preference_summary || E'\\n' || $${params.length}))`);
    }
    await client.query(
      `UPDATE user_preferences SET ${updates.join(', ')} WHERE user_key = $1`,
      params
    );
    await client.query('COMMIT');
    return { ok: true, signal: s };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

async function insertApplicationFeedback(row) {
  const p = requirePool();
  const res = await p.query(
    `INSERT INTO application_feedback
       (user_key, job_id, company, title, outcome, liked, disliked, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      row.userKey || 'iris',
      row.jobId || null,
      row.company || null,
      row.title || null,
      row.outcome || null,
      row.liked || null,
      row.disliked || null,
      row.notes || null,
    ]
  );
  return res.rows[0]?.id || null;
}

async function closePool() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}

function restConfig() {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !key) return null;
  return { base, key };
}

async function restFetch(path, { method = 'GET', body, prefer } = {}) {
  const cfg = restConfig();
  if (!cfg) throw new DbError('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing', 'NO_REST');
  const headers = {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${cfg.base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.message) || text || res.statusText;
    throw new DbError(msg, String(res.status));
  }
  return data;
}

async function restHealthCheck() {
  const rows = await restFetch('/rest/v1/jobs?select=id&limit=1');
  return {
    ok: true,
    hostHint: 'supabase-rest',
    jobsTable: true,
    sample: Array.isArray(rows) ? rows.length : 0,
  };
}

async function restUpsertRadarJob(job) {
  const hardCond = job.hard || {};
  const dims = job.dims || {};
  const dedup = job.dedupKey || `${job.source}|${job.url || job.title}`;
  const desc = String(job.contentText || job.content || job.title || '').slice(0, 20000);
  const applyUrl = job.url || job.apply_url || `https://example.invalid/${encodeURIComponent(dedup)}`;
  const hash = job.jd_hash || jdHashOf(desc);
  const bucket = sourceBucketOf(job);
  const publishedAt = job.publishedAt || job.published_at
    ? new Date(job.publishedAt || job.published_at)
    : null;
  const firstSeen = job.first_seen_at || job.at || null;
  const row = {
    source: job.source || 'radar',
    source_job_id: job.sourceJobId || null,
    title: String(job.title || 'Untitled').slice(0, 500),
    company: job.company || null,
    description_raw: desc,
    description_clean: desc,
    location_raw: job.location || job.location_raw || null,
    china_eligible: hardCond.china_eligible || job.china_eligible || 'unclear',
    china_eligibility_reason: hardCond.china_eligibility_reason || job.china_eligibility_reason || null,
    employment_type: hardCond.employment_type || job.employment_type || null,
    apply_url: applyUrl,
    dedup_key: dedup,
    published_at: publishedAt && !isNaN(publishedAt.getTime()) ? publishedAt.toISOString() : null,
    match_score: typeof job.groqScore === 'number' ? job.groqScore
      : (typeof job.score === 'number' ? job.score : null),
    recommendation_text: job.groqReason || job.score_reason || null,
    intent: 'hiring',
    work_mode: hardCond.work_mode || job.work_mode || null,
    hire_vehicle: hardCond.hire_vehicle || job.hire_vehicle || null,
    benefits_signal: hardCond.benefits_signal || null,
    track: job.track || null,
    score_tech: dims.tech ?? job.score_tech ?? null,
    score_delivery: dims.delivery ?? job.score_delivery ?? null,
    score_level: dims.level ?? job.score_level ?? null,
    score_workstyle: dims.workstyle ?? job.score_workstyle ?? null,
    score_comp: dims.comp ?? job.score_comp ?? null,
    score_trust: dims.trust ?? job.score_trust ?? null,
    recommendation_status: job.recommendation_status || null,
    score_reason: job.groqReason || job.score_reason || null,
    migration: job.migration || null,
    elig_labels: Array.isArray(job.eligLabels) ? job.eligLabels : [],
    hit_keywords: Array.isArray(job.hitKeywords) ? job.hitKeywords : [],
    source_name: job.sourceName || job.source_name || null,
    groq_skipped: !!job.groqScoreSkipped,
    score_status: job.score_status || (job.groqScoreSkipped ? 'skipped' : 'pending'),
    score_error: job.score_error || null,
    legacy_import: !!job.legacy_import,
    expired: !!job.expired,
    source_bucket: bucket,
    jd_hash: hash,
    profile_version: job.profile_version || process.env.RADAR_PROFILE_VERSION || 'v1',
    prompt_version: job.prompt_version || process.env.RADAR_PROMPT_VERSION || 'v1',
    evidence_snippets: Array.isArray(job.evidence_snippets) ? job.evidence_snippets : [],
    first_seen_at: firstSeen ? new Date(firstSeen).toISOString() : undefined,
    last_seen_at: new Date().toISOString(),
  };
  // strip undefined so PostgREST keeps DB defaults
  for (const k of Object.keys(row)) {
    if (row[k] === undefined) delete row[k];
  }
  const out = await restFetch('/rest/v1/jobs?on_conflict=dedup_key', {
    method: 'POST',
    body: row,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  return Array.isArray(out) ? out[0] : out;
}

module.exports = {
  DbError,
  getPool,
  requirePool,
  resolveDatabaseUrl,
  query,
  healthCheck,
  upsertRadarJob,
  restHealthCheck,
  restUpsertRadarJob,
  restConfig,
  getCachedScore,
  saveScoreCache,
  jdHashOf,
  sourceBucketOf,
  getPreferenceSummary,
  getRecentFeedbackSummary,
  buildScoringPreferenceContext,
  getWeightOverrides,
  listJobsByStatus,
  listReviewQueue,
  explainJob,
  searchJobs,
  getRadarStats,
  recordRadarRun,
  listApplications,
  updateApplicationStatus,
  saveConversation,
  insertPreferenceSignal,
  confirmPreferenceSignal,
  insertApplicationFeedback,
  closePool,
};
