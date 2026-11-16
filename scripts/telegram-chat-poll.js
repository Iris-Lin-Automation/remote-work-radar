/**
 * telegram-chat-poll.js — 本地长轮询对话（无需 webhook）
 *
 * 知识库优先级：
 *   1) Postgres jobs（DATABASE_URL 可用时）
 *   2) data/pushed_jobs.json（历史推送，本机一定有）
 *
 * 用法：npm run chat  → 手机自然语言问 Bot
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const eq = t.indexOf('=');
    if (eq < 0) return;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  });
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED_CHAT = String(process.env.TELEGRAM_CHAT_ID || '');
const USER_KEY = process.env.RADAR_USER_KEY || 'iris';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const PUSHED_FILE = path.join(__dirname, '..', 'data', 'pushed_jobs.json');

if (!BOT_TOKEN) {
  console.error('❌ 请在 .env 设置 TELEGRAM_BOT_TOKEN');
  process.exit(1);
}
if (!ALLOWED_CHAT) {
  console.error('❌ 请在 .env 设置 TELEGRAM_CHAT_ID');
  process.exit(1);
}

let dbReady = false;
let radarRunning = false;

// ── local KB from pushed_jobs.json ──
function loadPushedJobs() {
  try {
    if (!fs.existsSync(PUSHED_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(PUSHED_FILE, 'utf8'));
    const arr = Array.isArray(raw.jobs) ? raw.jobs : (Array.isArray(raw) ? raw : []);
    return arr.map((j, i) => ({
      id: `pushed-${i}`,
      title: j.title || '',
      url: j.url || '',
      source: j.source || j.sourceName || '',
      score: j.score ?? j.groqScore ?? null,
      track: j.track || inferTrack(j),
      at: j.at || j.pushedAt || null,
      recommendation_status: j.recommendation_status || null,
      china_eligible: j.china_eligible || j.hard?.china_eligible || null,
      reason: j.groqReason || j.reason || '',
    }));
  } catch (e) {
    console.error('loadPushedJobs', e.message);
    return [];
  }
}

function inferTrack(j) {
  const src = String(j.source || '');
  if (/V2EX|电鸭|远程\.work|yuancheng|yw_/i.test(src)) return 'cn';
  if (/Himalayas|Remotive|RemoteOK|WWR|Jobicy|Growix|OpenTrain|Greenhouse|Ashby/i.test(src)) return 'en';
  const t = `${j.title || ''} ${j.url || ''}`;
  if (/[\u4e00-\u9fff]/.test(t) && !/\b(remote|engineer|ai)\b/i.test(t)) return 'cn';
  return 'en';
}

function searchJobs(jobs, query, { track, limit = 12 } = {}) {
  const q = String(query || '').toLowerCase().trim();
  const stop = new Set([
    '现在', '有没有', '哪些', '什么', '岗位', '工作', '远程', '帮我', '找', '一下',
    '推荐', '看看', '可以', '给我', '的', '了', '吗', '呢', '啊', '吧', '请',
    'the', 'a', 'an', 'jobs', 'job', 'remote', 'find', 'show', 'list', 'any',
    '你', '还', '能', '干', '吗', '直接', '跑', '一下',
  ]);
  const tokens = q
    .split(/[\s,，、/|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !stop.has(t));

  let list = jobs.slice();
  if (track === 'en' || track === 'cn') {
    list = list.filter((j) => j.track === track);
  }

  if (!tokens.length) {
    return list
      .slice()
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      .slice(0, limit);
  }

  const scored = list.map((j) => {
    const hay = `${j.title} ${j.source} ${j.reason} ${j.url}`.toLowerCase();
    let hits = 0;
    for (const t of tokens) {
      if (hay.includes(t.toLowerCase())) hits += 1;
    }
    // english soft aliases
    if (/ai|agent|自动化|automation|n8n|llm|数据|analyst|python/i.test(tokens.join(' '))) {
      if (/ai|agent|automation|n8n|llm|analyst|python|数据/i.test(hay)) hits += 0.5;
    }
    return { j, hits, score: Number(j.score) || 0 };
  }).filter((x) => x.hits > 0);

  scored.sort((a, b) => b.hits - a.hits || b.score - a.score);
  return scored.slice(0, limit).map((x) => x.j);
}

function formatJobList(jobs, title) {
  if (!jobs.length) return `${title}\n（没有匹配）`;
  const lines = [title, ''];
  jobs.forEach((j, i) => {
    const score = j.score != null ? `${j.score}分` : '?分';
    const track = j.track === 'cn' ? '中' : '英';
    const st = j.recommendation_status ? ` · ${j.recommendation_status}` : '';
    lines.push(`${i + 1}. [${track}] ${score}${st} ${j.title.slice(0, 70)}`);
    if (j.source) lines.push(`   来源：${j.source}`);
    if (j.url) lines.push(`   ${j.url}`);
  });
  return lines.join('\n');
}

function kbSummary(jobs) {
  const en = jobs.filter((j) => j.track === 'en').length;
  const cn = jobs.filter((j) => j.track === 'cn').length;
  const withScore = jobs.filter((j) => j.score != null && j.score > 0).length;
  return `知识库：历史推送 ${jobs.length} 条（英 ${en} / 中 ${cn}，有分 ${withScore}）。DB=${dbReady ? 'on' : 'off'}`;
}

// ── Telegram API ──
function tgApi(method, payload) {
  return new Promise((resolve, reject) => {
    const isGet = method.startsWith('getUpdates');
    const opts = {
      hostname: 'api.telegram.org',
      path: isGet ? `/bot${BOT_TOKEN}/${method}` : `/bot${BOT_TOKEN}/${method.split('?')[0]}`,
      method: isGet ? 'GET' : 'POST',
      headers: {},
    };
    let body = '';
    if (!isGet && payload) {
      body = JSON.stringify(payload);
      opts.headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      };
    }
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(isGet ? 60000 : 20000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function tgSend(chatId, text) {
  const res = await tgApi('sendMessage', {
    chat_id: chatId,
    text: String(text).slice(0, 4000),
    disable_web_page_preview: true,
  });
  if (!res.ok) console.error('send fail', res.description);
}

async function groqChat(userText, context) {
  if (!GROQ_KEY) return { ok: false, text: null, err: 'no GROQ_API_KEY' };
  const system = `你是 Iris 的 Remote Job Copilot（求职助手）。用中文简洁、像真人聊天。
候选人在中国大陆 UTC+8。Worldwide ≠ 已确认可从中国受雇。
你可以：检索历史岗位、解释匹配、记住偏好建议、建议下一步。
规则：
- 只根据【知识库】里的岗位说话，不要编造公司/链接
- 若知识库为空或无关，诚实说没有，并建议发「跑雷达」或关键词
- 用户问「你能干什么」时，用口语介绍能力，不要只丢命令列表
- 用户说想投/想核实某方向时，从知识库挑 3-8 条并简述为什么`;

  const body = JSON.stringify({
    model: process.env.GROQ_CHAT_MODEL || process.env.GROQ_QUICK_MODEL || 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `用户说：${userText}\n\n【知识库】\n${context}` },
    ],
    temperature: 0.35,
    max_tokens: 900,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          const text = p?.choices?.[0]?.message?.content?.trim();
          if (text) resolve({ ok: true, text, err: null });
          else resolve({ ok: false, text: null, err: p?.error?.message || data.slice(0, 180) });
        } catch (e) {
          resolve({ ok: false, text: null, err: e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, text: null, err: e.message }));
    req.setTimeout(25000, () => {
      req.destroy();
      resolve({ ok: false, text: null, err: 'groq timeout' });
    });
    req.write(body);
    req.end();
  });
}

async function jobsFromDb(status, limit = 15) {
  if (!dbReady) return [];
  try {
    return await db.listJobsByStatus({ status, limit });
  } catch {
    return [];
  }
}

function detectTrack(text) {
  if (/英文|海外|overseas|english|\ben\b/i.test(text)) return 'en';
  if (/中文|国内|电鸭|v2ex|\bcn\b/i.test(text)) return 'cn';
  return null;
}

function wantsJobSearch(text) {
  return /岗位|工作|推荐|有没有|哪些|找|搜|list|jobs?|apply|verify|远程|海外|国内|ai|agent|自动化|数据|分析|python|n8n/i.test(text);
}

async function buildContext(userText) {
  const pushed = loadPushedJobs();
  const track = detectTrack(userText);
  const matched = searchJobs(pushed, userText, { track, limit: 10 });

  const applyDb = await jobsFromDb('apply_now', 8);
  const verifyDb = await jobsFromDb('verify', 8);

  const lines = [
    kbSummary(pushed),
    dbReady ? 'Postgres 已连接，可查 recommendation_status。' : 'Postgres 未连接（localhost 拒绝）；当前用历史推送 JSON 当知识库。',
    '',
    '【历史推送匹配】',
  ];

  if (matched.length) {
    matched.forEach((j, i) => {
      lines.push(`${i + 1}. [${j.track}] ${j.score ?? '?'}分 | ${j.title}`);
      lines.push(`   ${j.source || ''} ${j.url || ''}`);
    });
  } else {
    lines.push('（关键词无直接命中；下面给最近高分/英中抽样）');
    const en = searchJobs(pushed, '', { track: 'en', limit: 5 });
    const cn = searchJobs(pushed, '', { track: 'cn', limit: 5 });
    [...en, ...cn].forEach((j, i) => {
      lines.push(`${i + 1}. [${j.track}] ${j.score ?? '?'}分 | ${j.title.slice(0, 80)}`);
      if (j.url) lines.push(`   ${j.url}`);
    });
  }

  if (applyDb.length || verifyDb.length) {
    lines.push('', '【DB apply_now】');
    applyDb.forEach((r) => lines.push(`- ${r.match_score} ${r.title} | ${r.apply_url}`));
    lines.push('【DB verify】');
    verifyDb.forEach((r) => lines.push(`- ${r.match_score} ${r.title} | ${r.apply_url}`));
  }

  let prefs = '';
  if (dbReady) {
    try { prefs = await db.getPreferenceSummary(USER_KEY); } catch { /* */ }
  }
  lines.push('', `【偏好】${prefs || '暂无'}`);
  return { context: lines.join('\n').slice(0, 6000), matched, pushed };
}

