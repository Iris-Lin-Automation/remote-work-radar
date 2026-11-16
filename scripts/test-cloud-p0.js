#!/usr/bin/env node
/**
 * P0 tests: eligibility, LLM error path (no fake scores), optional live DB smoke.
 * Exit 0 if unit tests pass. Live DB/Telegram marked separately.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

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

const {
  extractHardConditions,
  decideRecommendation,
  validateDims,
  createMatcher,
  GROQ_MODEL,
  loadWeights,
} = require('./quick-match');
const db = require('./db');

const results = [];
function pass(name) { results.push({ name, ok: true }); console.log(`✅ ${name}`); }
function fail(name, err) { results.push({ name, ok: false, err: String(err) }); console.error(`❌ ${name}: ${err}`); }

async function run() {
  // 1) eligibility / hard rules
  try {
    const blocked = extractHardConditions({
      title: 'SWE',
      contentText: 'Must be US citizen. US only remote.',
    });
    assert.strictEqual(blocked.china_eligible, 'false');
    const worldwide = extractHardConditions({
      title: 'Engineer',
      contentText: 'Fully remote worldwide. Independent contractor welcome.',
    });
    assert.strictEqual(worldwide.china_eligible, 'true');
    const unclear = extractHardConditions({
      title: 'Engineer',
      contentText: 'Worldwide remote. Full-time employee.',
    });
    assert.strictEqual(unclear.china_eligible, 'unclear');
    pass('hard china_eligible rules');
  } catch (e) { fail('hard china_eligible rules', e.message); }

  // 2) decideRecommendation: error never apply_now
  try {
    const w = loadWeights();
    const hard = { china_eligible: 'true', work_mode: 'fully_remote', source_bucket: 'core_fulltime' };
    const dims = { tech: 90, delivery: 80, level: 70, workstyle: 80, comp: 70, trust: 70 };
    const stErr = decideRecommendation({
      hard, dims, total: 90, weights: w, eligRejected: false, scoreStatus: 'error',
    });
    assert.strictEqual(stErr, 'verify');
    const stOk = decideRecommendation({
      hard, dims, total: 90, weights: w, eligRejected: false, scoreStatus: 'ok',
    });
    assert.strictEqual(stOk, 'apply_now');
    const unclearSt = decideRecommendation({
      hard: { ...hard, china_eligible: 'unclear' },
      dims, total: 90, weights: w, eligRejected: false, scoreStatus: 'ok',
    });
    assert.strictEqual(unclearSt, 'verify');
    pass('recommendation_status gates');
  } catch (e) { fail('recommendation_status gates', e.message); }

  // 3) validateDims rejects incomplete
  try {
    assert.throws(() => validateDims({ tech: 1 }), /missing/);
    const ok = validateDims({
      tech: 10, delivery: 20, level: 30, workstyle: 40, comp: 50, trust: 60, migration: 'near',
    });
    assert.strictEqual(ok.dims.trust, 60);
    pass('validateDims');
  } catch (e) { fail('validateDims', e.message); }

  // 4) GROQ_MODEL default
  try {
    assert.ok(GROQ_MODEL === 'openai/gpt-oss-20b' || process.env.GROQ_MODEL || process.env.GROQ_QUICK_MODEL);
    console.log(`   model=${GROQ_MODEL}`);
    pass('GROQ_MODEL configured');
  } catch (e) { fail('GROQ_MODEL configured', e.message); }

  // 5) matcher error path — no fake 40/45 scores when key missing
  try {
    const prev = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    // recreate matcher in isolation via require cache is hard; call layer2 with empty key by constructing manually
    const matcher = createMatcher({ preferenceSummary: '' });
    // createMatcher already captured groqKey at init — if key was set, skip this assertion nuance
    const r = await matcher.layer2({
      title: 'AI Automation Engineer',
      contentText: 'Remote worldwide contractor Python n8n LangGraph',
    });
    if (!prev) {
      assert.strictEqual(r.score_status, 'skipped');
      assert.strictEqual(r.score, null);
      assert.notStrictEqual(r.recommendation_status, 'apply_now');
    } else {
      // with key present, just ensure shape
      assert.ok(['ok', 'error', 'cached', 'skipped'].includes(r.score_status));
      if (r.score_status === 'error') assert.strictEqual(r.score, null);
    }
    if (prev) process.env.GROQ_API_KEY = prev;
    pass('no fake scores on skip/error');
  } catch (e) { fail('no fake scores on skip/error', e.message); }

  // 6) source buckets
  try {
    assert.strictEqual(db.sourceBucketOf({ source: 'growix' }), 'evergreen_contractor');
    assert.strictEqual(db.sourceBucketOf({ source: 'opentrain' }), 'flexible_ai_tasks');
    assert.strictEqual(db.sourceBucketOf({ source: 'himalayas' }), 'core_fulltime');
    pass('source_bucket tags');
  } catch (e) { fail('source_bucket tags', e.message); }

  // 7) Live DB smoke (optional)
  const live = { db: 'skipped', note: '' };
  const url = process.env.DATABASE_URL || '';
  if (!url) {
    live.note = 'DATABASE_URL unset';
  } else if (/localhost|127\.0\.0\.1/i.test(url)) {
    live.db = 'blocked';
    live.note = 'DATABASE_URL is localhost — set Supabase pooler URL for cloud';
    fail('live DB health', live.note);
  } else {
    try {
      const h = await db.healthCheck();
      assert.ok(h.ok);
      // upsert smoke + dedup
      const dedup = `test|smoke-${Date.now()}`;
      const row1 = await db.upsertRadarJob({
        source: 'manual',
        title: 'Smoke Test Role',
        url: `https://example.com/${dedup}`,
        contentText: 'Remote worldwide contractor Python automation',
        dedupKey: dedup,
        track: 'en',
        groqScore: 11,
        score_status: 'skipped',
        recommendation_status: 'verify',
        hard: extractHardConditions({
          title: 'Smoke',
          contentText: 'Remote worldwide contractor',
        }),
        legacy_import: true,
      }, { hard: true });
      const row2 = await db.upsertRadarJob({
        source: 'manual',
        title: 'Smoke Test Role Updated',
        url: `https://example.com/${dedup}`,
        contentText: 'Remote worldwide contractor Python automation',
        dedupKey: dedup,
        track: 'en',
        groqScore: 12,
        score_status: 'skipped',
        recommendation_status: 'verify',
        hard: extractHardConditions({
          title: 'Smoke',
          contentText: 'Remote worldwide contractor',
        }),
        legacy_import: true,
      }, { hard: true });
      assert.ok(row1 && row2);
      assert.strictEqual(row1.dedup_key, row2.dedup_key);
      live.db = 'ok';
      live.note = `${h.hostHint} ${h.latencyMs}ms`;
      pass('live DB health + upsert dedup');
    } catch (e) {
      // pg pooler password often missing locally; REST is enough for cloud P0 Worker path
      if (db.restConfig()) {
        try {
          const rh = await db.restHealthCheck();
          const dedup = `test|smoke-rest-${Date.now()}`;
          const row1 = await db.restUpsertRadarJob({
            source: 'manual',
            title: 'Smoke Test Role REST',
            url: `https://example.com/${dedup}`,
            contentText: 'Remote worldwide contractor Python automation',
            dedupKey: dedup,
            track: 'en',
            groqScore: 11,
            score_status: 'skipped',
            recommendation_status: 'verify',
            hard: extractHardConditions({
              title: 'Smoke',
              contentText: 'Remote worldwide contractor',
            }),
            legacy_import: true,
          });
          const row2 = await db.restUpsertRadarJob({
            source: 'manual',
            title: 'Smoke Test Role REST Updated',
            url: `https://example.com/${dedup}`,
            contentText: 'Remote worldwide contractor Python automation',
            dedupKey: dedup,
            track: 'en',
            groqScore: 12,
            score_status: 'skipped',
            recommendation_status: 'verify',
            hard: extractHardConditions({
              title: 'Smoke',
              contentText: 'Remote worldwide contractor',
            }),
            legacy_import: true,
          });
          assert.ok(rh.ok && row1 && row2);
          assert.strictEqual(row1.dedup_key, row2.dedup_key);
          live.db = 'ok';
          live.note = `supabase-rest (pg failed: ${e.message})`;
          pass('live DB health + upsert dedup');
        } catch (restErr) {
          live.db = 'error';
          live.note = `pg: ${e.message}; rest: ${restErr.message}`;
          fail('live DB health + upsert dedup', live.note);
        }
      } else {
        live.db = 'error';
        live.note = e.message;
        fail('live DB health + upsert dedup', e.message);
      }
    }
  }

  await db.closePool().catch(() => {});

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== P0 test summary ===');
  console.log(JSON.stringify({
    passed: results.filter((r) => r.ok).length,
    failed: failed.length,
    liveDb: live,
    groqModel: GROQ_MODEL,
    failures: failed,
  }, null, 2));

  // Unit failures → exit 1; live DB localhost is expected until user configures → still exit 1 only if unit failed
  const unitFailed = failed.filter((f) => f.name !== 'live DB health' && f.name !== 'live DB health + upsert dedup');
  if (unitFailed.length) process.exit(1);
  if (live.db === 'error') process.exit(2); // cloud URL set but broken
  process.exit(0);
}

run().catch(async (e) => {
  console.error(e);
  await db.closePool().catch(() => {});
  process.exit(1);
});
