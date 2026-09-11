/**
 * quick-match.js — 两层极速相关性判断
 * ─────────────────────────────────────────────────────────────────
 * Layer 1 (0ms)  : 从 config/my-profile.md 自动提取关键词，做文本粗筛
 * Layer 2 (1-2s) : Groq API 极速打分（仅对通过 Layer 1 的帖子）
 *
 * 设计原则：
 *   - 与现有全量 LLM 评分系统（score-domestic.js）完全独立
 *   - 不写数据库、不改任何现有文件
 *   - Groq 免费额度完全够用（每分钟 30 次请求）
 *
 * 环境变量：
 *   GROQ_API_KEY          — Groq 密钥（Layer 2 必需；不填则跳过 Layer 2）
 *   RADAR_SCORE_THRESHOLD — Groq 分数阈值，默认 55（0-100）
 *   RADAR_L1_MIN_HITS     — Layer 1 最少命中词数，默认 1
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');

// ─────────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────────
const PROFILE_PATH = path.join(__dirname, '..', 'config', 'my-profile.md');
const GROQ_ENDPOINT = 'api.groq.com';
const GROQ_PATH     = '/openai/v1/chat/completions';
// Groq 免费额度最快的小模型：llama-3.1-8b-instant（约 0.5-1s/次）
// 如需更准确可换 llama-3.3-70b-versatile（约 1-2s/次，仍免费）
const GROQ_MODEL    = process.env.GROQ_QUICK_MODEL || 'llama-3.1-8b-instant';
const SCORE_THRESHOLD = parseInt(process.env.RADAR_SCORE_THRESHOLD || '55', 10);
const L1_MIN_HITS     = parseInt(process.env.RADAR_L1_MIN_HITS    || '1',  10);

// ─────────────────────────────────────────────────────────────────
// Layer 1：从画像文件自动提取关键词
// ─────────────────────────────────────────────────────────────────

/** 内置兜底关键词（画像文件缺失时使用） */
const FALLBACK_KEYWORDS = [
  // 远程条件
  '远程', 'remote', 'wfh', 'work from home', 'distributed', 'anywhere', 'full-time remote',
  '全职', 'full-time',
  // 地区偏好
  '台湾', '台灣', '跨境', '出海', '海外', '香港', '澳门', '新加坡',
  'taiwan', 'hong kong', 'hk', 'singapore', 'sea', 'apac',
  // AI 自动化核心（Iris 最强项）
  'n8n', 'dify', 'make', 'zapier', 'langgraph', 'langchain', 'flowise',
  'ai automation', 'workflow automation', 'ai agent', 'agent',
  'ai工作流', '自动化', '工作流', 'ai自动化', 'rpa',
  // LLM / AI 开发
  'llm', 'openai', 'claude', 'deepseek', 'prompt', 'rag', 'vector',
  '大模型', 'ai开发', 'ai应用', 'prompt工程',
  // Python & 全栈
  'python', 'fastapi', 'react', 'next.js', 'nextjs', 'typescript',
  'full-stack', 'fullstack', 'full stack', '全栈',
  // B2B 获客
  'b2b', 'lead generation', 'lead gen', 'apollo', 'outreach',
  'linkedin', 'cold email', '获客', '线索',
  // 跨境电商
  '电商', 'e-commerce', 'ecommerce', 'shopify', 'amazon', 'tiktok shop',
  '跨境电商', 'cross-border', 'lazada', 'shopee', '千川', '抖店',
  // 飞书 / 协作工具集成
  '飞书', 'feishu', 'lark', 'notion', 'slack bot', 'webhook',
  // 数据分析
  '数据', 'data', 'sql', 'pandas', 'analyst', 'analytics', 'dashboard',
  // 运营类
  '运营', 'operations', 'ops', '数据运营',
];

/**
 * 读取画像文件，提取有意义的关键词。
 * 策略：取所有中英文"词"，过滤掉停用词和太短的词。
 * 返回 Set<string>（全小写）
 */
