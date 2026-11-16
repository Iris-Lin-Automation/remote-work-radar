#!/usr/bin/env node
/**
 * run-radar-cycle.js — Remote Work Radar 主循环
 * ────────────────────────────────────────────────────────────────
 * 流程：
 *   1. 读取 data/seen_jobs.json（已处理过的帖子，避免重复推送）
 *   2. 从 config/my-profile.md 自动提取关键词并加载画像摘要
 *   3. 并行抓取所有 RSS 源
 *   4. Layer 1：关键词粗筛（0ms，来自画像 + 自定义关键词）
 *   5. Layer 2：Groq 极速打分（1-2s，仅对通过 Layer 1 的帖子，可选）
 *   6. 命中 → 格式化 + 推送 Telegram（含分数和联系方式）
 *   7. 将本轮全部新帖 dedup_key 写回 data/seen_jobs.json
 *
 * 不改动：
 *   - 现有 n8n 工作流
 *   - score-domestic.js 全量评分系统
 *   - PostgreSQL 数据库
 *   本文件是独立的"快速告警通道"
 *
 * 所需环境变量（.env 或 GitHub Secrets）：
 *   TELEGRAM_BOT_TOKEN     — Bot Token（必填）
 *   TELEGRAM_CHAT_ID       — 你的 chat_id（必填）
 *   GROQ_API_KEY           — Groq 密钥（推荐填，不填则跳过 AI 打分）
 *   RADAR_KEYWORDS         — 额外关键词，逗号分隔（可选）
 *   RADAR_SCORE_THRESHOLD  — Groq 分数阈值，默认 55
 *   TELEGRAM_SEND_HEARTBEAT — true/false，无新帖时发心跳
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const Parser = require('rss-parser');
const {
  formatJobMessage,
  formatDailyDigest,
  formatStatusDigest,
  trackOf,
  sendTelegramMessage,
  sendHeartbeat,
} = require('./notify-telegram');
const { createMatcher } = require('./quick-match');
const { fetchCareerSite } = require('./fetch-career-sites');
const { fetchAllAtsBoards } = require('./fetch-ats-boards');
const db = require('./db');

// ────────────────────────────────────────────────────────────────
// 0. 加载 .env（本地开发用，CI 里用 Secrets）
// ────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const eq = t.indexOf('=');
    if (eq < 0) return;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  });
}

// ────────────────────────────────────────────────────────────────
// 1. 配置
// ────────────────────────────────────────────────────────────────
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID   || '';
const SEND_HEARTBEAT = process.env.TELEGRAM_SEND_HEARTBEAT === 'true';
// 每天（上海时区）最多发一条日报摘要；设 false 可关闭
const SEND_DAILY_DIGEST = process.env.RADAR_DAILY_DIGEST !== 'false';
// 一次性回放：忽略「已见过」，把时间窗内可投岗位再推一遍
const REPLAY = process.env.RADAR_REPLAY === 'true';
// 双轨：both | en | cn —— 默认 both，但英文海外优质团队为主推
const RADAR_TRACK = (process.env.RADAR_TRACK || 'both').toLowerCase();
const PRIMARY_TRACK = (process.env.RADAR_PRIMARY || 'en').toLowerCase();

// 额外关键词（叠加在画像关键词之上，不替换）
const EXTRA_KEYWORDS = (process.env.RADAR_KEYWORDS || '')
  .split(',').map(k => k.trim().toLowerCase()).filter(Boolean);

const STATE_FILE    = path.join(__dirname, '..', 'data', 'seen_jobs.json');
const PUSHED_FILE   = path.join(__dirname, '..', 'data', 'pushed_jobs.json');
const MAX_SEEN      = 2000;
const MAX_PUSHED    = 300;
// 只处理最近 N 小时内发布的帖子（防止首次运行时推送大量旧帖）
const MAX_AGE_HOURS = REPLAY
  ? parseInt(process.env.RADAR_REPLAY_HOURS || '168', 10)
  : parseInt(process.env.RADAR_MAX_AGE_HOURS || '4', 10);

// RSS / JSON 数据源（track 分离：中文 / 英文海外）
// ✅ = 经测试可用   ❌ = 封锁 GitHub Actions IP，已移除
const ALL_SOURCES = [
  // ── 中文轨
  { key: 'v2ex_jobs',       url: 'https://www.v2ex.com/feed/jobs.xml',                         name: 'V2EX·招聘',      track: 'cn' },
  { key: 'eleduck',         url: 'https://eleduck.com/feed/latest.xml',                        name: '电鸭社区',       track: 'cn' },
  { key: 'yw_dev',          url: 'https://yuancheng.work/remote-development-jobs/feed',        name: '远程.work·开发', track: 'cn' },
  { key: 'yw_ops',          url: 'https://yuancheng.work/remote-operation-jobs/feed',          name: '远程.work·运营', track: 'cn' },
  { key: 'yw_mkt',          url: 'https://yuancheng.work/remote-marketing-jobs/feed',          name: '远程.work·市场', track: 'cn' },
  { key: 'yw_prod',         url: 'https://yuancheng.work/remote-product-jobs/feed',            name: '远程.work·产品', track: 'cn' },
  { key: 'yw_sales',        url: 'https://yuancheng.work/remote-sales-jobs/feed',              name: '远程.work·销售', track: 'cn' },
  { key: 'yw_other',        url: 'https://yuancheng.work/remote-other-jobs/feed',              name: '远程.work·其他', track: 'cn' },
  // ── 英文海外轨（主推优质团队源）
  // Himalayas 公开 JSON API：https://himalayas.app/jobs/api （优先 cursor 分页）
  { key: 'himalayas', url: 'https://himalayas.app/jobs/api?limit=50&offset=0', name: 'Himalayas', type: 'json', parser: 'himalayas', track: 'en' },
  // RemoteOK 免费 JSON（RSS 对云端 IP 常 410，改走 /api）
  { key: 'remoteok', url: 'https://remoteok.com/api', name: 'RemoteOK', type: 'json', parser: 'remoteok', track: 'en' },
  { key: 'remotive_ai', url: 'https://remotive.com/api/remote-jobs?limit=30&category=artificial-intelligence', name: 'Remotive·AI', type: 'json', parser: 'remotive', track: 'en' },
  { key: 'remotive_dev', url: 'https://remotive.com/api/remote-jobs?limit=25&category=software-dev', name: 'Remotive·开发', type: 'json', parser: 'remotive', track: 'en' },
  { key: 'jobicy_apac', url: 'https://jobicy.com/api/v2/remote-jobs?count=50&geo=apac', name: 'Jobicy·APAC', type: 'json', parser: 'jobicy', track: 'en' },
  // We Work Remotely 公开分类 RSS
  { key: 'wwr_programming', url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss', name: 'WWR·开发', track: 'en' },
  { key: 'wwr_fullstack', url: 'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss', name: 'WWR·全栈', track: 'en' },
  { key: 'wwr_backend', url: 'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss', name: 'WWR·后端', track: 'en' },
  { key: 'wwr_devops', url: 'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss', name: 'WWR·DevOps', track: 'en' },
  { key: 'wwr_product', url: 'https://weworkremotely.com/categories/remote-product-jobs.rss', name: 'WWR·产品', track: 'en' },
  // 常青 / 官网 HTML
  { key: 'growix', url: 'https://growix.com/careers', name: 'Growix', type: 'html', parser: 'growix', track: 'en' },
  { key: 'opentrain', url: 'https://www.opentrain.ai/jobs/', name: 'OpenTrain', type: 'html', parser: 'opentrain', track: 'en' },
  // Greenhouse / Ashby 企业官方 ATS（Wellfound 无公开 API，改由 ATS 上游覆盖）
  { key: 'ats_boards', url: 'config/ats-boards.json', name: 'ATS·Greenhouse/Ashby', type: 'ats', track: 'en' },
  // ❌ Wellfound 无公开 API（Cloudflare/robots 封锁）
  // ❌ Arbeitnow XML 损坏
];

function activeSources() {
  if (RADAR_TRACK === 'en') return ALL_SOURCES.filter((s) => s.track === 'en');
  if (RADAR_TRACK === 'cn') return ALL_SOURCES.filter((s) => s.track === 'cn');
  return ALL_SOURCES;
}

// ────────────────────────────────────────────────────────────────
// 2. 工具函数
// ────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupKey(source, link, title) {
  const id = (link || title || '').replace(/#reply\d+$/, '').trim();
  return `${source}|${id}`;
}

function shanghaiDate() {
  // en-CA → YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function shanghaiDateLabel() {
  return new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function loadSeenState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return {
        keys: new Set(Array.isArray(raw.keys) ? raw.keys : []),
        lastDigestDate: raw.lastDigestDate || null,
      };
    }
  } catch (e) {
    log(`⚠️  读取 seen_jobs.json 失败（重置）：${e.message}`);
  }
  return { keys: new Set(), lastDigestDate: null };
}

function saveSeenState(seenSet, meta = {}) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const arr     = [...seenSet];
  const trimmed = arr.length > MAX_SEEN ? arr.slice(arr.length - MAX_SEEN) : arr;
  const payload = {
    updatedAt: new Date().toISOString(),
    keys: trimmed,
  };
  if (meta.lastDigestDate) payload.lastDigestDate = meta.lastDigestDate;
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

function loadPushed() {
  try {
    if (fs.existsSync(PUSHED_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PUSHED_FILE, 'utf8'));
      return Array.isArray(raw.jobs) ? raw.jobs : [];
    }
  } catch (e) {
    log(`⚠️  读取 pushed_jobs.json 失败：${e.message}`);
  }
  return [];
}

function savePushed(jobs) {
  const dir = path.dirname(PUSHED_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const trimmed = jobs.length > MAX_PUSHED ? jobs.slice(jobs.length - MAX_PUSHED) : jobs;
  fs.writeFileSync(PUSHED_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    jobs: trimmed,
  }, null, 2), 'utf8');
}

function recordPushed(job) {
  const jobs = loadPushed();
  jobs.push({
    at: new Date().toISOString(),
    title: job.title || '',
    url: job.url || '',
    source: job.sourceName || job.source || '',
    score: job.groqScore ?? null,
  });
  savePushed(jobs);
}

function formatPushIndex(jobs, title) {
  const lines = [`📋 <b>${title}</b>`, `共 ${jobs.length} 条`, ''];
  jobs.forEach((job, i) => {
    const name = String(job.title || '无标题').slice(0, 80);
    const safe = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (job.url) lines.push(`${i + 1}. <a href="${String(job.url).replace(/&/g, '&amp;')}">${safe}</a>`);
    else lines.push(`${i + 1}. ${safe}`);
  });
  return lines.join('\n');
}

/** 每天最多发一条日报；成功后写回 lastDigestDate */
async function maybeSendDailyDigest(stats, lastDigestDate) {
  if (!SEND_DAILY_DIGEST) return lastDigestDate;
  const today = shanghaiDate();
  if (lastDigestDate === today) {
    log(`📅 今日日报已发过（${today}），跳过`);
    return lastDigestDate;
  }
  try {
    const msg = formatDailyDigest({
      ...stats,
      dateLabel: shanghaiDateLabel(),
      maxAgeHours: MAX_AGE_HOURS,
    });
    await sendTelegramMessage(msg, BOT_TOKEN, CHAT_ID);
    log(`📅 已发送 Radar 日报（${today}）`);
    return today;
  } catch (err) {
    log(`⚠️  日报发送失败：${err.message}`);
    return lastDigestDate;
  }
}

