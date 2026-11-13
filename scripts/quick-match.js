/**
 * quick-match.js — 收紧版：技能白名单 + 全量 JD 匹配打分
 * ─────────────────────────────────────────────────────────────────
 * Layer 1 (0ms)  : 技能白名单粗筛（不再从画像乱抽词）
 * Layer 1.5      : 渣岗黑名单 + 英文签证硬过滤 + APAC 加分
 * Layer 2 (1-3s) : Groq 读较完整 JD，按画像技能匹配度打分（允许小跨度迁移）
 *
 * 瞄准：AI Agent / 自动化、Data Analyst、数据分析、飞书/电商数据、
 *       医疗健康数据（J&J/统计背景可小跨度迁移，如 FDA/临床数据运营）
 *
 * 环境变量：
 *   GROQ_API_KEY          — Layer 2 必需
 *   RADAR_SCORE_THRESHOLD — 默认 40
 *   RADAR_L1_MIN_HITS     — 默认 1（必须是核心技能词）
 *   RADAR_JD_CHARS        — 送入 Groq 的 JD 最大字符，默认 2800
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const PROFILE_PATH = path.join(__dirname, '..', 'config', 'my-profile.md');
const GROQ_ENDPOINT = 'api.groq.com';
const GROQ_PATH     = '/openai/v1/chat/completions';
const GROQ_MODEL    = process.env.GROQ_QUICK_MODEL || 'llama-3.1-8b-instant';
const SCORE_THRESHOLD = parseInt(process.env.RADAR_SCORE_THRESHOLD || '40', 10);
const L1_MIN_HITS     = parseInt(process.env.RADAR_L1_MIN_HITS || '1', 10);
const JD_CHARS        = parseInt(process.env.RADAR_JD_CHARS || '2800', 10);

/** 签证 / 地区硬门槛 */
const HARD_REJECT_PATTERNS = [
  /\bus\s*(only|citizen|citizenship)\b/i,
  /\beu\s*(only|citizen|citizenship)\b/i,
  /\bmust\s+be\s+(located\s+)?in\s+(the\s+)?(us|usa|united states|uk|canada|eu|europe)\b/i,
  /\bonly\s+(open\s+to|hiring)\s+(candidates\s+)?(in|from)\s+(the\s+)?(us|usa|uk|canada|eu)\b/i,
  /\b(require|requires|required|need|needs)\s+.{0,40}\b(us|usa|united states)\s+(work\s+)?(authorization|visa|permit)\b/i,
  /\b(green\s*card|uscis|h-?1b|opt\s+required)\b/i,
  /\bmust\s+have\s+(the\s+)?right\s+to\s+work\s+in\s+(the\s+)?(us|usa|uk|eu)\b/i,
  /\bcandidates\s+must\s+reside\s+in\s+(the\s+)?(us|usa|united states|uk|canada)\b/i,
  /\bno\s+(remote|applicants?)\s+from\s+(china|asia|apac)\b/i,
];

/** 职业渣岗 */
const JUNK_TITLE_PATTERNS = [
  /药师|药剂|护士|护工|牙医|司机|外卖|骑手|保安|保洁|厨师|服务员|仓管|理货/,
  /会计|出纳|审计|律师|法务|教师|幼教|班主任|房产中介|保险经纪/,
  /刷单|日结|兼职打字|淘宝客服专员|电话销售|电销|地推/,
  /\b(pharmacist|nurse|dentist|driver|chef|waiter|security guard|janitor)\b/i,
  /\b(accountant|lawyer|attorney|teacher|realtor|insurance agent)\b/i,
  /\b(telemarketer|cold caller)\b/i,
];

const BOOST_PATTERNS = [
  { re: /\b(worldwide|work\s+from\s+anywhere|anywhere\s+in\s+the\s+world|location[- ]independent)\b/i, boost: 10, label: 'worldwide' },
  { re: /\b(apac|asia[- ]pacific|asia\s+timezone|utc\+?8|gmt\+?8)\b/i, boost: 10, label: 'apac-tz' },
  { re: /\b(singapore|hong\s*kong|taiwan|sea\s+region)\b/i, boost: 8, label: 'sg-hk-tw' },
  { re: /\b(independent\s+contractor|contractor\s+(ok|welcome|friendly)|freelance\s+contract)\b/i, boost: 6, label: 'contractor' },
  { re: /\b(async(-|\s)?first|fully\s+async)\b/i, boost: 4, label: 'async' },
];

