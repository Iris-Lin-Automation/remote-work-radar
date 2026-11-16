#!/usr/bin/env node
/**
 * Deploy Cloudflare Worker + put secrets from .env + set Telegram webhook.
 *
 * Prerequisites:
 *   npx wrangler login   (once)
 *
 * Usage:
 *   node scripts/deploy-telegram-worker.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const workerDir = path.join(root, 'workers', 'telegram-webhook');
const envPath = path.join(root, '.env');

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

function run(cmd, args, opts = {}) {
  console.log(`>>> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || workerDir,
    stdio: opts.input ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    shell: true,
    input: opts.input,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
  });
  if (opts.input) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
  return r;
}

function putSecret(name, value) {
  if (!value) throw new Error(`missing ${name}`);
  run('npx', ['wrangler', 'secret', 'put', name], { input: `${value}\n` });
  console.log(`  set ${name} (len=${value.length})`);
}

async function main() {
  const env = loadEnv();
  let webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!webhookSecret || /changeme|xxx|YOUR_/i.test(webhookSecret)) {
    webhookSecret = crypto.randomBytes(24).toString('hex');
    let t = fs.readFileSync(envPath, 'utf8');
    if (/^TELEGRAM_WEBHOOK_SECRET=/m.test(t)) {
      t = t.replace(/^TELEGRAM_WEBHOOK_SECRET=.*$/m, `TELEGRAM_WEBHOOK_SECRET=${webhookSecret}`);
    } else {
      t = `${t.trimEnd()}\nTELEGRAM_WEBHOOK_SECRET=${webhookSecret}\n`;
    }
    fs.writeFileSync(envPath, t);
    console.log('generated TELEGRAM_WEBHOOK_SECRET');
  }

  const required = {
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    ALLOWED_TELEGRAM_USER_ID: env.TELEGRAM_CHAT_ID || env.ALLOWED_TELEGRAM_USER_ID,
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    GROQ_API_KEY: env.GROQ_API_KEY,
    GROQ_MODEL: env.GROQ_MODEL || 'openai/gpt-oss-20b',
  };
  for (const [k, v] of Object.entries(required)) {
    if (!v || /YOUR_|changeme|xxx|\[YOUR-PASSWORD\]/i.test(v)) {
      throw new Error(`.env missing/invalid: ${k}`);
    }
  }

  console.log('[worker] putting secrets…');
  for (const [k, v] of Object.entries(required)) putSecret(k, v);

  console.log('[worker] deploying…');
  run('npx', ['wrangler', 'deploy']);

  // Discover workers.dev URL from wrangler whoami / deploy output is awkward;
  // try wrangler deployments list or construct from account — ask wrangler for routes.
  const who = spawnSync('npx', ['wrangler', 'deployments', 'list', '--name', 'remote-job-copilot-tg'], {
    cwd: workerDir,
    encoding: 'utf8',
    shell: true,
  });
  console.log(who.stdout || who.stderr || '');

  // Prefer explicit WORKER_URL in env if set
  let workerUrl = (env.WORKER_URL || '').replace(/\/$/, '');
  if (!workerUrl) {
    // Common default; user can override
    workerUrl = 'https://remote-job-copilot-tg.workers.dev';
    console.log(`[worker] WORKER_URL not set; trying ${workerUrl}`);
  }
  const hookUrl = `${workerUrl}/webhook`;

  const setRes = await fetch(
    `https://api.telegram.org/bot${required.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: hookUrl,
        secret_token: required.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      }),
    }
  );
  const setJson = await setRes.json();
  console.log('[telegram] setWebhook', JSON.stringify(setJson));

  const infoRes = await fetch(
    `https://api.telegram.org/bot${required.TELEGRAM_BOT_TOKEN}/getWebhookInfo`
  );
  const info = await infoRes.json();
  console.log('[telegram] getWebhookInfo', JSON.stringify(info.result || info, null, 2));

  if (!setJson.ok) {
    console.log('\nIf URL wrong: set WORKER_URL=https://<your-worker>.<account>.workers.dev in .env and re-run.');
    process.exit(2);
  }
  console.log('\n[worker] done. Ping bot with /status');
}

main().catch((e) => {
  console.error('[worker] FAIL:', e.message);
  process.exit(1);
});
