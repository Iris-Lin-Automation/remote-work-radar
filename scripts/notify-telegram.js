/**
 * Telegram 推送模块
 * ─────────────────────────────────────────────────────────────
 * 功能：
 *   1. extractContacts(text)       — 正则提取邮箱 / 微信 / Google Form / Tg 账号
 *   2. formatJobMessage(job)       — 格式化 Telegram HTML 消息
 *   3. sendTelegramMessage(html)   — 调用官方 Bot API sendMessage
 *
 * 依赖：Node.js 内置 https（零额外安装）
 * 使用官方 Bot API，不走任何中间件，国内无法直连时推荐 GitHub Actions（机房在海外）
 */

'use strict';

const https = require('https');

// ────────────────────────────────────────────────────────────
// 1. 联系方式提取
// ────────────────────────────────────────────────────────────

/**
 * 从帖子正文中提取常见的联系方式。
 * 返回 { emails, wechats, forms, tgHandles }，每项都是去重后的数组。
 */
function extractContacts(text) {
  if (!text) return { emails: [], wechats: [], forms: [], tgHandles: [] };

  const clean = String(text)
    .replace(/<[^>]+>/g, ' ')   // 去 HTML 标签
    .replace(/\s+/g, ' ');

  // 邮箱 —— 宽松匹配，覆盖 Gmail / 163 / 企业邮箱等
  const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

  // 微信号 —— 中文帖子常见写法：微信：xxx / wx: xxx / WeChat: xxx / 加微信 xxx
  const wechatRe =
    /(?:微信|wechat|wx)[号\s：:\-]*([a-zA-Z0-9_\-]{5,30})/gi;

  // Google Form / 腾讯问卷 / WJX / 其他表单链接
  const formRe =
    /https?:\/\/(?:docs\.google\.com\/forms|forms\.gle|wj\.qq\.com|wjx\.cn|jinshuju\.net|shimo\.im)[^\s"'<>)]+/gi;

  // Telegram 用户名 / 频道（@handle 或 t.me/xxx）
  const tgRe =
    /(?:https?:\/\/t\.me\/|@)([a-zA-Z][a-zA-Z0-9_]{3,31})/gi;

  const emails = [...new Set([...(clean.match(emailRe) || [])])];

  const wechats = [];
  let m;
  const wechatPattern = new RegExp(wechatRe.source, 'gi');
  while ((m = wechatPattern.exec(clean)) !== null) {
    if (m[1]) wechats.push(m[1]);
  }

  const forms = [...new Set([...(clean.match(formRe) || [])])];

  const tgHandles = [];
  const tgPattern = new RegExp(tgRe.source, 'gi');
  while ((m = tgPattern.exec(clean)) !== null) {
    if (m[1]) tgHandles.push(m[1]);
  }

  return {
    emails:    [...new Set(emails)],
    wechats:   [...new Set(wechats)],
    forms:     [...new Set(forms)],
    tgHandles: [...new Set(tgHandles)],
  };
}

/**
 * 从「公司名招聘…」标题里抽出公司名。
 * 远程.work 公开 RSS 标题几乎都是这个格式，例如：
 *   Canonical招聘全职远程工作云工程经理
 *   重庆汉联汽车销售有限公司招聘全职远程工作HR
 */
function extractCompany(title) {
  const t = String(title || '').trim();
  const m = t.match(/^(.+?)招聘/);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').trim();
  if (!name || name.length > 40) return null;
  return name;
}

// ────────────────────────────────────────────────────────────
// 2. 消息格式化
// ────────────────────────────────────────────────────────────

/** 把特殊字符转义为 Telegram HTML 安全字符 */
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const SOURCE_LABELS = {
  v2ex_jobs:           'V2EX·招聘',
  v2ex_outsourcing:    'V2EX·外包',
  eleduck:             '电鸭社区',
  yuancheng_work:      '远程.work',
  yuancheng_overseas:  '远程.work·海外',
  yw_dev:              '远程.work·开发',
  yw_ops:              '远程.work·运营',
  yw_mkt:              '远程.work·市场',
  yw_prod:             '远程.work·产品',
  yw_sales:            '远程.work·销售',
  yw_other:            '远程.work·其他',
  jobicy_apac:         'Jobicy·APAC',
  himalayas:           'Himalayas',
  remotive_dev:        'Remotive·开发',
  remotive_ai:         'Remotive·AI',
  remotive_prod:       'Remotive·产品',
  wwr_programming:     'WWR·开发',
  wwr_product:         'WWR·产品',
};

const CN_SOURCES = new Set([
  'v2ex_jobs', 'v2ex_outsourcing', 'eleduck',
  'yuancheng_work', 'yuancheng_overseas',
  'yw_dev', 'yw_ops', 'yw_mkt', 'yw_prod', 'yw_sales', 'yw_other',
]);

function trackOf(job) {
  return CN_SOURCES.has(job.source) ? 'cn' : 'en';
}

function sourceLabelOf(job) {
  return SOURCE_LABELS[job.source] || job.sourceName || job.source || '未知源';
}

/**
 * @param {object} job
 *   job.source         — 来源 key
 *   job.title          — 帖子标题
 *   job.url            — 原帖链接
 *   job.content        — 正文（可含 HTML）
 *   job.hitKeywords    — 命中的关键词数组
 *   job.publishedAt    — 发布时间字符串（可选）
 */
function formatJobMessage(job) {
  const sourceLabel = SOURCE_LABELS[job.source] || escHtml(job.source);
  const contacts = extractContacts(job.content);

  const lines = [];

  // ── 标题行
  lines.push(`🎯 <b>新远程岗位</b> | ${sourceLabel}`);
  lines.push('');

  // ── 岗位信息
  lines.push(`<b>标题：</b>${escHtml(job.title)}`);
  const company = job.company || extractCompany(job.title);
  if (company) {
    const q = encodeURIComponent(`${company} careers remote`);
    lines.push(`<b>公司：</b>${escHtml(company)}  ·  <a href="https://www.google.com/search?q=${q}">搜官网/招聘页</a>`);
  }
  if (job.publishedAt) {
    // 只显示日期 + 时间，不显示毫秒
    const dt = new Date(job.publishedAt);
    if (!isNaN(dt)) {
      lines.push(`<b>发布：</b>${dt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    }
  }
  lines.push('');

  // ── 命中关键词
  if (job.hitKeywords && job.hitKeywords.length > 0) {
    lines.push(`🏷 <b>命中关键词：</b>${job.hitKeywords.map(escHtml).join(' / ')}`);
    lines.push('');
  }

  // ── 联系方式
  const hasContacts =
    contacts.emails.length ||
    contacts.wechats.length ||
    contacts.forms.length ||
    contacts.tgHandles.length;

  if (hasContacts) {
    lines.push('📬 <b>联系方式：</b>');
    contacts.emails.forEach(e =>
      lines.push(`  📧 ${escHtml(e)}`)
    );
    contacts.wechats.forEach(w =>
      lines.push(`  💬 微信：${escHtml(w)}`)
    );
    contacts.tgHandles.forEach(t =>
      lines.push(`  ✈️ Telegram：@${escHtml(t)}`)
    );
    contacts.forms.forEach(f =>
      lines.push(`  📋 <a href="${escHtml(f)}">投递表单</a>`)
    );
    lines.push('');
  } else if (String(job.source || '').startsWith('yw_') || job.source === 'yuancheng_work') {
    lines.push('📬 <i>RSS 里没有邮箱/微信。会员岗通常锁申请入口，可用上面公司名搜 Greenhouse / Lever / 官网直接投。</i>');
    lines.push('');
  } else {
    lines.push('📬 <i>未检测到公开联系方式，请点击原帖查看</i>');
    lines.push('');
  }

  // ── 原帖按钮（用内联链接代替按钮，更通用）
  if (job.url) {
    lines.push(`🔗 <a href="${escHtml(job.url)}">查看原帖 →</a>`);
  }

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────
// 3. 发送 Telegram 消息
// ────────────────────────────────────────────────────────────

/**
 * 调用官方 Bot API。
 * 使用 parse_mode=HTML；消息 > 4096 字符时自动截断。
 *
 * @param {string} htmlText   - 格式化好的 HTML 消息
 * @param {string} botToken   - Telegram Bot Token（从 BotFather 获取）
 * @param {string} chatId     - 你自己的 Telegram chat_id
 * @returns {Promise<object>} - API 响应体
 */
function sendTelegramMessage(htmlText, botToken, chatId) {
  return new Promise((resolve, reject) => {
    // Telegram 单条消息上限 4096 字符
    const text = htmlText.length > 4000
      ? htmlText.slice(0, 3990) + '\n…<i>（内容过长已截断）</i>'
      : htmlText;

    const body = JSON.stringify({
      chat_id:    chatId,
      text:       text,
      parse_mode: 'HTML',
      // 关闭链接预览，避免刷屏
      link_preview_options: { is_disabled: true },
    });

    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${botToken}/sendMessage`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            reject(new Error(`Telegram API error: ${parsed.description}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Telegram response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Telegram request timed out after 10s'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * 发送一条「无新岗位」的心跳消息（可选，用来确认 Actions 在跑）。
 * 只在 TELEGRAM_SEND_HEARTBEAT=true 时才发。
 */
async function sendHeartbeat(botToken, chatId, checkedCount) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const msg = `💤 <i>Remote Radar 心跳 | ${now}\n共扫描 ${checkedCount} 条，本次无新命中岗位。</i>`;
  return sendTelegramMessage(msg, botToken, chatId);
}

/**
 * 每日摘要（报平安）：有岗仍单独推，这条只说明系统在跑 + 漏斗数字。
 * @param {object} stats
 *   dateLabel, scraped, newItems, l1, eligible, rejectedElig, sent, maxAgeHours
 */
function formatDailyDigest(stats) {
  const s = stats || {};
  const lines = [
    `📡 <b>Radar 日报</b> · ${escHtml(s.dateLabel || '')}`,
    '系统正常，定时扫描在跑。',
    '',
    `📥 抓取 <b>${s.scraped ?? 0}</b> 条`,
    `🆕 ${s.maxAgeHours ?? 24}h 新帖 <b>${s.newItems ?? 0}</b> 条`,
    `🔍 Layer1 <b>${s.l1 ?? 0}</b> → ✅ 过阈值 <b>${s.sent ?? 0}</b> 条（签证踢 ${s.rejectedElig ?? 0}，低分踢 ${s.belowThreshold ?? 0}）`,
    '',
  ];
  if ((s.sent ?? 0) > 0) {
    lines.push(`本轮已按中英/平台汇总推送 ${s.sent} 条。`);
  } else {
    lines.push('本轮没有过阈值的新帖。有岗会按分组推，这条只是报平安。');
  }
  return lines.join('\n');
}

/**
 * 按中文/英文轨道 + 平台分组的岗位摘要（防刷屏）。
 * @param {'cn'|'en'} track
 * @param {object[]} jobs  已按分数降序
 * @param {object} meta    { threshold, replay }
 */
function formatTrackDigest(track, jobs, meta = {}) {
  const isEn = track !== 'cn';
  const trackLabel = isEn
    ? (meta.primary ? '英文海外主推（优质团队）' : '英文海外')
    : (meta.primary ? '中文主推' : '中文副线');
  const flag = isEn ? '🌍' : '🇨🇳';
  const threshold = meta.threshold ?? (isEn ? 50 : 40);
  const lines = [
    `${flag} <b>${trackLabel}</b>${meta.replay ? ' · 回放' : ''} · 阈值≥${threshold}`,
    `共 <b>${jobs.length}</b> 条 · ${isEn ? 'Himalayas/Remotive/Jobicy 等' : 'V2EX/电鸭/远程.work'}`,
    '',
  ];

  // 按平台分组
  const bySource = new Map();
  for (const job of jobs) {
    const key = job.source || 'unknown';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(job);
  }

  for (const [src, list] of bySource) {
    lines.push(`—— <b>${escHtml(sourceLabelOf({ source: src, sourceName: list[0]?.sourceName }))}</b> · ${list.length} 条`);
    list.forEach((job, i) => {
      const score = job.groqScore != null ? `${job.groqScore}` : '?';
      const mig = job.migration === 'near' ? '↗近迁'
        : job.migration === 'direct' ? '✓对口'
        : job.migration === 'far' ? '✗远' : '';
      const title = escHtml(String(job.title || '无标题').slice(0, 70));
      const url = job.url ? String(job.url).replace(/&/g, '&amp;') : '';
      const titlePart = url ? `<a href="${url}">${title}</a>` : title;
      const reason = job.groqReason ? ` · <i>${escHtml(job.groqReason)}</i>` : '';
      lines.push(`${i + 1}. <b>${score}</b>${mig ? ` ${mig}` : ''} ${titlePart}${reason}`);
    });
    lines.push('');
  }

  lines.push('<i>分数=画像技能匹配；near=小跨度可学，far=跨度过大已压分</i>');
  return lines.join('\n');
}

module.exports = {
  extractContacts,
  extractCompany,
  formatJobMessage,
  formatDailyDigest,
  formatTrackDigest,
  trackOf,
  sourceLabelOf,
  sendTelegramMessage,
  sendHeartbeat,
};
