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
  v2ex_jobs:        'V2EX·招聘',
  v2ex_outsourcing: 'V2EX·外包',
  eleduck:          '电鸭社区',
  yuancheng_work:   '远程.work',
};

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

module.exports = {
  extractContacts,
  formatJobMessage,
  sendTelegramMessage,
  sendHeartbeat,
};