/**
 * 核心技能词（Layer1 必须命中至少 1 个）。
 * 单独的「远程/运营/data/ops」不够。
 */
const CORE_SKILL_KEYWORDS = [
  'ai agent', 'ai automation', 'automation engineer', 'workflow automation',
  'n8n', 'dify', 'langgraph', 'langchain', 'flowise', 'zapier', 'make.com',
  'ai工作流', 'ai自动化', '自动化工程师', '工作流自动化', '低代码', 'no-code', 'low-code', 'rpa',
  'llm', 'rag', 'prompt', 'chatbot', 'copilot', '大模型',
  'data analyst', 'data analytics', '数据分析师', '数据分析', '数据运营', 'business analyst',
  'bi analyst', 'analytics engineer', 'dashboard', 'pandas',
  '数据看板', '报表自动化',
  'fda', 'clinical data', 'biostat', 'healthcare analytics', 'health data',
  '医疗数据', '临床数据', '统计学', 'nomogram',
  'lead generation', 'lead gen', 'b2b', 'apollo', 'outreach', 'cold email',
  '获客', '线索挖掘', '销售自动化',
  '跨境电商', '千川', 'shopify', 'ecommerce analytics', 'e-commerce analytics',
  '飞书', 'feishu', 'lark', 'slack bot', 'notion api',
  'fastapi', 'next.js', 'nextjs', 'full-stack', 'fullstack',
  'python', 'typescript',
];

const WEAK_ALONE = new Set([
  '远程', 'remote', 'wfh', '全职', 'full-time', '居家', '运营', 'ops', 'operations',
  'data', '数据', '增长', 'growth', 'agent', 'asia', 'apac', '海外', '产品',
]);

function hasCoreSkillHit(hay) {
  const hits = [];
  const lower = hay.toLowerCase();
  for (const kw of CORE_SKILL_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) hits.push(kw);
    if (hits.length >= 8) break;
  }
  return hits;
}

function isJunkProfession(hay) {
  const core = hasCoreSkillHit(hay);
  const strongCore = core.some((k) =>
    /ai|n8n|dify|lang|data analyst|数据分析|python|fastapi|fda|clinical|biostat|analytics/i.test(k)
  );

  if (/药师|药剂师|执业药师|\bpharmacist\b/i.test(hay) &&
      !/data analyst|数据分析|clinical data|fda|biostat|healthcare analytics/i.test(hay)) {
    return true;
  }
  if (/\b(nurse|护工|护士)\b/i.test(hay) && !/clinical data|healthcare analytics|医疗数据/i.test(hay)) {
    return true;
  }

  for (const re of JUNK_TITLE_PATTERNS) {
    if (re.test(hay) && !strongCore) return true;
  }
  return false;
}

function checkEligibility(job) {
  const hay = `${job.title || ''} ${job.contentText || ''} ${job.location || ''}`;

  if (isJunkProfession(hay)) {
    return { rejected: true, boost: 0, labels: ['junk-role'], reason: '渣岗/无关职业' };
  }

  for (const re of HARD_REJECT_PATTERNS) {
    if (re.test(hay)) {
      return { rejected: true, boost: 0, labels: ['visa-block'], reason: '签证硬过滤' };
    }
  }

  const labels = [];
  let boost = 0;
  for (const { re, boost: b, label } of BOOST_PATTERNS) {
    if (re.test(hay)) {
      boost += b;
      labels.push(label);
    }
  }
  boost = Math.min(boost, 16);
  return { rejected: false, boost, labels, reason: labels.join('|') || 'ok' };
}

function loadProfileSummary() {
  if (!fs.existsSync(PROFILE_PATH)) {
    return 'Iris Lin：AI 自动化 / Data Analyst / AI Agent，广州 UTC+8，求远程。';
  }
  return fs.readFileSync(PROFILE_PATH, 'utf8').slice(0, 2200).trim();
}

