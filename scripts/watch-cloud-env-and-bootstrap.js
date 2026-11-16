#!/usr/bin/env node
/**
 * Watches until either:
 *   A) DATABASE_URL is a Supabase pooler URI, or
 *   B) Supabase REST accepts service_role (grants applied),
 * then runs health + import-legacy + test:cloud-p0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');

function loadEnv() {
  const keys = {};
  if (!fs.existsSync(envPath)) return keys;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    keys[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return keys;
}

function applyEnv(keys) {
  for (const [k, v] of Object.entries(keys)) {
    if (!process.env[k]) process.env[k] = v;
  }
}

function hasPasswordPlaceholder(url) {
  return /YOUR_DB_PASSWORD|\[YOUR-PASSWORD\]|\[PASSWORD\]|YOUR_PASSWORD|changeme/i.test(url || '');
}

function isPoolerUrl(url) {
  return !!(
    url &&
    !/localhost|127\.0\.0\.1/i.test(url) &&
    !hasPasswordPlaceholder(url) &&
    /pooler\.supabase\.com/i.test(url)
  );
}

async function probeRest(keys) {
  const base = (keys.SUPABASE_URL || '').replace(/\/$/, '');
  const key = keys.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base.includes('supabase.co') || !key || /YOUR_|changeme|xxx/i.test(key)) {
    return { ok: false, why: 'SUPABASE_URL / SERVICE_ROLE missing' };
  }
  try {
    const res = await fetch(`${base}/rest/v1/jobs?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const text = await res.text();
    if (res.ok) return { ok: true };
    if (res.status === 403 && /permission denied/i.test(text)) {
      return {
        ok: false,
        why: 'REST 403 — run sql/grant-service-role.sql in SQL Editor, then wait',
      };
    }
    return { ok: false, why: `REST ${res.status}: ${text.slice(0, 120)}` };
  } catch (e) {
    return { ok: false, why: `REST probe failed: ${e.message}` };
  }
}

function run(cmd, args) {
  console.log(`\n>>> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
}

async function main() {
  console.log('[watch] waiting for pooler URI or REST grants …');
  console.log('[watch] A) Connect → Transaction pooler → paste DATABASE_URL');
  console.log('[watch] B) SQL Editor → run sql/grant-service-role.sql (REST path)');
  let lastWhy = '';
  let bootstrapped = false;

  while (!bootstrapped) {
    const keys = loadEnv();
    applyEnv(keys);

    let pathName = null;
    const url = keys.DATABASE_URL || '';
    if (hasPasswordPlaceholder(url)) {
      const why = 'DATABASE_URL still has [YOUR-PASSWORD] — Connect→copy URI→replace with real DB password';
      if (why !== lastWhy) {
        console.log(`[watch] not ready: ${why}`);
        lastWhy = why;
      }
    } else if (isPoolerUrl(url)) {
      pathName = 'pooler';
    } else {
      const rest = await probeRest(keys);
      if (rest.ok) {
        pathName = 'rest';
        try {
          fs.writeFileSync(path.join(root, '.rest-grants-ok'), new Date().toISOString());
        } catch { /* */ }
      } else if (rest.why !== lastWhy) {
        console.log(`[watch] not ready: ${rest.why}`);
        lastWhy = rest.why;
      }
    }

    if (!pathName) {
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }

    console.log(`[watch] ready via ${pathName} — running import + tests`);
    try {
      if (pathName === 'pooler') {
        run('node', ['scripts/db-health.js']);
      } else {
        run('node', ['scripts/rest-health.js']);
      }
      run('node', ['scripts/import-legacy-jobs.js']);
      run('node', ['scripts/test-cloud-p0.js']);
      console.log('\n[watch] done. Next: GitHub secrets + Cloudflare Worker.');
      bootstrapped = true;
    } catch (e) {
      console.log(`[watch] bootstrap failed (${e.message}) — retrying in 8s`);
      lastWhy = e.message;
      await new Promise((r) => setTimeout(r, 8000));
    }
  }
}

main().catch((e) => {
  console.error('[watch]', e.message);
  process.exit(1);
});
