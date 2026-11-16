#!/usr/bin/env node
/** Gate: is .env ready for Supabase?
 *  - readyForDb: DATABASE_URL is cloud pooler (enough for import/radar)
 *  - readyForWorker: also SUPABASE_URL + SERVICE_ROLE_KEY
 */
'use strict';
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (!fs.existsSync(envPath)) {
  console.log(JSON.stringify({ ready: false, readyForDb: false, reason: 'no .env' }));
  process.exit(1);
}
const keys = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  keys[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}
const issues = [];
const dbIssues = [];
const url = keys.DATABASE_URL || '';
if (!url) {
  issues.push('DATABASE_URL missing');
  dbIssues.push('DATABASE_URL missing');
} else if (/localhost|127\.0\.0\.1/i.test(url)) {
  issues.push('DATABASE_URL still localhost');
  dbIssues.push('DATABASE_URL still localhost — use Transaction pooler');
} else if (/YOUR_DB_PASSWORD|\[PASSWORD\]|YOUR_PASSWORD/i.test(url)) {
  issues.push('DATABASE_URL still has password placeholder');
  dbIssues.push('Replace YOUR_DB_PASSWORD in DATABASE_URL with the real DB password');
} else if (!/supabase|pooler/i.test(url)) {
  issues.push('DATABASE_URL does not look like Supabase pooler');
  dbIssues.push('DATABASE_URL does not look like Supabase pooler');
}
if (!keys.SUPABASE_URL) issues.push('SUPABASE_URL missing');
if (!keys.SUPABASE_SERVICE_ROLE_KEY) issues.push('SUPABASE_SERVICE_ROLE_KEY missing (needed for Telegram Worker)');
if (!keys.GROQ_MODEL) issues.push('GROQ_MODEL missing');

const readyForDb = dbIssues.length === 0;
const readyForWorker = readyForDb && !!keys.SUPABASE_URL && !!keys.SUPABASE_SERVICE_ROLE_KEY;
const ready = readyForWorker && !!keys.GROQ_MODEL;

console.log(JSON.stringify({
  ready,
  readyForDb,
  readyForWorker,
  issues,
  dbIssues,
  next: !readyForDb
    ? 'Paste Transaction pooler URI into DATABASE_URL (highest priority)'
    : (!readyForWorker
      ? 'DB OK for import. Next: paste Secret key into SUPABASE_SERVICE_ROLE_KEY'
      : 'run: npm run cloud:bootstrap'),
}, null, 2));
process.exit(readyForDb ? 0 : 1);