function groqQuickScore(jobTitle, jobJd, profileSummary, groqKey) {
  return new Promise((resolve, reject) => {
    const systemPrompt = `你是远程求职匹配官。候选人在中国大陆（UTC+8）。
请阅读完整 JD（标题+正文），打「技能匹配分」0-100。

【优先瞄准】
- AI Agent / AI Automation / n8n·Dify·LangGraph 工作流
- Data Analyst / 数据分析师 / 数据运营（报表、看板、SQL、pandas）
- 小跨度：Healthcare/FDA/临床数据运营或生物统计向分析（候选人有统计学+J&J 医疗数据背景）
- B2B 获客自动化、飞书/Slack 自动化、跨境电商数据分析

【迁移规则】
- 允许：现有技能附近、1-2 周能补齐的工具差（Excel→SQL、飞书→Slack）
- 禁止大跨度：纯药师/护士执业、纯律师、纯司机、纯电话销售、纯 Java/.NET 企业后端、需 5 年+ Senior

【硬规则】
- US/EU 公民或本地工签硬性要求且不可 contractor → ≤20
- Worldwide/APAC/UTC+8/contractor → 可酌情 +5~10
- 与画像几乎无关 → ≤25

只输出 JSON：{"score":整数,"reason":"18字内中文","migration":"direct|near|far"}
migration: direct=直接对口, near=小跨度可学, far=跨度太大应低分`;

    const userPrompt = `【候选人画像】
${profileSummary}

【完整 JD】
标题：${jobTitle}
正文：${jobJd}

输出 JSON：`;

    const body = JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 80,
      stream: false,
    });

    const options = {
      hostname: GROQ_ENDPOINT,
      path: GROQ_PATH,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.message?.content?.trim() || '{}';
          const jsonMatch = content.match(/\{[\s\S]*?\}/);
          const result = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
          let score = typeof result.score === 'number' ? Math.round(result.score) : 0;
          if (result.migration === 'far' && score > 35) score = 35;
          resolve({
            score,
            reason: typeof result.reason === 'string' ? result.reason : '',
            migration: result.migration || '',
          });
        } catch (e) {
          resolve({ score: 40, reason: '解析失败中立分', migration: '' });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('Groq timeout')));
    req.write(body);
    req.end();
  });
}

function createMatcher() {
  const profileSummary = loadProfileSummary();
  const groqKey = process.env.GROQ_API_KEY || '';

  console.log(`[quick-match] ✅ 技能白名单 ${CORE_SKILL_KEYWORDS.length} 词；渣岗黑名单已启用`);
  if (!groqKey) {
    console.log('[quick-match] ℹ️  未设置 GROQ_API_KEY，将跳过 Layer 2');
  } else {
    console.log(`[quick-match] ⚡ Groq 全量 JD 打分（模型：${GROQ_MODEL}，阈值：${SCORE_THRESHOLD}，JD≤${JD_CHARS}字）`);
  }

  return {
    layer1(job) {
      const hay = `${job.title || ''} ${job.contentText || ''}`.toLowerCase();
      const hits = hasCoreSkillHit(hay);
      return hits.filter((h) => !WEAK_ALONE.has(h.toLowerCase()));
    },

    eligibility(job) {
      return checkEligibility(job);
    },

    async layer2(job) {
      if (!groqKey) return { score: 100, reason: '未配置 Groq，直接通过', skipped: true, migration: '' };

      const jd = String(job.contentText || '').slice(0, JD_CHARS);
      try {
        const result = await groqQuickScore(job.title, jd, profileSummary, groqKey);
        return { ...result, skipped: false };
      } catch (err) {
        console.log(`[quick-match] ⚠️  Groq 失败（${err.message}），降级 45 分`);
        return { score: 45, reason: 'Groq 失败降级', skipped: true, migration: '' };
      }
    },

    get threshold() { return SCORE_THRESHOLD; },
    get l1MinHits() { return L1_MIN_HITS; },
  };
}

module.exports = { createMatcher, checkEligibility, CORE_SKILL_KEYWORDS };