// ────────────────────────────────────────────────────────────────
// 3. 抓取 RSS
// ────────────────────────────────────────────────────────────────
const rssParser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'RemoteWorkRadar/1.0' },
  customFields: { item: ['content:encoded', 'description'] },
});

function fetchJson(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'RemoteWorkRadar/1.0',
        'Accept': 'application/json',
      },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

function normalizeRemotiveItem(job, source) {
  const location = job.candidate_required_location || '';
  const content = [
    job.description || '',
    job.tags ? job.tags.join(' ') : '',
    location,
    job.job_type || '',
  ].join(' ');
  return {
    source:      source.key,
    sourceName:  source.name,
    title:       stripHtml(job.title || ''),
    url:         job.url || null,
    content,
    contentText: stripHtml(content),
    publishedAt: job.publication_date || null,
    location,
    dedupKey:    dedupKey('remotive', job.url || job.id, job.title),
  };
}

function normalizeJobicyItem(job, source) {
  const location = job.jobGeo || 'Anywhere';
  const content = [
    job.jobDescription || job.jobExcerpt || '',
    Array.isArray(job.jobIndustry) ? job.jobIndustry.join(' ') : '',
    Array.isArray(job.jobType) ? job.jobType.join(' ') : '',
    location,
  ].join(' ');
  const url = job.url || null;
  return {
    source:      source.key,
    sourceName:  source.name,
    title:       stripHtml(job.jobTitle || ''),
    url,
    content,
    contentText: stripHtml(content),
    publishedAt: job.pubDate || null,
    location,
    dedupKey:    dedupKey('jobicy', url || job.id, job.jobTitle),
  };
}

