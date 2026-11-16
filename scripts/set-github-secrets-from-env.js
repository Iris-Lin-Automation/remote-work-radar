#!/usr/bin/env node
/**
 * Push selected .env keys to GitHub Actions secrets via `gh secret set`.
 * Usage: node scripts/set-github-secrets-from-env.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'GROQ_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GROQ_MODEL',
  'DATABASE_URL',
];

function loadEnv() {
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function bad(name, val) {
  if (!val) return 'empty';
  if (/YOUR_|changeme|xxx|\[YOUR-PASSWORD\]|\[PASSWORD\]|GRANT |Run once/i.test(val)) {
    return 'placeholder_or_corrupt';
  }
  if (name === 'DATABASE_URL' && !/pooler\.supabase\.com/i.test(val)) return 'not_pooler';
  return null;
}

function main() {
  const env = loadEnv();
  const results = [];
  for (const name of KEYS) {
    const val = (env[name] || '').trim();
    const why = bad(name, val);
    if (why) {
      results.push({ name, status: 'skipped', why });
      continue;
    }
    const r = spawnSync('gh', ['secret', 'set', name, '-R', 'Iris-Lin-Automation/remote-work-radar'], {
      input: val,
      encoding: 'utf8',
      cwd: root,
      shell: true,
    });
    if (r.status !== 0) {
      results.push({ name, status: 'error', why: (r.stderr || r.stdout || '').trim() });
    } else {
      results.push({ name, status: 'set', len: val.length });
    }
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some((x) => x.status === 'error')) process.exit(1);
}

main();
