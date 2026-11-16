#!/usr/bin/env node
/**
 * Safely set only the password in DATABASE_URL.
 * Usage: node scripts/set-db-password.js YourNewPassword
 */
'use strict';
const fs = require('fs');
const path = require('path');

const pw = process.argv[2];
if (!pw) {
  console.error('Usage: node scripts/set-db-password.js <password>');
  process.exit(1);
}
if (/GRANT |Run once|YOUR-PASSWORD|\[|\]|\s/i.test(pw)) {
  console.error('Refuse: password looks like SQL/placeholder/whitespace. Use a plain password.');
  process.exit(1);
}

const envPath = path.join(__dirname, '..', '.env');
let t = fs.readFileSync(envPath, 'utf8');
const host = 'aws-1-ap-southeast-2.pooler.supabase.com';
const user = 'postgres.trbupsgknqhyskefkbcq';
const url =
  'postgresql://' +
  encodeURIComponent(user) +
  ':' +
  encodeURIComponent(pw) +
  '@' +
  host +
  ':6543/postgres';

if (/^DATABASE_URL=/m.test(t)) {
  t = t.replace(/^DATABASE_URL=.*$/m, 'DATABASE_URL=' + url);
} else {
  t = t.trimEnd() + '\nDATABASE_URL=' + url + '\n';
}
fs.writeFileSync(envPath, t);
console.log('DATABASE_URL updated (host=' + host + ', pwLen=' + pw.length + ')');
console.log('Next: node scripts/db-health.js');