async function runRadarOnce(chatId) {
  if (radarRunning) {
    await tgSend(chatId, '雷达已经在跑，稍等这轮结束。');
    return;
  }
  radarRunning = true;
  await tgSend(chatId, '好，开始跑一轮雷达（可能 1–3 分钟）…');
  const child = spawn(process.execPath, [path.join(__dirname, 'run-radar-cycle.js')], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tail = '';
  child.stdout.on('data', (c) => {
    const s = String(c);
    process.stdout.write(s);
    tail = (tail + s).slice(-1500);
  });
  child.stderr.on('data', (c) => {
    const s = String(c);
    process.stderr.write(s);
    tail = (tail + s).slice(-1500);
  });
  child.on('close', async (code) => {
    radarRunning = false;
    const last = tail.split(/\n/).filter(Boolean).slice(-6).join('\n');
    await tgSend(
      chatId,
      code === 0
        ? `雷达跑完了。可发「海外 AI」或 /apply 看结果。\n${last.slice(0, 800)}`
        : `雷达退出码 ${code}。\n${last.slice(0, 800)}`
    );
  });
}

async function handleText(chatId, text) {
  try {
    if (dbReady) {
      await db.saveConversation({ userKey: USER_KEY, chatId, role: 'user', content: text });
    }
  } catch { /* */ }

  let reply;

  // ── explicit shortcuts ──
  if (/^\/?help$/i.test(text) || text === '帮助') {
    reply = [
      '我是你的远程求职助手（不只会命令）。',
      '',
      '可以直接说：',
      '• 有哪些海外 AI / 自动化岗？',
      '• 国内远程数据分析有什么？',
      '• Growix 那岗怎么样？',
      '• 我更喜欢异步少开会',
      '• 跑雷达 / 刷新岗位',
      '',
      '快捷：/apply  /verify  /prefs  /kb',
      kbSummary(loadPushedJobs()),
    ].join('\n');
  } else if (/^\/?kb$/i.test(text) || /知识库|有多少岗|库存/.test(text)) {
    const jobs = loadPushedJobs();
    const en = searchJobs(jobs, '', { track: 'en', limit: 5 });
    const cn = searchJobs(jobs, '', { track: 'cn', limit: 5 });
    reply = [
      kbSummary(jobs),
      '',
      formatJobList(en, '海外抽样：'),
      '',
      formatJobList(cn, '国内抽样：'),
    ].join('\n');
  } else if (/^\/?prefs$/i.test(text) || text === '偏好') {
    let prefs = dbReady ? await db.getPreferenceSummary(USER_KEY) : '';
    reply = prefs || '暂无已确认偏好。可直接说「我更喜欢异步少开会」。';
  } else if (/^(跑雷达|刷新|扫描|再跑一轮|你直接跑|start radar|\/radar)/i.test(text)) {
    await runRadarOnce(chatId);
    return;
  } else if (/^(apply_now|\/apply|立刻投)/i.test(text)) {
    const dbJobs = await jobsFromDb('apply_now', 10);
    if (dbJobs.length) {
      reply = dbJobs.map((r, i) => `${i + 1}. ${r.match_score} ${r.title}\n${r.apply_url}`).join('\n\n');
    } else {
      const jobs = searchJobs(loadPushedJobs(), 'ai agent automation python n8n', { track: 'en', limit: 8 });
      reply = formatJobList(jobs, 'DB 暂无 apply_now；这是历史推送里偏匹配的海外岗：')
        + '\n\n想要最新的可以说「跑雷达」。';
    }
  } else if (/^(verify|\/verify|核实)/i.test(text)) {
    const dbJobs = await jobsFromDb('verify', 10);
    if (dbJobs.length) {
      reply = dbJobs.map((r, i) => `${i + 1}. ${r.match_score} ${r.title}\n${r.apply_url}`).join('\n\n');
    } else {
      reply = 'DB 暂无 verify。可说「海外远程」从历史推送里找，或「跑雷达」刷新。';
    }
  } else if (/^\/?confirm\s+([0-9a-f-]{36})$/i.test(text)) {
    if (!dbReady) {
      reply = '数据库未连接，暂时无法确认偏好。请先启动本地 Postgres 或改 DATABASE_URL。';
    } else {
      const id = text.match(/([0-9a-f-]{36})/i)[1];
      const res = await db.confirmPreferenceSignal(id, USER_KEY);
      reply = res.ok ? `已确认偏好 ${id}` : `失败：${res.error}`;
    }
  } else if (/^反馈[:：]/.test(text)) {
    const body = text.replace(/^反馈[:：]\s*/, '');
    if (dbReady) {
      await db.insertApplicationFeedback({
        userKey: USER_KEY,
        notes: body.slice(0, 2000),
        outcome: /面试|interview/i.test(body) ? 'interview'
          : /拒|reject/i.test(body) ? 'rejected'
          : /offer/i.test(body) ? 'offer'
          : /投|applied/i.test(body) ? 'applied' : 'other',
      });
      reply = '已记下反馈，下一轮评分会参考。';
    } else {
      reply = 'DB 未连接，反馈先记在对话里；连上库后再说一次「反馈：…」即可落库。';
    }
  } else if (/我(更)?(喜欢|希望|不要|别再|讨厌)/.test(text)) {
    if (!dbReady) {
      reply = `收到偏好：「${text.slice(0, 80)}」\n但 DB 未连接，还不能持久化。可先继续按这个标准帮你筛历史岗；连上库后再说一次即可写入。`;
    } else {
      const signalValue = { preference_summary_append: text.slice(0, 240) };
      if (/异步|少开会|少会/.test(text)) {
        signalValue.prefer_async = true;
        signalValue.prefer_few_meetings = true;
      }
      if (/销售/.test(text)) signalValue.avoid_sales = true;
      const row = await db.insertPreferenceSignal({
        userKey: USER_KEY,
        signalType: 'chat_preference',
        signalValue,
        rawText: text,
        status: 'pending',
      });
      reply = `已提议偏好。确认请发：\n/confirm ${row?.id || '?'}`;
    }
  } else {
    // ── natural language → KB + Groq ──
    const { context, matched, pushed } = await buildContext(text);
    const ai = await groqChat(text, context);

    if (ai.ok) {
      reply = ai.text;
    } else {
      console.error('groq fail:', ai.err);
      // deterministic fallback that still feels useful
      if (/你能|干什么|你会|功能|能做/.test(text)) {
        reply = [
          '可以，不用只会命令。',
          '你可以用大白话问我，例如「海外 AI 自动化有哪些」「国内数据分析远程」。',
          '我会在历史推送知识库里检索，并解释适不适合你（中国 UTC+8）。',
          '说「跑雷达」会现场扫一轮新岗。',
          '',
          kbSummary(pushed),
        ].join('\n');
      } else if (wantsJobSearch(text) || matched.length) {
        const track = detectTrack(text);
        const list = matched.length
          ? matched
          : searchJobs(pushed, text, { track, limit: 8 });
        reply = formatJobList(
          list,
          `（AI 暂时不可用：${ai.err || 'unknown'}）先按知识库检索：`
        );
      } else {
        reply = `我在听。可以问具体方向，例如「海外 AI」「国内远程 Python」。\n${kbSummary(pushed)}\n（Groq：${ai.err || 'fail'}）`;
      }
    }
  }

  await tgSend(chatId, reply);
  try {
    if (dbReady) {
      await db.saveConversation({ userKey: USER_KEY, chatId, role: 'assistant', content: reply });
    }
  } catch { /* */ }
  console.log(`← ${String(reply).slice(0, 100).replace(/\n/g, ' ')}`);
}

async function probeDb() {
  const p = db.getPool();
  if (!p) {
    dbReady = false;
    return;
  }
  try {
    await p.query('SELECT 1');
    dbReady = true;
  } catch (e) {
    dbReady = false;
    console.log(`[chat-poll] DB 不可用：${e.code || e.message || 'ECONNREFUSED'}（将用 pushed_jobs.json 知识库）`);
  }
}

async function main() {
  await probeDb();
  const pushed = loadPushedJobs();
  console.log(`[chat-poll] DB=${dbReady ? 'on' : 'off'} Groq=${GROQ_KEY ? 'on' : 'off'} chat=${ALLOWED_CHAT}`);
  console.log(`[chat-poll] 知识库 pushed_jobs=${pushed.length} 条`);
  console.log('[chat-poll] 删除 webhook，改用长轮询…');
  await tgApi('deleteWebhook', { drop_pending_updates: false });

  try {
    await tgSend(
      ALLOWED_CHAT,
      `🟢 Copilot 已上线（可自然语言）\n${kbSummary(pushed)}\n试着问：海外 AI 自动化有哪些？ 或发「跑雷达」`
    );
  } catch (e) {
    console.error('无法发消息', e.message);
  }

  let offset = 0;
  console.log('[chat-poll] 等你在 Telegram 发消息… (Ctrl+C 退出)');

  for (;;) {
    try {
      const res = await tgApi(`getUpdates?timeout=50&offset=${offset}`);
      if (!res.ok) {
        console.error('getUpdates', res.description);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      for (const u of res.result || []) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text) continue;
        const chatId = String(msg.chat.id);
        console.log(`→ [${chatId}] ${msg.text}`);
        if (chatId !== ALLOWED_CHAT) {
          await tgSend(chatId, '未授权的 chat。');
          continue;
        }
        try {
          await handleText(chatId, String(msg.text).trim());
        } catch (err) {
          console.error('handle', err);
          await tgSend(chatId, `出错：${err.message}`);
        }
      }
    } catch (err) {
      if (err.message !== 'timeout') console.error('poll', err.message);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

main().catch(async (e) => {
  console.error(e);
  await db.closePool().catch(() => {});
  process.exit(1);
});