function normalizeHimalayasItem(job, source) {
  const location = (job.locationRestrictions && job.locationRestrictions.length)
    ? job.locationRestrictions.join(', ')
    : 'Worldwide';
  const content = [
    job.description || job.excerpt || '',
    Array.isArray(job.categories) ? job.categories.join(' ') : '',
    Array.isArray(job.parentCategories) ? job.parentCategories.join(' ') : '',
    location,
    job.employmentType || '',
  ].join(' ');
  const url = job.applicationLink || job.guid || null;
  return {
    source:      source.key,
    sourceName:  source.name,
    title:       stripHtml(job.title || ''),
    url,
    content,
    contentText: stripHtml(content),
    publishedAt: job.pubDate || null,
    location,
    dedupKey:    dedupKey('himalayas', url || job.guid, job.title),
  };
}

/** RemoteOK /api：首条常为 legal 元数据，无 position 则跳过；优先 AI/dev/python 标签 */
function normalizeRemoteOkJobs(data, source) {
  const list = Array.isArray(data) ? data : [];
  const keepTag = /ai|python|dev|engineer|llm|automation|agent|data|machine learning|ml|backend|fullstack|full-stack/i;
  const out = [];
  for (const job of list) {
    if (!job || !job.position) continue;
    const tags = Array.isArray(job.tags) ? job.tags.join(' ') : '';
    const hay = `${job.position} ${tags} ${job.description || ''}`;
    if (!keepTag.test(hay)) continue;
    const url = job.apply_url || job.url || null;
    const content = stripHtml(job.description || '');
    const publishedAt = job.date
      ? new Date(job.date).toISOString()
      : (job.epoch ? new Date(job.epoch * 1000).toISOString() : null);
    out.push({
      source: source.key,
      sourceName: source.name,
      title: stripHtml(job.position || ''),
      url,
      content,
      contentText: content.slice(0, 4000),
      publishedAt,
      location: job.location || 'Remote',
      company: job.company || '',
      dedupKey: dedupKey('remoteok', url || job.id || job.slug, job.position),
    });
  }
  return out;
}

