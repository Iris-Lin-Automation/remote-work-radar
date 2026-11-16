#!/usr/bin/env node
/**
 * After .env has Supabase pooler + SUPABASE_* keys, run:
 *   node scripts/cloud-p0-bootstrap.js
 *
 * Steps: validate env → healthCheck → import-legacy → test:cloud-p0
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');

function run(cmd, args) {
  console.log(`\n>>> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    throw new Error(`command failed: ${cmd} ${args.join(' ')} (exit ${r.status})`);
  }
}

try {
  run('node', ['scripts/validate-cloud-env.js']);
  run('npm', ['run', 'db:health']);
  run('npm', ['run', 'import-legacy']);
  run('npm', ['run', 'test:cloud-p0']);
  console.log('\n✅ Cloud P0 local bootstrap finished. Next: GitHub secrets + Cloudflare Worker.');
} catch (e) {
  console.error('\n❌', e.message);
  process.exit(1);
}
