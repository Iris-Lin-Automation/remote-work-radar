/**
 * quick-match.js — Copilot 三层评分
 * ─────────────────────────────────────────────────────────────────
 * Layer 1      : 技能白名单粗筛
 * Layer 1.5    : 渣岗 / 签证硬过滤 + boost
 * Hard rules   : china_eligible / work_mode / hire_vehicle / employment_type
 * Layer 2      : Groq 六维分 + migration + recommendation_status
 *
 * Worldwide ≠ 中国可受雇：china_eligible=unclear 时最多 verify，不进 apply_now
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const PROFILE_PATH = path.join(__dirname, '..', 'config', 'my-profile.md');
const WEIGHTS_PATH = path.join(__dirname, '..', 'config', 'scoring-weights.json');
const GROQ_ENDPOINT = 'api.groq.com';
const GROQ_PATH     = '/openai/v1/chat/completions';
// Prefer GROQ_MODEL; fall back to legacy GROQ_QUICK_MODEL. Default: openai/gpt-oss-20b
const GROQ_MODEL = process.env.GROQ_MODEL
  || process.env.GROQ_QUICK_MODEL
  || 'openai/gpt-oss-20b';
const PROMPT_VERSION = process.env.RADAR_PROMPT_VERSION || 'v1';
const PROFILE_VERSION = process.env.RADAR_PROFILE_VERSION || 'v1';
const SCORE_THRESHOLD = parseInt(process.env.RADAR_SCORE_THRESHOLD || '40', 10);
const L1_MIN_HITS     = parseInt(process.env.RADAR_L1_MIN_HITS || '1', 10);
const JD_CHARS        = parseInt(process.env.RADAR_JD_CHARS || '2800', 10);

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

const JUNK_TITLE_PATTERNS = [
  /药师|药剂|护士|护工|牙医|司机|外卖|骑手|保安|保洁|厨师|服务员|仓管|理货/,
  /会计|出纳|审计|律师|法务|教师|幼教|班主任|房产中介|保险经纪/,
  /刷单|日结|兼职打字|淘宝客服专员|电话销售|电销|地推/,
  /\b(pharmacist|nurse|dentist|driver|chef|waiter|security guard|janitor)\b/i,
  /\b(accountant|lawyer|attorney|teacher|realtor|insurance agent)\b/i,
  /\b(telemarketer|cold caller)\b/i,
];

const BOOST_PATTERNS = [
  { re: /\b(worldwide|work\s+from\s+anywhere|anywhere\s+in\s+the\s+world|location[- ]independent|open\s+to\s+(candidates\s+from\s+)?all\s+countries)\b/i, boost: 10, label: 'worldwide' },
  { re: /\b(apac|asia[- ]pacific|asia\s+timezone|utc\+?8|gmt\+?8)\b/i, boost: 10, label: 'apac-tz' },
  { re: /\b(singapore|hong\s*kong|taiwan|sea\s+region)\b/i, boost: 8, label: 'sg-hk-tw' },
  { re: /\b(independent\s+contractor|contractor\s+(ok|welcome|friendly)|freelance\s+contract)\b/i, boost: 6, label: 'contractor' },
  { re: /\b(async(-|\s)?first|fully\s+async)\b/i, boost: 4, label: 'async' },
  { re: /\b(ai\s+automation|workflow\s+engineer|n8n|langgraph|solutions?\s+engineer|implementation\s+engineer|forward[\s-]?deployed)\b/i, boost: 8, label: 'quality-role' },
  { re: /\b(remote[\s-]?first|distributed\s+team|product[\s-]?led|series\s+[abc]|yc\s+|well[\s-]?funded)\b/i, boost: 5, label: 'quality-team' },
];

const EN_GEO_LOCK_REJECT = [
  /\b(latam|latin\s+america)\s+only\b/i,
  /\b(philippines|india|nigeria|kenya|pakistan|bangladesh)\s+only\b/i,
  /\bonly\s+(open\s+to|hiring)\s+.{0,40}\b(latam|philippines|india|nigeria|argentina|brazil|mexico)\b/i,
  /\b(u\.?s\.?|united states)\s+based\b.*\b(citizen|authorization|must\s+reside)/i,
];

const EN_LOW_QUALITY = [
  /\b(ai\s+trainer|data\s+label|labeling|rlhf\s+rater|task\s+auditor|micro1|mindrift|outlier\s+ai)\b/i,
  /\b(crowd\s*sourc|clickworker|scale\s+ai\s+contributor)\b/i,
];

const EN_THRESHOLD = parseInt(process.env.RADAR_EN_THRESHOLD || process.env.RADAR_SCORE_THRESHOLD || '40', 10);
const CN_THRESHOLD = parseInt(process.env.RADAR_CN_THRESHOLD || '40', 10);

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
  'ai integration', 'applied ai', 'llm application',
];

const WEAK_ALONE = new Set([
  '远程', 'remote', 'wfh', '全职', 'full-time', '居家', '运营', 'ops', 'operations',
  'data', '数据', '增长', 'growth', 'agent', 'asia', 'apac', '海外', '产品',
  'python', 'typescript', 'b2b', 'llm', 'prompt', 'dashboard', 'fastapi', 'next.js', 'nextjs',
]);

function loadWeights() {
  const defaults = {
    tech: 30, delivery: 20, level: 15, workstyle: 20, comp: 10, trust: 5,
    apply_now_min: 70, verify_min: 40,
  };
  try {
    if (fs.existsSync(WEIGHTS_PATH)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8')) };
    }
  } catch (_) { /* ignore */ }
  return defaults;
}

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

