/**
 * 对远程.work 接入的岗位做本地确定性打分（无需 LLM / 无需 API 余额）。
 * 结合 config/my-profile.md 的画像，把 match_score 写回 jobs 表，
 * 供 scripts/generate-pool-view.js 生成 big-pool-view.html。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Parser = require('rss-parser');

const FEED_URL = 'https://yuancheng.work/feed';
const SOURCE = 'yuancheng_work';
const root = path.resolve(__dirname, '..');

// 与简历强匹配的技能（AI 应用 / 全栈 / 自动化 / 数据）
const STRONG = [
  ['python', 'Python'], ['fastapi', 'FastAPI'], ['langgraph', 'LangGraph'], ['langchain', 'LangChain'],
  ['agent', 'Agent'], ['rag', 'RAG'], ['llm', 'LLM'], ['大模型', '大模型'], ['prompt', 'Prompt工程'],
  ['ai 应用', 'AI应用'], ['ai应用', 'AI应用'], ['ai 开发', 'AI开发'], ['ai开发', 'AI开发'],
  ['ai 工作流', 'AI工作流'], ['工作流', '工作流'], ['自动化', '自动化'], ['全栈', '全栈'],
  ['后端', '后端'], ['微服务', '微服务'], ['dify', 'Dify'], ['n8n', 'n8n'],
  ['react', 'React'], ['next.js', 'Next.js'], ['typescript', 'TypeScript'], ['tailwind', 'Tailwind'],
  ['openai', 'OpenAI'], ['claude', 'Claude'], ['deepseek', 'DeepSeek'],
  ['pandas', 'pandas'], ['numpy', 'numpy'], ['数据分析', '数据分析'],
  ['向量数据库', '向量数据库'], ['知识库', '知识库'], ['memory', 'Memory'],
  ['需求分析', '需求分析'], ['产品设计', '产品设计'], ['prd', 'PRD'], ['方案设计', '方案设计'],
];

// 可迁移 / 部分匹配
const PARTIAL = [
  ['java', 'Java'], ['go', 'Go'], ['c++', 'C++'], ['c/c++', 'C++'],
  ['产品经理', '产品经理'], ['figma', 'Figma'], ['axure', 'Axure'],
  ['分布式', '分布式系统'], ['高并发', '高并发'], ['redis', 'Redis'], ['mysql', 'MySQL'],
  ['消息队列', '消息队列'], ['多模态', '多模态'], ['nlp', 'NLP'],
  ['机器学习', '机器学习'], ['深度学习', '深度学习'], ['工具调用', 'Tool Calling'],
];

// 明确不匹配的方向
const MISMATCH = [
  ['报关', '报关'], ['单证', '单证'], ['客服', '客服'], ['物流', '物流'],
  ['安卓', '安卓测试'], ['android', '安卓测试'], ['测试工程师', '测试'], ['测试', '测试'],
  ['ui/ux', 'UI/UX设计'], ['ui', 'UI设计'], ['ux', 'UX设计'], ['设计师', '设计'],
  ['php', 'PHP'], ['thinkphp', 'ThinkPHP'], ['cms', 'CMS'],
];

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#8211;|&ndash;/gi, '-')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeSql(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function countHits(text, list) {
  const t = text.toLowerCase();
  const hits = [];
  for (const [kw, label] of list) {
    if (t.includes(kw)) hits.push(label);
  }
  return [...new Set(hits)];
}

function extractMinYears(text) {
  // 抓取 "N年" / "N 年"，排除明显无关的（这里直接取最大数字作为经验要求近似）
  const matches = [...text.matchAll(/(\d+)\s*年/g)].map(m => parseInt(m[1], 10));
  if (matches.length === 0) return null;
  // 经验要求通常以 "N年以上" / "N年经验" 出现，取合理范围内的最大值
  return Math.max(...matches.filter(n => n <= 20));
}

function scoreJob(title, content) {
  const text = `${title} ${content}`;
  const strongHits = countHits(text, STRONG);
  const partialHits = countHits(text, PARTIAL);
  const mismatchHits = countHits(text, MISMATCH);

  const strongScore = Math.min(strongHits.length * 8, 48);
  const partialScore = Math.min(partialHits.length * 3, 9);

  let direction = 0;
  const isAI = /ai|agent|rag|大模型|工作流|自动化|langchain|langgraph/i.test(text);
  const isDev = /全栈|后端|前端|开发|python|react|next\.js|typescript/i.test(text);
  const isData = /数据分析|数据|pandas|numpy|sql|报表/i.test(text);
  const isProduct = /产品经理|prd|需求分析|产品设计/i.test(text);
  if (isAI || isDev) direction = 14;
  else if (isData) direction = 10;
  else if (isProduct) direction = 6;

  const remote = 8; // 该源均为远程岗位

  let expPenalty = 0;
  const years = extractMinYears(text);
  if (years !== null) {
    if (years >= 5) expPenalty = -15;
    else if (years >= 4) expPenalty = -12;
    else if (years >= 3) expPenalty = -9;
    else if (years >= 2) expPenalty = -5;
  }
  if (/高级|资深|senior/i.test(text)) expPenalty -= 6;

  let score = strongScore + partialScore + direction + remote + expPenalty;
  score = Math.max(0, Math.min(100, score));

  if (mismatchHits.length > 0) score = Math.min(score, 40);

  let level;
  if (score >= 75) level = '强烈推荐';
  else if (score >= 60) level = '推荐';
  else if (score >= 45) level = '考虑';
  else level = '不推荐';

  return {
    score,
    level,
    strongHits,
    partialHits,
    mismatchHits,
    skillMatches: strongHits,
    skillGaps: partialHits.filter(x => !strongHits.includes(x)),
  };
}

async function main() {
  const parser = new Parser({
    customFields: { item: [['content:encoded', 'contentEncoded']] },
  });

  console.log(`🔄 抓取并打分 ${FEED_URL} ...\n`);
  const feed = await parser.parseURL(FEED_URL);
  const items = feed.items || [];

  const statements = [];

  for (const item of items) {
    const title = (item.title || '').trim();
    const contentRaw = item.contentEncoded || item['content:encoded'] || item.content || '';
    const contentClean = stripHtml(contentRaw);

    const r = scoreJob(title, contentClean);

    const postId = (item.guid || '').match(/[?&]p=(\d+)/);
    const dedupKey = `${SOURCE}_p${postId ? postId[1] : item.link}`;

    const matches = r.strongHits.join('、');
    const gaps = r.partialHits.join('、');
    const rec = [
      '【✅远程】',
      `${r.level}（${r.score}分）`,
      matches ? `【匹配】${matches}` : '',
      gaps ? `【缺口/可迁移】${gaps}` : '',
      r.mismatchHits.length ? `【方向不符】${r.mismatchHits.join('、')}` : '',
    ].filter(Boolean).join(' | ');

    const sql = `UPDATE jobs SET
        match_score = ${r.score},
        intent = 'hiring',
        china_eligible = 'true',
        recommendation_text = ${escapeSql(rec.slice(0, 1200))}
      WHERE dedup_key = ${escapeSql(dedupKey)};`;

    statements.push(sql);
    console.log(`  ${String(r.score).padStart(3)}分 [${r.level}] ${title.slice(0, 40)}`);
  }

  const tmpFile = path.join(root, 'output', 'tmp_yuancheng_score.sql');
  fs.writeFileSync(tmpFile, statements.join('\n'), 'utf8');
  execSync(`docker exec -i remote-job-monitor-postgres psql -U job_monitor -d job_monitor < "${tmpFile}"`, {
    stdio: 'inherit',
  });
  fs.unlinkSync(tmpFile);

  console.log('\n✅ 打分已写回数据库。');
}

main().catch(err => {
  console.error('❌ 打分失败:', err.message);
  process.exit(1);
});