function loadProfileKeywords() {
  const keywords = new Set(FALLBACK_KEYWORDS.map(k => k.toLowerCase()));

  if (!fs.existsSync(PROFILE_PATH)) {
    console.log('[quick-match] ⚠️  未找到 config/my-profile.md，使用内置兜底关键词');
    return keywords;
  }

  const text = fs.readFileSync(PROFILE_PATH, 'utf8');

  // ── 中文词提取：提取长度 ≥ 2 的中文短语（去掉纯标点和数字段）
  const chineseTerms = text.match(/[\u4e00-\u9fa5]{2,10}/g) || [];

  // ── 英文词提取：字母 + 数字组合，长度 ≥ 3
  const englishTerms = text.match(/[a-zA-Z][a-zA-Z0-9#+\-.]{2,30}/g) || [];

  // ── 中文停用词（结构性词，不代表技能/行业）
  const CHINESE_STOP = new Set([
    '工作', '经验', '技能', '项目', '我的', '简历', '候选', '求职',
    '负责', '参与', '完成', '实现', '能力', '相关', '业务', '主要',
    '设计', '开发', '产品', '团队', '内容', '公司', '管理', '分析',
    '用户', '系统', '平台', '服务', '建设', '优化', '提升', '支持',
    '工具', '以上', '其他', '功能', '数据', '处理', '解决', '问题',
    '方案', '结果', '文档', '报告', '沟通', '协调', '学习', '培训',
  ]);

  chineseTerms.forEach(t => {
    if (!CHINESE_STOP.has(t)) keywords.add(t.toLowerCase());
  });

  // ── 英文停用词
  const ENGLISH_STOP = new Set([
    'and', 'the', 'with', 'for', 'from', 'that', 'this', 'are', 'was',
    'have', 'has', 'had', 'will', 'been', 'more', 'also', 'such', 'than',
    'its', 'can', 'our', 'your', 'their', 'not', 'but', 'you',
  ]);

  englishTerms.forEach(t => {
    const lower = t.toLowerCase();
    if (!ENGLISH_STOP.has(lower) && lower.length >= 3) keywords.add(lower);
  });

  console.log(`[quick-match] ✅ 从画像提取 ${keywords.size} 个关键词`);
  return keywords;
}

// ─────────────────────────────────────────────────────────────────
// Layer 2：Groq 极速打分
// ─────────────────────────────────────────────────────────────────

/**
 * 读取画像摘要（前 1200 字符，用于 Groq prompt）
 * 减少 token 消耗，打分更快
 */
function loadProfileSummary() {
  if (!fs.existsSync(PROFILE_PATH)) return '远程工作求职者，寻找远程全职机会';
  const raw = fs.readFileSync(PROFILE_PATH, 'utf8');
  // 取前 1200 字符作为摘要（大约 300-500 token）
  return raw.slice(0, 1200).trim();
}

/**
 * 调用 Groq API 进行极速打分。
 * 只返回 0-100 分和一句话理由，不做全量分析。
 *
 * @param {string} jobTitle
 * @param {string} jobSnippet - 正文前 400 字符
 * @param {string} profileSummary
 * @param {string} groqKey
 * @returns {Promise<{score: number, reason: string}>}
 */
function groqQuickScore(jobTitle, jobSnippet, profileSummary, groqKey) {
  return new Promise((resolve, reject) => {
    const systemPrompt = `你是求职相关性判断助手。
根据候选人画像，判断一条招聘帖子与候选人的相关性。
只输出纯 JSON，不要任何解释文字：{"score": 0到100的整数, "reason": "15字以内说明"}
score 含义：0=完全无关, 30=弱相关, 55=可能合适, 75=比较匹配, 90+=高度匹配`;

    const userPrompt = `【候选人画像摘要】
${profileSummary}

【招聘帖子】
标题：${jobTitle}
内容：${jobSnippet}

请输出 JSON：`;

    const body = JSON.stringify({
      model:       GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature:  0.1,   // 低随机性，输出更稳定
      max_tokens:   60,     // 只需要 JSON，极省 token
      stream:       false,
    });

    const options = {
      hostname: GROQ_ENDPOINT,
      path:     GROQ_PATH,
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed   = JSON.parse(data);
          const content  = parsed?.choices?.[0]?.message?.content?.trim() || '{}';
          // 提取 JSON（Groq 偶尔会在前后加空行）
          const jsonMatch = content.match(/\{[\s\S]*?\}/);
          const result    = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
          resolve({
            score:  typeof result.score  === 'number' ? Math.round(result.score) : 0,
            reason: typeof result.reason === 'string' ? result.reason : '',
          });
        } catch (e) {
          // 解析失败时给一个中立分数而不是崩溃
          resolve({ score: 50, reason: '解析失败，按中立分处理' });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Groq timeout')));
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────
// 导出
// ─────────────────────────────────────────────────────────────────

/**
 * 初始化匹配器（在脚本启动时调用一次，避免每条帖子都重新读文件）。
 * 返回 matcher 对象，包含两个方法。
 */
function createMatcher() {
  const profileKeywords = loadProfileKeywords();
  const profileSummary  = loadProfileSummary();
  const groqKey         = process.env.GROQ_API_KEY || '';

  if (!groqKey) {
    console.log('[quick-match] ℹ️  未设置 GROQ_API_KEY，将跳过 Layer 2 打分（仅关键词过滤）');
  } else {
    console.log(`[quick-match] ⚡ Groq 打分已启用（模型：${GROQ_MODEL}，阈值：${SCORE_THRESHOLD}）`);
  }

  return {
    /**
     * Layer 1：关键词粗筛。
     * 返回命中的关键词列表；空数组 = 未通过。
     */
    layer1(job) {
      const hay = (job.title + ' ' + job.contentText).toLowerCase();
      const hits = [];
      for (const kw of profileKeywords) {
        if (hay.includes(kw)) hits.push(kw);
        if (hits.length >= 10) break; // 超过 10 个就够了，不再继续
      }
      return hits;
    },

    /**
     * Layer 2：Groq 极速打分（Layer 1 通过后才调用）。
     * 返回 { score, reason, skipped }
     *   skipped=true 表示没有 API key，跳过了这一层
     */
    async layer2(job) {
      if (!groqKey) return { score: 100, reason: '未配置 Groq，直接通过', skipped: true };

      const snippet = job.contentText.slice(0, 400);
      try {
        const result = await groqQuickScore(job.title, snippet, profileSummary, groqKey);
        return { ...result, skipped: false };
      } catch (err) {
        // Groq 调用失败不影响推送（降级为宽松通过）
        console.log(`[quick-match] ⚠️  Groq 调用失败（${err.message}），降级为通过`);
        return { score: 60, reason: 'Groq 调用失败，降级', skipped: true };
      }
    },

    get threshold() { return SCORE_THRESHOLD; },
    get l1MinHits()  { return L1_MIN_HITS; },
  };
}

module.exports = { createMatcher };