function checkEligibility(job, track = 'en') {
  const hay = `${job.title || ''} ${job.contentText || ''} ${job.location || ''}`;

  if (isJunkProfession(hay)) {
    return { rejected: true, boost: 0, labels: ['junk-role'], reason: '渣岗/无关职业' };
  }
  for (const re of HARD_REJECT_PATTERNS) {
    if (re.test(hay)) {
      return { rejected: true, boost: 0, labels: ['visa-block'], reason: '签证硬过滤' };
    }
  }
  if (track === 'en') {
    for (const re of EN_GEO_LOCK_REJECT) {
      if (re.test(hay)) {
        return { rejected: true, boost: 0, labels: ['geo-lock'], reason: '地区锁死非全球/APAC' };
      }
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
  if (track === 'en') {
    for (const re of EN_LOW_QUALITY) {
      if (re.test(hay)) {
        boost -= 18;
        labels.push('low-quality-gig');
      }
    }
  }
  boost = Math.max(-20, Math.min(boost, 22));
  return { rejected: false, boost, labels, reason: labels.join('|') || 'ok' };
}

/** Hard condition extraction (rules, not LLM) */
function extractHardConditions(job) {
  const hay = `${job.title || ''} ${job.contentText || ''} ${job.location || ''}`;

  let china_eligible = 'unclear';
  let china_eligibility_reason = '未明确中国大陆可受雇；Worldwide≠可雇佣';

  if (HARD_REJECT_PATTERNS.some((re) => re.test(hay)) || EN_GEO_LOCK_REJECT.some((re) => re.test(hay))) {
    china_eligible = 'false';
    china_eligibility_reason = '签证/地区硬限制';
  } else if (/\b(china|chinese\s+mainland|prc|utc\+?8)\b/i.test(hay) &&
             /\b(welcome|ok|accepted|eligible|open)\b/i.test(hay)) {
    china_eligible = 'true';
    china_eligibility_reason = 'JD 明示接受中国/UTC+8';
  } else if (
    (/\b(worldwide|work\s+from\s+anywhere|open\s+to\s+(candidates\s+from\s+)?all\s+countries|hire\s+worldwide)\b/i.test(hay))
    && (/\b(contractor|eor|employer\s+of\s+record|independent\s+contractor)\b/i.test(hay))
  ) {
    china_eligible = 'true';
    china_eligibility_reason = 'Worldwide + contractor/EOR 信号';
  } else if (/\b(worldwide|work\s+from\s+anywhere|all\s+countries)\b/i.test(hay)) {
    china_eligible = 'unclear';
    china_eligibility_reason = '仅写 Worldwide，未确认雇佣载体';
  }

  let work_mode = 'unknown';
  if (/\b(hybrid|部分远程|on[\s-]?site|office[\s-]?based|must\s+relocate)\b/i.test(hay) &&
      !/\b(fully\s+remote|100%\s*remote|remote[\s-]?first)\b/i.test(hay)) {
    work_mode = /\bon[\s-]?site|office|relocate\b/i.test(hay) ? 'onsite' : 'hybrid';
  } else if (/\b(fully\s+remote|100%\s*remote|remote[\s-]?first|work\s+from\s+anywhere|worldwide\s+remote)\b/i.test(hay) ||
             /\bremote\b/i.test(hay)) {
    work_mode = 'fully_remote';
  }

  let hire_vehicle = 'unknown';
  if (/\b(eor|employer\s+of\s+record)\b/i.test(hay)) hire_vehicle = 'eor';
  else if (/\b(contractor|independent\s+contractor|freelance\s+contract|1099)\b/i.test(hay)) hire_vehicle = 'contractor';
  else if (/\b(full[\s-]?time\s+employee|w-?2|permanent\s+employee|payroll)\b/i.test(hay)) hire_vehicle = 'employee';

  let employment_type = null;
  if (/\b(part[\s-]?time)\b/i.test(hay)) employment_type = 'part_time';
  else if (/\b(freelance|project[\s-]?based)\b/i.test(hay)) employment_type = 'freelance';
  else if (/\b(contract|contractor)\b/i.test(hay)) employment_type = 'contract';
  else if (/\b(full[\s-]?time)\b/i.test(hay)) employment_type = 'full_time';

  let benefits_signal = null;
  if (/\b(health\s+insurance|401k|pto|paid\s+time\s+off|medical|benefits)\b/i.test(hay)) {
    benefits_signal = 'mentioned';
  }

  return {
    china_eligible,
    china_eligibility_reason,
    work_mode,
    hire_vehicle,
    employment_type,
    benefits_signal,
  };
}

function weightedScore(dims, weights) {
  const keys = ['tech', 'delivery', 'level', 'workstyle', 'comp', 'trust'];
  let sum = 0;
  let wsum = 0;
  for (const k of keys) {
    const w = Number(weights[k]) || 0;
    const v = typeof dims[k] === 'number' ? dims[k] : 0;
    sum += w * v;
    wsum += w;
  }
  if (!wsum) return 0;
  return Math.round(sum / wsum);
}

function decideRecommendation({ hard, dims, total, weights, eligRejected, scoreStatus }) {
  // LLM failures / unscored never become apply_now
  if (scoreStatus === 'error' || scoreStatus === 'skipped' || scoreStatus === 'pending') {
    if (eligRejected || hard.china_eligible === 'false' || hard.work_mode === 'onsite') {
      return 'skip';
    }
    return 'verify';
  }
  if (eligRejected || hard.china_eligible === 'false' || hard.work_mode === 'onsite') {
    return 'skip';
  }
  const applyMin = weights.apply_now_min ?? 70;
  const verifyMin = weights.verify_min ?? 40;

  if (hard.china_eligible === 'unclear') {
    return total >= verifyMin ? 'verify' : 'skip';
  }
  // evergreen / flexible buckets should not dominate apply_now
  if (hard.source_bucket === 'evergreen_contractor' || hard.source_bucket === 'flexible_ai_tasks') {
    return total >= verifyMin ? 'verify' : 'skip';
  }
  if (total >= applyMin && (dims.tech ?? 0) >= 55) return 'apply_now';
  if (total >= verifyMin) return 'verify';
  return 'skip';
}

function validateDims(result) {
  const keys = ['tech', 'delivery', 'level', 'workstyle', 'comp', 'trust'];
  const dims = {};
  for (const k of keys) {
    const n = Number(result[k]);
    if (!Number.isFinite(n)) {
      throw new Error(`missing/invalid dim: ${k}`);
    }
    dims[k] = Math.max(0, Math.min(100, Math.round(n)));
  }
  let migration = result.migration || '';
  if (!['direct', 'near', 'far', ''].includes(migration)) migration = '';
  return {
    dims,
    reason: typeof result.reason === 'string' ? result.reason.slice(0, 80) : '',
    migration,
  };
}

function loadProfileSummary() {
  if (!fs.existsSync(PROFILE_PATH)) {
    return 'Iris Lin：AI Application & Integration Engineer，广州 UTC+8，求远程。';
  }
  return fs.readFileSync(PROFILE_PATH, 'utf8').slice(0, 2200).trim();
}

/**
 * Optional async loader for preference summary from DB.
 * Injected by createMatcher({ preferenceSummary, preferenceLoader })
 */
function groqMultiDimScore(jobTitle, jobJd, profileSummary, preferenceSummary, groqKey) {
  return new Promise((resolve, reject) => {
    const systemPrompt = `你是远程求职匹配官。候选人在中国大陆（UTC+8）。
阅读完整 JD，输出六维分数 0-100。必须是合法 JSON 对象，六维字段全为数字。

维度：tech, delivery, level, workstyle, comp, trust
另含 reason(短中文), migration(direct|near|far)

硬规则：Worldwide≠中国可雇；AI trainer/labeling 低 trust；过 Senior 降 level。`;

    const userPrompt = `【候选人画像】
${profileSummary}

【已确认偏好摘要】
${preferenceSummary || '（暂无额外偏好）'}

【完整 JD】
标题：${jobTitle}
正文：${jobJd}`;

    const body = JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 220,
      stream: false,
      response_format: { type: 'json_object' },
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
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(`Groq HTTP ${res.statusCode}: ${data.slice(0, 180)}`));
            return;
          }
          const content = parsed?.choices?.[0]?.message?.content?.trim() || '';
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            reject(new Error('Groq returned no JSON object'));
            return;
          }
          const result = JSON.parse(jsonMatch[0]);
          const validated = validateDims(result);
          if (validated.migration === 'far') {
            validated.dims.tech = Math.min(validated.dims.tech, 35);
            validated.dims.delivery = Math.min(validated.dims.delivery, 35);
          }
          resolve({ ...validated, raw: content, model: GROQ_MODEL });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Groq timeout')));
    req.write(body);
    req.end();
  });
}