function normalizeJsonJobs(data, source) {
  const parser = source.parser || 'remotive';
  if (parser === 'jobicy') {
    return (data.jobs || []).map(j => normalizeJobicyItem(j, source));
  }
  if (parser === 'himalayas') {
    return (data.jobs || []).map(j => normalizeHimalayasItem(j, source));
  }
  if (parser === 'remoteok') {
    return normalizeRemoteOkJobs(data, source);
  }
  return (data.jobs || []).map(j => normalizeRemotiveItem(j, source));
}

async function fetchSource(source) {
  try {
    log(`📡 抓取 ${source.name} …`);

    if (source.type === 'ats') {
      const jobs = await fetchAllAtsBoards();
      log(`   ✅ ${jobs.length} 条（ATS）`);
      return jobs;
    }

    if (source.type === 'html') {
      const jobs = await fetchCareerSite(source);
      log(`   ✅ ${jobs.length} 条（HTML）`);
      return jobs;
    }

    if (source.type === 'json') {
      const data = await fetchJson(source.url);
      const jobs = normalizeJsonJobs(data, source);
      log(`   ✅ ${jobs.length} 条`);
      return jobs;
    }

    // RSS
    const feed = await rssParser.parseURL(source.url);
    log(`   ✅ ${feed.items.length} 条`);
    return feed.items.map(item => {
      const rawLink    = String(item.link || item.guid || '').replace(/#reply\d+$/, '').trim();
      const rawContent = item['content:encoded'] || item.content || item.contentSnippet || item.description || '';
      return {
        source:      source.key,
        sourceName:  source.name,
        title:       stripHtml(item.title || ''),
        url:         rawLink || null,
        content:     rawContent,
        contentText: stripHtml(rawContent),
        publishedAt: item.isoDate || item.pubDate || null,
        dedupKey:    dedupKey(source.key, rawLink, item.title),
      };
    });
  } catch (err) {
    log(`   ❌ ${source.name} 抓取失败：${err.message}`);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────
// 4. 格式化消息（增加 Groq 打分信息）
// ────────────────────────────────────────────────────────────────
function buildMessage(job) {
  let msg = formatJobMessage(job);

  if (job.recommendation_status) {
    const st = job.recommendation_status === 'apply_now' ? '✅ apply_now'
      : job.recommendation_status === 'verify' ? '🔎 verify' : '⏭ skip';
    msg += `\n📌 <b>建议：</b>${st}`;
  }
  if (job.hard || job.china_eligible) {
    const china = job.hard?.china_eligible || job.china_eligible || '?';
    const mode = job.hard?.work_mode || job.work_mode || '?';
    const vehicle = job.hard?.hire_vehicle || job.hire_vehicle || '?';
    msg += `\n🛡 <b>硬条件：</b>中国可雇=${china} · ${mode} · ${vehicle}`;
  }
  if (job.groqScore != null && !job.groqScoreSkipped) {
    const bar  = '█'.repeat(Math.round(job.groqScore / 10)) + '░'.repeat(10 - Math.round(job.groqScore / 10));
    const line = `\n⚡ <b>六维总分：${job.groqScore}/100</b>  <code>${bar}</code>`;
    const note = job.groqReason ? `  <i>${job.groqReason}</i>` : '';
    msg += line + note;
    const d = job.dims || {};
    if (d.tech != null) {
      msg += `\n📊 tech ${d.tech} · delivery ${d.delivery} · level ${d.level} · workstyle ${d.workstyle} · comp ${d.comp} · trust ${d.trust}`;
    }
  }
  if (job.migration) {
    const migLabel = job.migration === 'direct' ? '直接对口'
      : job.migration === 'near' ? '小跨度可学'
      : job.migration === 'far' ? '跨度偏大' : job.migration;
    msg += `\n🧭 <b>迁移：</b>${migLabel}`;
  }
  if (job.eligLabels && job.eligLabels.length) {
    msg += `\n🌐 <b>地区信号：</b>${job.eligLabels.join(' · ')}`;
  }
  return msg;
}

// ────────────────────────────────────────────────────────────────
// 5. 主流程
// ────────────────────────────────────────────────────────────────
async function main() {
  log(`🚀 Remote Work Radar 扫描开始 · 轨道=${RADAR_TRACK} · 主推=${PRIMARY_TRACK}`);

  if (!BOT_TOKEN || !CHAT_ID) {
    log('❌ 缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，退出。');
    process.exit(1);
  }

  // ── 云端 DB：pooler TCP 优先；不可用时走 Supabase REST（SERVICE_ROLE）
  const userKey = process.env.RADAR_USER_KEY || 'iris';
  const requireDb = process.env.RADAR_REQUIRE_CLOUD_DB === 'true'
    || process.env.CI === 'true'
    || !!process.env.GITHUB_ACTIONS;
  let preferenceContext = '';
  let weightOverrides = {};
  let dbOk = false;
  if (db.getPool()) {
    try {
      const health = await db.healthCheck();
      dbOk = true;
      log(`💾 DB ok (${health.hostHint}, ${health.latencyMs}ms)`);
      preferenceContext = await db.buildScoringPreferenceContext(userKey);
      weightOverrides = await db.getWeightOverrides(userKey);
      if (preferenceContext) log(`📎 已加载偏好/反馈上下文 ${preferenceContext.length} 字`);
    } catch (err) {
      log(`❌ DATABASE_URL 不可用：${err.message}`);
      if (db.restConfig()) {
        try {
          await db.restHealthCheck();
          dbOk = true;
          log('💾 DB ok via Supabase REST (pg failed)');
        } catch (restErr) {
          log(`❌ REST 也不可用：${restErr.message}`);
          if (requireDb) throw restErr;
        }
      } else if (requireDb) {
        throw err;
      } else {
        log('⚠️  继续本轮（仅 Telegram + JSON）；设置 RADAR_REQUIRE_CLOUD_DB=true 可强制失败');
      }
    }
  } else if (db.restConfig()) {
    try {
      await db.restHealthCheck();
      dbOk = true;
      log('💾 DB ok via Supabase REST (no DATABASE_URL pool)');
    } catch (restErr) {
      log(`❌ REST 不可用：${restErr.message}`);
      if (requireDb) throw restErr;
    }
  } else {
    log('❌ 未设置 DATABASE_URL / SUPABASE_* — 无法写入云库');
    if (requireDb) {
      throw new Error('Cloud DB required: set DATABASE_URL (pooler) or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
    }
  }

  // ── 初始化三层匹配器（画像 + 偏好）
  const matcher = createMatcher({
    preferenceSummary: preferenceContext,
    weightOverrides,
  });

  // ── 读取已见状态（JSON 本地 + 可选 DB）
  const seenState = loadSeenState();
  const seenKeys = seenState.keys;
  let lastDigestDate = seenState.lastDigestDate;
  log(`📂 已记录 ${seenKeys.size} 条历史帖子`);

  // ── 按轨道抓取（中英分离）
  const SOURCES = activeSources();
  log(`📡 本轮源：${SOURCES.map((s) => s.name).join(' · ')}`);
  const allItems = (await Promise.all(SOURCES.map(fetchSource))).flat();
  log(`📥 共抓取 ${allItems.length} 条（去重前）`);

  // ── 过滤：未见过 AND 发布时间在 MAX_AGE_HOURS 以内
  const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
  if (REPLAY) log(`🔁 回放模式：忽略已见记录，时间窗 ${MAX_AGE_HOURS} 小时`);

  const newItems = allItems.filter(job => {
    if (!REPLAY && seenKeys.has(job.dedupKey)) return false; // 已见过，跳过
    if (!job.publishedAt) return true;                     // 没有发布时间，宽松放行
    const pubTime = new Date(job.publishedAt).getTime();
    if (isNaN(pubTime)) return true;                       // 时间格式异常，放行
    return pubTime >= cutoff;                              // 只要最近 N 小时内的
  });
  log(`🆕 本轮新帖（${MAX_AGE_HOURS}h 内）：${newItems.length} 条`);

  // ── 把本轮全部新帖 key 加入已见集（不管有没有命中）
  for (const job of newItems) seenKeys.add(job.dedupKey);

  // ── Layer 1：关键词粗筛（画像关键词 + 额外关键词叠加）
  const l1Passed = newItems.map(job => {
    const hits = matcher.layer1(job);
    // 合并额外关键词的命中
    const hay = (job.title + ' ' + job.contentText).toLowerCase();
    const extraHits = EXTRA_KEYWORDS.filter(k => hay.includes(k));
    const allHits   = [...new Set([...hits, ...extraHits])];
    return { ...job, l1Hits: allHits };
  }).filter(job => job.l1Hits.length >= matcher.l1MinHits);

  log(`🔍 Layer 1 通过：${l1Passed.length} 条`);

  const baseStats = {
    scraped: allItems.length,
    newItems: newItems.length,
    l1: l1Passed.length,
    eligible: 0,
    rejectedElig: 0,
    belowThreshold: 0,
    sent: 0,
  };

  // ── Layer 1.5：分轨 eligibility（英文更严：地区锁 + 优质团队）
  const eligible = [];
  let rejectedElig = 0;
  for (const job of l1Passed) {
    const track = trackOf(job);
    const elig = matcher.eligibility(job, track);
    if (elig.rejected) {
      rejectedElig++;
      continue;
    }
    eligible.push({ ...job, track, eligBoost: elig.boost, eligLabels: elig.labels });
  }
  baseStats.eligible = eligible.length;
  baseStats.rejectedElig = rejectedElig;
  log(`🌐 Eligibility 通过：${eligible.length} 条（硬过滤丢弃 ${rejectedElig}）`);

  if (eligible.length === 0) {
    lastDigestDate = await maybeSendDailyDigest(baseStats, lastDigestDate);
    saveSeenState(seenKeys, { lastDigestDate });
    if (SEND_HEARTBEAT) {
      await sendHeartbeat(BOT_TOKEN, CHAT_ID, allItems.length);
      log('💤 无命中，已发送心跳');
    }
    log(`✅ 扫描完成，推送 0 条，总扫描 ${allItems.length} 条`);
    return;
  }

  // ── Layer 2：Groq 六维打分 + cache；失败 → score_status=error（不给假分）
  const scored = [];
  let scoredOk = 0;
  let scoredError = 0;
  for (const job of eligible) {
    const bucket = db.sourceBucketOf(job);
    const jd = String(job.contentText || '').slice(0, 2800);
    const hash = db.jdHashOf(jd);
    let cachedScore = null;
    if (dbOk) {
      try {
        cachedScore = await db.getCachedScore({
          dedupKey: job.dedupKey,
          jdHash: hash,
          profileVersion: process.env.RADAR_PROFILE_VERSION || 'v1',
          promptVersion: process.env.RADAR_PROMPT_VERSION || 'v1',
        });
      } catch (e) {
        log(`   ⚠️  score cache read: ${e.message}`);
      }
    }

    const result = await matcher.layer2(job, {
      eligBoost: job.eligBoost,
      eligRejected: false,
      source_bucket: bucket,
      cachedScore: cachedScore
        ? {
          dims: cachedScore.dims,
          total_score: cachedScore.total_score,
          reason: cachedScore.reason,
          migration: cachedScore.migration,
        }
        : null,
    });
    const {
      score, reason, skipped, migration, dims, hard, recommendation_status,
      score_status, score_error, prompt_version, profile_version, model, raw,
    } = result;

    if (score_status === 'ok' && dbOk && !cachedScore) {
      try {
        await db.saveScoreCache({
          job_dedup_key: job.dedupKey,
          jd_hash: hash,
          profile_version: profile_version || 'v1',
          prompt_version: prompt_version || 'v1',
          model: model || process.env.GROQ_MODEL,
          dims,
          total_score: score,
          reason,
          migration,
          score_status: 'ok',
          raw_response: raw || null,
        });
      } catch (e) {
        log(`   ⚠️  score cache write: ${e.message}`);
      }
    }
    if (score_status === 'ok' || score_status === 'cached') scoredOk++;
    if (score_status === 'error') scoredError++;

    scored.push({
      ...job,
      groqScore:              score,
      groqReason:             reason,
      groqScoreSkipped:       skipped,
      migration:              migration || '',
      dims:                   dims || {},
      hard:                   { ...(hard || {}), source_bucket: bucket },
      recommendation_status:  recommendation_status || 'skip',
      score_status:           score_status || 'pending',
      score_error:            score_error || null,
      jd_hash:                hash,
      profile_version:        profile_version,
      prompt_version:         prompt_version,
      source_bucket:          bucket,
      hitKeywords:            job.l1Hits,
      china_eligible:         hard?.china_eligible,
      work_mode:              hard?.work_mode,
      hire_vehicle:           hard?.hire_vehicle,
      evidence_snippets:      hard?.china_eligibility_reason
        ? [hard.china_eligibility_reason]
        : [],
    });
    const scoreLabel = score == null ? '—' : `${score}分`;
    log(`   🤖 [${job.track}/${bucket}] ${job.title.slice(0, 36)} → ${scoreLabel} ${recommendation_status} [${score_status}] ${reason || ''}`);
  }

  // ── Postgres 双写；seen_jobs.json 仍始终写
  let upserted = 0;
  if (dbOk) {
    for (const job of scored) {
      const row = await db.upsertRadarJob(job, { hard: false });
      if (row) upserted++;
    }
    log(`💾 Postgres upsert ${upserted}/${scored.length} 条`);
  }

  // 推送：apply_now + verify（含 score_error 的 verify）；skip 不推
  // apply_now 仅 china_eligible=true 且 score ok（matcher 已保证）
  const toNotify = scored
    .filter((j) => j.recommendation_status === 'apply_now' || j.recommendation_status === 'verify')
    .sort((a, b) => {
      const rank = { apply_now: 0, verify: 1 };
      const ra = rank[a.recommendation_status] ?? 9;
      const rb = rank[b.recommendation_status] ?? 9;
      if (ra !== rb) return ra - rb;
      if (PRIMARY_TRACK === 'en' && a.track !== b.track) {
        return a.track === 'en' ? -1 : 1;
      }
      return (b.groqScore ?? 0) - (a.groqScore ?? 0);
    });
  baseStats.belowThreshold = scored.filter((j) => j.recommendation_status === 'skip').length;
  baseStats.applyNow = toNotify.filter((j) => j.recommendation_status === 'apply_now').length;
  baseStats.verify = toNotify.filter((j) => j.recommendation_status === 'verify').length;
  baseStats.scored_ok = scoredOk;
  baseStats.scored_error = scoredError;
  log(`🎯 推荐：apply_now ${baseStats.applyNow} · verify ${baseStats.verify} · skip ${baseStats.belowThreshold} · LLM ok ${scoredOk} err ${scoredError}`);

  let sentCount = 0;

  // 0 条也推说明
  if (toNotify.length === 0) {
    const top = [...scored]
      .sort((a, b) => (b.groqScore ?? 0) - (a.groqScore ?? 0))
      .slice(0, 5)
      .map((j, i) => `${i + 1}. ${j.groqScore ?? '?'}分 [${j.recommendation_status}/${j.track}] ${(j.title || '').slice(0, 48)}`)
      .join('\n');
    const zeroMsg = [
      '📡 <b>Radar 本轮无 apply_now / verify</b>',
      `轨道 ${RADAR_TRACK} · 扫描 ${allItems.length} · L1 ${l1Passed.length} · 可评 ${eligible.length}`,
      `skip ${baseStats.belowThreshold}（含中国不可雇 / 低分 / onsite）`,
      '',
      top ? `<b>最高分预览（未推）：</b>\n${top}` : '本轮没有可打分岗位。',
      '',
      '<i>系统在跑；Worldwide≠可雇，未确认中国可受雇不会进 apply_now。</i>',
    ].join('\n');
    try {
      await sendTelegramMessage(zeroMsg, BOT_TOKEN, CHAT_ID);
      log('📋 已推送「本轮 0 条」说明到 Telegram');
    } catch (err) {
      log(`   ⚠️  0 条说明推送失败：${err.message}`);
    }
  }

  // ── 按 recommendation_status 推送（先 apply_now，再 verify）；轨内再分
  for (const status of ['apply_now', 'verify']) {
    const statusJobs = toNotify.filter((j) => j.recommendation_status === status);
    if (!statusJobs.length) continue;

    const pushOrder = PRIMARY_TRACK === 'cn' ? ['cn', 'en', 'all'] : ['en', 'cn', 'all'];
    const byTrack = { cn: [], en: [] };
    for (const job of statusJobs) {
      byTrack[job.track === 'cn' ? 'cn' : 'en'].push(job);
    }

    for (const track of pushOrder) {
      if (track === 'all') continue;
      const list = byTrack[track];
      if (!list.length) continue;
      try {
        const digest = formatStatusDigest(status, list, { track, replay: REPLAY });
        await sendTelegramMessage(digest, BOT_TOKEN, CHAT_ID);
        log(`📋 已推送 ${status}/${track} 摘要 ${list.length} 条`);
        await new Promise((r) => setTimeout(r, 1200));
      } catch (err) {
        log(`   ⚠️  ${status}/${track} 摘要失败：${err.message}`);
      }
    }
  }

  // 详情：仅 apply_now 且高分
  const EN_DETAIL = parseInt(process.env.RADAR_EN_DETAIL_SCORE || '70', 10);
  const CN_DETAIL = parseInt(process.env.RADAR_CN_DETAIL_SCORE || '75', 10);
  const detailJobs = toNotify.filter((j) =>
    j.recommendation_status === 'apply_now' &&
    (j.groqScore ?? 0) >= (j.track === 'cn' ? CN_DETAIL : EN_DETAIL)
  );
  for (const job of detailJobs) {
    try {
      await sendTelegramMessage(buildMessage(job), BOT_TOKEN, CHAT_ID);
      log(`   📨 [${job.track}] apply_now 详情：${job.title.slice(0, 55)}`);
      await new Promise((r) => setTimeout(r, 1200));
    } catch (err) {
      log(`   ⚠️  详情推送失败：${err.message}`);
    }
  }

  for (const job of toNotify) {
    recordPushed(job);
    sentCount++;
  }

  baseStats.sent = sentCount;
  lastDigestDate = await maybeSendDailyDigest(baseStats, lastDigestDate);

  if (dbOk) {
    try {
      await db.recordRadarRun(baseStats);
    } catch (e) {
      log(`⚠️  radar_runs 写入失败：${e.message}`);
    }
  }

  // ── 保存状态（JSON 始终写；与 DB 双写）
  saveSeenState(seenKeys, { lastDigestDate });
  log(`💾 状态已保存（共记录 ${seenKeys.size} 条）`);
  log(`✅ 本轮完成：推送 ${sentCount} 条 / Layer1 ${l1Passed.length} 条 / 总扫描 ${allItems.length} 条`);
  await db.closePool();
}

main().catch(async (err) => {
  console.error('💥 致命错误：', err);
  await db.closePool().catch(() => {});
  process.exit(1);
});
