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
  // ── 海外英文源（仅保留稳定可用的）
  { key: 'jobicy',         url: 'https://jobicy.com/?feed=job_feed',        name: 'Jobicy'     },  // ✅ 200条
  { key: 'wwr_support',   url: 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss', name: 'WWR·客服' }, // ✅
  { key: 'remotive',       url: 'https://remotive.com/api/remote-jobs?limit=50', name: 'Remotive', type: 'json' }, // ✅ JSON API
  // ❌ RemoteOK       → 410 封锁云端 IP
  // ❌ WeWorkRemotely → 403 封锁云端 IP
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

function loadSeenKeys() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return new Set(Array.isArray(raw.keys) ? raw.keys : []);
    }
  } catch (e) {
    log(`⚠️  读取 seen_jobs.json 失败（重置）：${e.message}`);
  }
  return new Set();
}

function saveSeenKeys(seenSet) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const arr     = [...seenSet];
  const trimmed = arr.length > MAX_SEEN ? arr.slice(arr.length - MAX_SEEN) : arr;
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), keys: trimmed }, null, 2),
    'utf8'
  );
}

// ────────────────────────────────────────────────────────────────
// 3. 抓取 RSS
// ────────────────────────────────────────────────────────────────
const rssParser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'RemoteWorkRadar/1.0' },
  customFields: { item: ['content:encoded', 'description'] },
});

// Remotive JSON API 的格式转换
function normalizeRemotiveItem(job, sourceKey) {
  const content = [job.description || '', job.tags ? job.tags.join(' ') : ''].join(' ');
  return {
    source:      sourceKey,
    sourceName:  'Remotive',
    title:       stripHtml(job.title || ''),
    url:         job.url || null,
    content,
    contentText: stripHtml(content),
    publishedAt: job.publication_date || null,
    dedupKey:    dedupKey(sourceKey, job.url, job.title),
  };
}

async function fetchSource(source) {
  try {
    log(`📡 抓取 ${source.name} …`);

    // JSON API（目前只有 Remotive）
    if (source.type === 'json') {
      const https = require('https');
      const data = await new Promise((resolve, reject) => {
        const req = https.get(source.url, { headers: { 'User-Agent': 'RemoteWorkRadar/1.0' } }, res => {
          let raw = '';
          res.on('data', c => { raw += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
      });
      const jobs = (data.jobs || []).map(j => normalizeRemotiveItem(j, source.key));
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
  const seenKeys = loadSeenKeys();
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

  if (l1Passed.length === 0) {
    saveSeenKeys(seenKeys);
    if (SEND_HEARTBEAT) {
      await sendHeartbeat(BOT_TOKEN, CHAT_ID, allItems.length);
      log('💤 无命中，已发送心跳');
    }
    log(`✅ 扫描完成，推送 0 条，总扫描 ${allItems.length} 条`);
    return;
  }

  // ── Layer 2：Groq 极速打分（串行，每条约 1 秒，避免并发触发限流）
  const scored = [];
  for (const job of l1Passed) {
    const { score, reason, skipped } = await matcher.layer2(job);
    scored.push({
      ...job,
      groqScore:       score,
      groqReason:      reason,
      groqScoreSkipped: skipped,
      hitKeywords:     job.l1Hits,
    });
    if (!skipped) {
      log(`   🤖 ${job.title.slice(0, 45)} → ${score}分 (${reason})`);
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

  // ── 保存状态
  saveSeenKeys(seenKeys);
  log(`💾 状态已保存（共记录 ${seenKeys.size} 条）`);
  log(`✅ 本轮完成：推送 ${sentCount} 条 / Layer1 ${l1Passed.length} 条 / 总扫描 ${allItems.length} 条`);
}

main().catch(err => {
  console.error('💥 致命错误：', err);
  process.exit(1);
});
