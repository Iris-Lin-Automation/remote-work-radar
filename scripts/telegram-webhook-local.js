/**
 * Local Express stand-in for the Cloudflare Worker (dev / no Wrangler).
 * Uses scripts/db.js (DATABASE_URL) instead of Supabase REST.
 *
 *   node scripts/telegram-webhook-local.js
 *   # then setWebhook to https://<tunnel>/webhook
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const eq = t.indexOf('=');
    if (eq < 0) return;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  });
}

const PORT = parseInt(process.env.WEBHOOK_PORT || '8787', 10);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED_CHAT = String(process.env.TELEGRAM_CHAT_ID || '');
const USER_KEY = process.env.RADAR_USER_KEY || 'iris';

function tgSend(chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text: String(text).slice(0, 4000),
      disable_web_page_preview: true,
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function handleText(chatId, text) {
  await db.saveConversation({ userKey: USER_KEY, chatId, role: 'user', content: text });

  let reply;
  if (/^\/?help$/i.test(text) || text === '帮助') {
    reply = '本地 webhook：/apply /verify /prefs · 反馈：… · /confirm <uuid> · 自然语言偏好';
  } else if (/^\/?prefs$/i.test(text) || text === '偏好') {
    reply = (await db.getPreferenceSummary(USER_KEY)) || '暂无偏好';
  } else if (/^(apply_now|\/apply|立刻投)/i.test(text)) {
    const rows = await db.listJobsByStatus({ status: 'apply_now', limit: 10 });
    reply = rows.length
      ? rows.map((r, i) => `${i + 1}. ${r.match_score} ${r.title}\n${r.apply_url}`).join('\n\n')
      : '没有 apply_now';
  } else if (/^(verify|\/verify|核实)/i.test(text)) {
    const rows = await db.listJobsByStatus({ status: 'verify', limit: 10 });
    reply = rows.length
      ? rows.map((r, i) => `${i + 1}. ${r.match_score} ${r.title}\n${r.apply_url}`).join('\n\n')
      : '没有 verify';
  } else if (/^\/?confirm\s+([0-9a-f-]{36})$/i.test(text)) {
    const id = text.match(/([0-9a-f-]{36})/i)[1];
    const res = await db.confirmPreferenceSignal(id, USER_KEY);
    reply = res.ok ? `已确认 ${id}` : `失败：${res.error}`;
  } else if (/^反馈[:：]/.test(text)) {
    await db.insertApplicationFeedback({
      userKey: USER_KEY,
      notes: text.replace(/^反馈[:：]\s*/, '').slice(0, 2000),
      outcome: 'other',
    });
    reply = '已记录反馈';
  } else if (/我(更)?(喜欢|希望|不要)/.test(text)) {
    const row = await db.insertPreferenceSignal({
      userKey: USER_KEY,
      signalType: 'chat_preference',
      signalValue: { preference_summary_append: text.slice(0, 240) },
      rawText: text,
      status: 'pending',
    });
    reply = `已提议偏好。确认：/confirm ${row?.id || '?'}`;
  } else {
    const job = await db.explainJob(text);
    reply = job
      ? `${job.title}\n${job.recommendation_status} ${job.match_score}\n${job.score_reason || ''}\n${job.apply_url}`
      : '未识别指令。发 /help';
  }

  await tgSend(chatId, reply);
  await db.saveConversation({ userKey: USER_KEY, chatId, role: 'assistant', content: reply });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'telegram-webhook-local' }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));

  try {
    const update = JSON.parse(body);
    const msg = update.message;
    if (!msg?.text) return;
    const chatId = String(msg.chat.id);
    if (ALLOWED_CHAT && chatId !== ALLOWED_CHAT) {
      await tgSend(chatId, '未授权');
      return;
    }
    await handleText(chatId, String(msg.text).trim());
  } catch (err) {
    console.error(err);
  }
});

server.listen(PORT, () => {
  console.log(`[webhook-local] http://127.0.0.1:${PORT}  db=${db.getPool() ? 'on' : 'off'}`);
});
