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
  sendTelegramMessage,
  sendHeartbeat,
} = require('./notify-telegram');
const { createMatcher } = require('./quick-match');

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

// 额外关键词（叠加在画像关键词之上，不替换）
const EXTRA_KEYWORDS = (process.env.RADAR_KEYWORDS || '')
  .split(',').map(k => k.trim().toLowerCase()).filter(Boolean);

const STATE_FILE    = path.join(__dirname, '..', 'data', 'seen_jobs.json');
const MAX_SEEN      = 2000;
// 只处理最近 N 小时内发布的帖子（防止首次运行时推送大量旧帖）
const MAX_AGE_HOURS = parseInt(process.env.RADAR_MAX_AGE_HOURS || '4', 10);

// RSS / JSON 数据源
// ✅ = 经测试可用   ❌ = 封锁 GitHub Actions IP，已移除
const SOURCES = [
  // ── 国内中文源
  { key: 'v2ex_jobs',       url: 'https://www.v2ex.com/feed/jobs.xml',                         name: 'V2EX·招聘'      },  // ✅
  { key: 'eleduck',         url: 'https://eleduck.com/feed/latest.xml',                        name: '电鸭社区'       },  // ✅
  // ── 远程.work（按分类订阅，/feed 超时 /overseas/feed 是评论空 feed）
  { key: 'yw_dev',          url: 'https://yuancheng.work/remote-development-jobs/feed',        name: '远程.work·开发' },  // ✅
  { key: 'yw_ops',          url: 'https://yuancheng.work/remote-operation-jobs/feed',          name: '远程.work·运营' },  // ✅
  { key: 'yw_mkt',          url: 'https://yuancheng.work/remote-marketing-jobs/feed',          name: '远程.work·市场' },  // ✅
  { key: 'yw_prod',         url: 'https://yuancheng.work/remote-product-jobs/feed',            name: '远程.work·产品' },  // ✅
  { key: 'yw_sales',        url: 'https://yuancheng.work/remote-sales-jobs/feed',              name: '远程.work·销售' },  // ✅
  { key: 'yw_other',        url: 'https://yuancheng.work/remote-other-jobs/feed',              name: '远程.work·其他' },  // ✅
  // ── 海外英文源（垂直：APAC / 技能分类，噪音低于全站聚合）
  { key: 'jobicy_apac',    url: 'https://jobicy.com/api/v2/remote-jobs?count=50&geo=apac', name: 'Jobicy·APAC', type: 'json', parser: 'jobicy' }, // ✅
  { key: 'himalayas',      url: 'https://himalayas.app/jobs/api?limit=50&offset=0',        name: 'Himalayas',   type: 'json', parser: 'himalayas' }, // ✅
  { key: 'remotive_dev',   url: 'https://remotive.com/api/remote-jobs?limit=30&category=software-dev', name: 'Remotive·开发', type: 'json', parser: 'remotive' }, // ✅
  { key: 'remotive_prod',  url: 'https://remotive.com/api/remote-jobs?limit=20&category=product',      name: 'Remotive·产品', type: 'json', parser: 'remotive' }, // ✅
  { key: 'wwr_programming', url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss', name: 'WWR·开发' }, // ⚠️ Actions 偶发 403
  { key: 'wwr_product',     url: 'https://weworkremotely.com/categories/remote-product-jobs.rss',     name: 'WWR·产品' }, // ⚠️ Actions 偶发 403
  // ❌ RemoteOK       → 410 封锁云端 IP
  // ❌ WWR 全站       → 403 封锁云端 IP（分类 RSS 有时可用）
  // ❌ Arbeitnow      → XML 格式损坏
];

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

function normalizeJsonJobs(data, source) {
  const parser = source.parser || 'remotive';
  if (parser === 'jobicy') {
    return (data.jobs || []).map(j => normalizeJobicyItem(j, source));
  }
  if (parser === 'himalayas') {
    return (data.jobs || []).map(j => normalizeHimalayasItem(j, source));
  }
  return (data.jobs || []).map(j => normalizeRemotiveItem(j, source));
}

async function fetchSource(source) {
  try {
    log(`📡 抓取 ${source.name} …`);

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
  // 基础消息由 notify-telegram.js 生成
  let msg = formatJobMessage(job);

  // 在底部追加 AI 打分行（如果有）
  if (job.groqScore != null && !job.groqScoreSkipped) {
    const bar  = '█'.repeat(Math.round(job.groqScore / 10)) + '░'.repeat(10 - Math.round(job.groqScore / 10));
    const line = `\n⚡ <b>AI 快速评分：${job.groqScore}/100</b>  <code>${bar}</code>`;
    const note = job.groqReason ? `  <i>${job.groqReason}</i>` : '';
    msg += line + note;
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
  log('🚀 Remote Work Radar 扫描开始');

  if (!BOT_TOKEN || !CHAT_ID) {
    log('❌ 缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，退出。');
    process.exit(1);
  }

  // ── 初始化两层匹配器（读画像文件，一次性）
  const matcher = createMatcher();

  // ── 读取已见状态
  const seenState = loadSeenState();
  const seenKeys = seenState.keys;
  let lastDigestDate = seenState.lastDigestDate;
  log(`📂 已记录 ${seenKeys.size} 条历史帖子`);

  // ── 并行抓取所有源
  const allItems = (await Promise.all(SOURCES.map(fetchSource))).flat();
  log(`📥 共抓取 ${allItems.length} 条（去重前）`);

  // ── 过滤：未见过 AND 发布时间在 MAX_AGE_HOURS 以内
  const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
  const newItems = allItems.filter(job => {
    if (seenKeys.has(job.dedupKey)) return false;          // 已见过，跳过
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
    sent: 0,
  };

  // ── Layer 1.5：英文 eligibility 硬过滤（签证/地区硬门槛）
  const eligible = [];
  let rejectedElig = 0;
  for (const job of l1Passed) {
    const elig = matcher.eligibility(job);
    if (elig.rejected) {
      rejectedElig++;
      continue;
    }
    eligible.push({ ...job, eligBoost: elig.boost, eligLabels: elig.labels });
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

  // ── Layer 2：Groq 极速打分（串行，每条约 1 秒，避免并发触发限流）
  const scored = [];
  for (const job of eligible) {
    const { score, reason, skipped } = await matcher.layer2(job);
    const adjusted = skipped
      ? score
      : Math.max(0, Math.min(100, score + (job.eligBoost || 0)));
    scored.push({
      ...job,
      groqScore:       adjusted,
      groqReason:      reason,
      groqScoreSkipped: skipped,
      hitKeywords:     job.l1Hits,
    });
    if (!skipped) {
      const boostNote = job.eligBoost ? ` boost${job.eligBoost > 0 ? '+' : ''}${job.eligBoost}` : '';
      log(`   🤖 ${job.title.slice(0, 45)} → ${adjusted}分 (${reason}${boostNote})`);
    }
  }

  const toNotify = scored.filter(job => job.groqScore >= matcher.threshold);
  log(`🎯 Layer 2 通过（≥${matcher.threshold}分）：${toNotify.length} 条`);

  // ── 推送到 Telegram
  let sentCount = 0;
  for (const job of toNotify) {
    try {
      const msg = buildMessage(job);
      await sendTelegramMessage(msg, BOT_TOKEN, CHAT_ID);
      sentCount++;
      log(`   📨 已推送（${job.groqScore}分）：${job.title.slice(0, 55)}`);
      await new Promise(r => setTimeout(r, 1200));  // Telegram 限速保险
    } catch (err) {
      log(`   ⚠️  推送失败：${err.message}`);
    }
  }

  baseStats.sent = sentCount;
  lastDigestDate = await maybeSendDailyDigest(baseStats, lastDigestDate);

  // ── 保存状态
  saveSeenState(seenKeys, { lastDigestDate });
  log(`💾 状态已保存（共记录 ${seenKeys.size} 条）`);
  log(`✅ 本轮完成：推送 ${sentCount} 条 / Layer1 ${l1Passed.length} 条 / 总扫描 ${allItems.length} 条`);
}

main().catch(err => {
  console.error('💥 致命错误：', err);
  process.exit(1);
});
