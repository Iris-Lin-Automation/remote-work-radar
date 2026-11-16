#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}
const db = require('./db');
db.healthCheck()
  .then(async (r) => {
    console.log(JSON.stringify(r, null, 2));
    await db.closePool();
  })
  .catch(async (e) => {
    console.error(e.message || e);
    await db.closePool().catch(() => {});
    process.exit(1);
  });
