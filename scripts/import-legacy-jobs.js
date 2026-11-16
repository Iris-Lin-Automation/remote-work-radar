#!/usr/bin/env node
/**
 * import-legacy-jobs.js — Import data/pushed_jobs.json (+ seen keys metadata)
 * into cloud Postgres. Marks legacy_import=true so they are not re-pushed as new.
 *
 * Usage:
 *   node scripts/import-legacy-jobs.js
 *   node scripts/import-legacy-jobs.js --rescore=false
 */

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { extractHardConditions, checkEligibility } = require('./quick-match');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const eq = t.indexOf('=');
    if (eq < 0) return;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  });
}

const PUSHED = path.join(__dirname, '..', 'data', 'pushed_jobs.json');
const SEEN = path.join(__dirname, '..', 'data', 'seen_jobs.json');
const EXPIRE_DAYS = parseInt(process.env.LEGACY_EXPIRE_DAYS || '45', 10);

function inferTrack(j) {
  const src = String(j.source || '');
  if (/V2EX|电鸭|远程\.work|yuancheng|yw_/i.test(src)) return 'cn';
  return 'en';
}

function sourceKey(src) {
  const s = String(src || '').toLowerCase();
  if (s.includes('jobicy')) return 'jobicy_apac';
  if (s.includes('v2ex')) return 'v2ex_jobs';
  if (s.includes('电鸭') || s.includes('eleduck')) return 'eleduck';
  if (s.includes('wwr') || s.includes('we work')) return 'wwr_programming';
  if (s.includes('growix')) return 'growix';
  if (s.includes('opentrain')) return 'opentrain';
  if (s.includes('远程')) return 'yw_dev';
  return s.replace(/\s+/g, '_').slice(0, 40) || 'legacy';
}

function dedupFromUrl(source, url, title) {
  const id = (url || title || '').replace(/#reply\d+$/, '').trim();
  return `${source}|${id}`;
}

async function main() {
  console.log('[legacy-import] starting…');
  let mode = 'pg';
  try {
    const health = await db.healthCheck();
    console.log(`[legacy-import] DB ok (${health.hostHint})`);
  } catch (pgErr) {
    console.log(`[legacy-import] pg unavailable (${pgErr.message}) — trying Supabase REST`);
    const health = await db.restHealthCheck();
    console.log(`[legacy-import] REST ok (${health.hostHint})`);
    mode = 'rest';
  }

  if (!fs.existsSync(PUSHED)) {
    throw new Error(`missing ${PUSHED}`);
  }
  const pushed = JSON.parse(fs.readFileSync(PUSHED, 'utf8'));
  const jobs = Array.isArray(pushed.jobs) ? pushed.jobs : [];
  let seenKeys = new Set();
  if (fs.existsSync(SEEN)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SEEN, 'utf8'));
      seenKeys = new Set(Array.isArray(raw.keys) ? raw.keys : []);
    } catch { /* */ }
  }

  const report = {
    total: jobs.length,
    success: 0,
    duplicate: 0,
    failed: 0,
    expired: 0,
    seenKeys: seenKeys.size,
    mode,
    errors: [],
  };

  const cutoff = Date.now() - EXPIRE_DAYS * 24 * 3600 * 1000;

  for (const j of jobs) {
    const source = sourceKey(j.source);
    const url = j.url || null;
    const title = j.title || 'Untitled';
    const dedupKey = dedupFromUrl(source, url, title);
    const at = j.at ? new Date(j.at) : null;
    const expired = at && !isNaN(at.getTime()) ? at.getTime() < cutoff : false;
    if (expired) report.expired++;

    const stub = {
      title,
      contentText: `${title} ${j.source || ''}`,
      location: '',
      source,
    };
    const hard = extractHardConditions(stub);
    const elig = checkEligibility(stub, inferTrack(j));
    const track = inferTrack(j);
    const score = typeof j.score === 'number' ? j.score : null;

    const payload = {
      source,
      sourceName: j.source || source,
      title,
      url,
      contentText: stub.contentText,
      publishedAt: at ? at.toISOString() : null,
      at: at ? at.toISOString() : null,
      first_seen_at: at ? at.toISOString() : null,
      dedupKey,
      track,
      score,
      groqScore: score,
      groqReason: 'legacy_import',
      score_reason: 'legacy_import',
      score_status: score != null ? 'ok' : 'skipped',
      recommendation_status: expired
        ? 'skip'
        : (hard.china_eligible === 'true' && score != null && score >= 70
          ? 'apply_now'
          : 'verify'),
      hard,
      eligLabels: elig.labels || [],
      legacy_import: true,
      expired: !!expired,
      source_bucket: db.sourceBucketOf({ source }),
    };

    try {
      let existed = false;
      let row = null;
      if (mode === 'pg') {
        const before = await db.query(
          'SELECT id FROM jobs WHERE dedup_key = $1',
          [dedupKey],
          { hard: true }
        );
        existed = before.rows.length > 0;
        row = await db.upsertRadarJob(payload, { hard: true });
      } else {
        const cfg = db.restConfig();
        const prior = await fetch(
          `${cfg.base}/rest/v1/jobs?dedup_key=eq.${encodeURIComponent(dedupKey)}&select=id`,
          { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } }
        );
        const priorRows = await prior.json();
        existed = Array.isArray(priorRows) && priorRows.length > 0;
        row = await db.restUpsertRadarJob(payload);
      }

      if (!row) {
        report.failed++;
        report.errors.push({ dedupKey, error: 'upsert returned null' });
      } else if (existed) {
        report.duplicate++;
        report.success++;
      } else {
        report.success++;
      }
    } catch (err) {
      report.failed++;
      report.errors.push({ dedupKey, error: err.message });
      if (report.errors.length <= 8) {
        console.log(`  fail ${dedupKey}: ${err.message}`);
      }
    }
  }

  console.log('\n=== legacy import report ===');
  console.log(JSON.stringify({
    total: report.total,
    success: report.success,
    duplicate: report.duplicate,
    failed: report.failed,
    expired: report.expired,
    seenKeys: report.seenKeys,
    sampleErrors: report.errors.slice(0, 5),
  }, null, 2));

  await db.closePool();
  if (report.failed && report.failed === report.total) process.exit(1);
}

main().catch(async (err) => {
  console.error('[legacy-import] FATAL:', err.message);
  await db.closePool().catch(() => {});
  process.exit(1);
});