function createMatcher(options = {}) {
  const weights = { ...loadWeights(), ...(options.weightOverrides || {}) };
  const profileSummary = options.profileSummary || loadProfileSummary();
  let preferenceSummary = options.preferenceSummary || '';
  const groqKey = process.env.GROQ_API_KEY || '';

  console.log(`[quick-match] ✅ 三层评分；双轨阈值 EN≥${EN_THRESHOLD} / CN≥${CN_THRESHOLD}`);
  if (!groqKey) {
    console.log('[quick-match] ℹ️  未设置 GROQ_API_KEY，将跳过 Layer 2 六维打分');
  } else {
    console.log(`[quick-match] ⚡ Groq 六维打分（${GROQ_MODEL}，JD≤${JD_CHARS}字）`);
  }
  if (preferenceSummary) {
    console.log(`[quick-match] 📎 已注入偏好摘要 ${preferenceSummary.length} 字`);
  }

  return {
    setPreferenceSummary(text) {
      preferenceSummary = text || '';
    },

    layer1(job) {
      const hay = `${job.title || ''} ${job.contentText || ''}`.toLowerCase();
      const hits = hasCoreSkillHit(hay);
      return hits.filter((h) => !WEAK_ALONE.has(h.toLowerCase()));
    },

    eligibility(job, track = 'en') {
      return checkEligibility(job, track);
    },

    hardConditions(job) {
      return extractHardConditions(job);
    },

    async layer2(job, meta = {}) {
      const hard = extractHardConditions(job);
      hard.source_bucket = meta.source_bucket || hard.source_bucket;
      const eligRejected = !!meta.eligRejected;

      // Cached score (same job_id + jd hash + profile + prompt)
      if (meta.cachedScore && meta.cachedScore.dims) {
        const dims = meta.cachedScore.dims;
        let total = Number(meta.cachedScore.total_score);
        if (!Number.isFinite(total)) total = weightedScore(dims, weights);
        const recommendation_status = decideRecommendation({
          hard, dims, total, weights, eligRejected, scoreStatus: 'cached',
        });
        return {
          score: total,
          dims,
          hard,
          reason: meta.cachedScore.reason || '缓存分',
          migration: meta.cachedScore.migration || '',
          recommendation_status,
          score_status: 'cached',
          score_error: null,
          skipped: false,
          prompt_version: PROMPT_VERSION,
          profile_version: PROFILE_VERSION,
        };
      }

      if (!groqKey) {
        // No fake numeric scores — unscored goes to verify queue
        const dims = null;
        const recommendation_status = decideRecommendation({
          hard, dims: {}, total: 0, weights, eligRejected, scoreStatus: 'skipped',
        });
        return {
          score: null,
          dims: {},
          hard,
          reason: '未配置 GROQ_API_KEY，未评分',
          migration: '',
          recommendation_status,
          score_status: 'skipped',
          score_error: 'GROQ_API_KEY missing',
          skipped: true,
          prompt_version: PROMPT_VERSION,
          profile_version: PROFILE_VERSION,
        };
      }

      const jd = String(job.contentText || '').slice(0, JD_CHARS);
      try {
        const { dims, reason, migration, raw, model } = await groqMultiDimScore(
          job.title, jd, profileSummary, preferenceSummary, groqKey
        );
        let total = weightedScore(dims, weights);
        if (typeof meta.eligBoost === 'number' && meta.eligBoost) {
          total = Math.max(0, Math.min(100, total + Math.round(meta.eligBoost * 0.35)));
        }
        if (migration === 'far' && total > 35) total = 35;

        const recommendation_status = decideRecommendation({
          hard, dims, total, weights, eligRejected, scoreStatus: 'ok',
        });

        return {
          score: total,
          dims,
          hard,
          reason,
          migration,
          recommendation_status,
          score_status: 'ok',
          score_error: null,
          skipped: false,
          raw,
          model: model || GROQ_MODEL,
          prompt_version: PROMPT_VERSION,
          profile_version: PROFILE_VERSION,
        };
      } catch (err) {
        console.log(`[quick-match] ⚠️  Groq 失败（${err.message}）→ score_status=error，不给假分`);
        const recommendation_status = decideRecommendation({
          hard, dims: {}, total: 0, weights, eligRejected, scoreStatus: 'error',
        });
        return {
          score: null,
          dims: {},
          hard,
          reason: `评分失败: ${err.message}`,
          migration: '',
          recommendation_status,
          score_status: 'error',
          score_error: String(err.message || err).slice(0, 500),
          skipped: true,
          prompt_version: PROMPT_VERSION,
          profile_version: PROFILE_VERSION,
        };
      }
    },

    thresholdFor(track) {
      return track === 'cn' ? CN_THRESHOLD : EN_THRESHOLD;
    },

    get weights() { return weights; },
    get threshold() { return EN_THRESHOLD; },
    get enThreshold() { return EN_THRESHOLD; },
    get cnThreshold() { return CN_THRESHOLD; },
    get l1MinHits() { return L1_MIN_HITS; },
  };
}

module.exports = {
  createMatcher,
  checkEligibility,
  extractHardConditions,
  weightedScore,
  decideRecommendation,
  validateDims,
  CORE_SKILL_KEYWORDS,
  EN_THRESHOLD,
  CN_THRESHOLD,
  GROQ_MODEL,
  PROMPT_VERSION,
  PROFILE_VERSION,
  loadWeights,
};
