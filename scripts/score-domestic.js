const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) return;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  });
}

const API_KEY = process.env.DOMESTIC_LLM_API_KEY;
const BASE_URL = process.env.DOMESTIC_LLM_BASE_URL || 'https://api.deepseek.com/v1';
const MODEL = process.env.DOMESTIC_LLM_MODEL || 'deepseek-chat';
const BATCH_SIZE = parseInt(process.env.SCORE_BATCH_SIZE || '10', 10);
const DELAY_MS = parseInt(process.env.SCORE_DELAY_MS || '1000', 10);

if (!API_KEY || API_KEY === '你的API Key填这里') {
  console.error('\n❌ 错误：请先在 .env 文件中填写 DOMESTIC_LLM_API_KEY\n');
  console.error('   参考 .env.example 文件中的配置说明\n');
  process.exit(1);
}

// 加载个人画像
const profilePath = path.join(__dirname, '..', 'config', 'my-profile.md');
let MY_PROFILE = '';
if (fs.existsSync(profilePath)) {
  MY_PROFILE = fs.readFileSync(profilePath, 'utf8').trim();
  console.log('✅ 已加载个人画像: config/my-profile.md');
} else {
  console.log('⚠️ 未找到个人画像文件，使用通用打分模式');
}

const SYSTEM_PROMPT = `你是求职者的专属远程工作匹配顾问。你必须根据求职者的真实背景，对每条JD进行个性化评估。

【求职者背景（必须基于此评估）】
${MY_PROFILE || '（未提供个人画像，请基于通用标准评估）'}

【意图识别 — 这是最关键的判断，出错会导致整个评分无效】
你必须仔细分析帖子的语义，而不是只看标题关键词。请严格区分：

❌ 以下情况绝对不是 "hiring"，必须判为 "sharing"：
  - "试用一下我的XX"、"邀请大家体验"、"求反馈/求测试"、"我做了个XX工具"、"分享我的XX"
  - "给大家看看"、"安利一个"、"推荐我的"、"介绍我的项目"
  - 帖子作者在推销/展示自己做的产品，没有薪资、没有JD、没有明确的用人需求
  - 经典误判案例："想找几位大神来试用一下我的语音工具" → 这是 sharing（邀请试用自己产品），不是 hiring

❌ 以下情况必须判为 "seeking"：
  - "求职"、"找兼职/找全职"、"接单"、"求合作机会"、"个人承接"、"找远程工作"
  - 帖子是乙方在推销自己，不是甲方在招人

✅ 只有以下情况才是 "hiring"：
  - 甲方明确招聘/发包/找外包，有角色需求、技能要求、薪资范围或预算
  - 关键词："招聘"、"招人"、"寻XX开发者"、"找外包"、"项目寻人"、"急招"、"诚聘"

- "discussing"：行业讨论、技术咨询、职业规划、经验分享（无招聘/求职意图）

【远程/坐班检测 — 对求职者很重要，ta只找远程工作】
- 帖子中明确出现 "base北京/base深圳/base上海/base杭州/base广州" 且没有同时提到 "远程/remote/不限地点/居家" → is_remote = false，match_score 应大幅扣分
- 出现 "坐班"、"onsite"、"on-site"、"线下办公"、"需到岗"、"不接受远程" → is_remote = false
- 出现 "远程"、"remote"、"不限地点"、"anywhere"、"work from home"、"居家办公"、"WFH" → is_remote = true
- 如果完全没有提到远程或坐班 → is_remote = "unclear"，国内社区帖子默认可疑但不确定
- 如果 is_remote = false，match_score 上限 30 分（求职者不找坐班工作），且 recommendation_text 必须说明"需坐班"

【经验年限提取 — 认真读帖子内容】
- 明确出现的数字如 "3年以上"、"5年+"、"2-5年" → 分别填入 experience_years_min/max
- "应届/校招/实习/不限经验" → experience_years_min = 0
- 没有明确提及 → null
- 注意区分"公司成立X年"等无关数字

【个性化匹配分 + 打分拆解 — 必须输出 score_breakdown】
match_score 按以下步骤计算，必须在 score_breakdown 中逐项列出：

1. intent_base: hiring=60, seeking=15, sharing=10, discussing=5, unknown=10
2. skill_match_bonus: 
   - 每条核心技能直接匹配（n8n/Dify/Coze/AI Agent/Python自动化/RPA/数据管道）→ +8分/条，上限40
   - 每条可迁移技能匹配（SQL/BI/电商/外贸/飞书集成）→ +5分/条，上限25
   - 每条弱相关匹配（Python通用/JS通用/数据分析通用）→ +3分/条，上限15
3. remote_bonus: 明确远程 → +10，没提 → 0，明确坐班 → -40
4. experience_penalty: JD要求5年以上但求职者经验不足 → -15；要求senior但求职者为mid-level → -10
5. direction_match: 岗位方向与求职者目标方向（AI自动化/工作流/数据工程）一致 → +10

最终 match_score = intent_base + skill_match_bonus + remote_bonus + experience_penalty + direction_match
然后 clamp 到 0-100。非hiring的intent上限30分。

【必须输出的JSON格式 — 一个字段都不能少】
{
  "intent": "hiring | seeking | sharing | discussing | unknown",
  "china_eligible": "true | false | unclear",
  "china_eligibility_reason": "简短说明",
  "region_bucket": "domestic | global | unknown",
  "is_remote": "true | false | unclear",
  "on_site_note": "坐班证据简述" 或 null,
  "timezone_overlap": "无时差问题" 或 null,
  "experience_years_min": 数字或null,
  "experience_years_max": 数字或null,
  "seniority": "junior | mid | senior | unknown",
  "skills": ["JD中提到的技能标签"],
  "match_score": 0到100的整数,
  "trust_score": 0到100的整数,
  "score_breakdown": "逐项列出评分过程，如：意图基础分60 + 技能匹配(核心2条+16,可迁移1条+5) + 远程+10 + 经验扣分0 + 方向匹配+10 = 最终分。必须写清楚加减的来源",
  "skill_matches": ["求职者已有且JD需要的技能/经验"],
  "skill_gaps": ["JD需要但求职者缺失的技能，标注'可迁移'或'需学习'"],
  "resume_tailoring_tips": "针对此JD的简历/投递策略（30字内）",
  "recommendation_text": "一句话评估（含匹配度和是否推荐投递）"
}`;

function queryDb(sql) {
  const cleanSql = sql.replace(/\n/g, ' ').replace(/"/g, '\\"');
  const cmd = `docker exec -i remote-job-monitor-postgres psql -U job_monitor -d job_monitor -A -F "||SEP||" -c "${cleanSql}"`;
  const result = execSync(cmd, { encoding: 'utf8' });
  const lines = result.trim().split('\n').filter(l => l && !l.startsWith('(') && !l.match(/^\d+ rows?$/));
  if (lines.length < 2) return [];
  const headers = lines[0].split('||SEP||').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split('||SEP||');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (values[i] || '').trim(); });
    return obj;
  });
}

function updateDb(id, result) {
  const skills = JSON.stringify(result.skills || []).replace(/'/g, "''");
  // 将个性化分析字段合并进 recommendation_text（便于看板直接查看）
  const matches = (result.skill_matches || []).join('；');
  const gaps = (result.skill_gaps || []).join('；');
  const tips = result.resume_tailoring_tips || '';
  const breakdown = result.score_breakdown || '';
  const remoteNote = result.is_remote === 'false'
    ? `【⚠️需坐班】${result.on_site_note || '帖子要求线下办公'}`
    : result.is_remote === 'true' ? '【✅远程】' : '【远程情况不明】';
  const fullRec = [
    remoteNote,
    result.recommendation_text || '',
    matches ? `【匹配技能】${matches}` : '',
    gaps ? `【技能缺口】${gaps}` : '',
    tips ? `【投递建议】${tips}` : '',
    breakdown ? `【评分明细】${breakdown}` : '',
  ].filter(Boolean).join(' | ');
  const rec = fullRec.replace(/'/g, "''").slice(0, 1500);
  const reason = (result.china_eligibility_reason || '').replace(/'/g, "''").slice(0, 500);
  const tz = result.timezone_overlap ? `'${String(result.timezone_overlap).replace(/'/g, "''").slice(0, 200)}'` : 'NULL';
  const eMin = result.experience_years_min != null ? Number(result.experience_years_min) : 'NULL';
  const eMax = result.experience_years_max != null ? Number(result.experience_years_max) : 'NULL';

  const sql = `UPDATE jobs SET
    intent = '${result.intent}',
    china_eligible = '${result.china_eligible}',
    china_eligibility_reason = '${reason}',
    region_bucket = '${result.region_bucket || 'unknown'}',
    timezone_overlap = ${tz},
    experience_years_min = ${eMin},
    experience_years_max = ${eMax},
    seniority = '${result.seniority || 'unknown'}',
    skills = ARRAY[${(result.skills || []).map(s => `'${String(s).replace(/'/g, "''")}'`).join(',')}]::text[],
    match_score = ${Math.max(0, Math.min(100, Math.round(Number(result.match_score) || 0)))},
    trust_score = ${Math.max(0, Math.min(100, Math.round(Number(result.trust_score) || 0)))},
    recommendation_text = '${rec}'
  WHERE id = '${id}';`;

  const cleanSql = sql.replace(/\n/g, ' ');
  execSync(`docker exec -i remote-job-monitor-postgres psql -U job_monitor -d job_monitor -c "${cleanSql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

async function callLLM(job) {
  const userContent = JSON.stringify({
    title: job.title,
    description: job.description_clean,
    source: job.source,
  });

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 1000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = (data.choices?.[0]?.message?.content || '').trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');

  return JSON.parse(text);
}

const VALID_INTENTS = ['hiring', 'sharing', 'seeking', 'discussing', 'unknown'];
const VALID_CHINA = ['true', 'false', 'unclear'];
const VALID_SENIORITY = ['junior', 'mid', 'senior', 'unknown'];
const VALID_REMOTE = ['true', 'false', 'unclear'];

function validate(result) {
  if (!VALID_INTENTS.includes(result.intent)) throw new Error(`无效 intent: ${result.intent}`);
  if (!VALID_CHINA.includes(result.china_eligible)) throw new Error(`无效 china_eligible: ${result.china_eligible}`);
  if (!VALID_SENIORITY.includes(result.seniority)) result.seniority = 'unknown';
  if (!VALID_REMOTE.includes(result.is_remote)) result.is_remote = 'unclear';
  if (!['domestic', 'global', 'eu', 'apac', 'sg_hk', 'us_ca', 'unknown'].includes(result.region_bucket)) result.region_bucket = 'unknown';
  // 代码级强制约束（不信任 LLM 的自我报告）
  if (result.intent !== 'hiring') result.match_score = Math.min(result.match_score || 0, 30);
  if (result.china_eligible === 'false') result.match_score = Math.min(result.match_score || 0, 20);
  // 明确坐班 → 上限 30 分
  if (result.is_remote === 'false') result.match_score = Math.min(result.match_score || 0, 30);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const marketFilter = args.includes('--global') ? 'global' : 'domestic';
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : BATCH_SIZE;
  const rescoreArg = args.find(a => a.startsWith('--rescore='));
  const rescoreId = rescoreArg ? rescoreArg.split('=')[1] : null;

  console.log(`\n🚀 国内 LLM 打分开始`);
  console.log(`   模型: ${MODEL} @ ${BASE_URL}`);
  console.log(`   目标市场: ${marketFilter === 'domestic' ? '🇨🇳 国内' : '🌍 国外'}`);
  console.log(`   每批数量: ${limit} 条`);
  if (rescoreId) console.log(`   🔄 重打分模式: ${rescoreId}`);
  console.log('');

  const whereClause = rescoreId
    ? `id = '${rescoreId}'`
    : `match_score IS NULL AND market = '${marketFilter}'`;

  const jobs = queryDb(`
    SELECT id, title, source, market,
      LEFT(description_clean, 800) as description_clean
    FROM jobs
    WHERE ${whereClause}
    ORDER BY first_seen_at DESC
    LIMIT ${limit}
  `);

  if (jobs.length === 0) {
    console.log(`✅ 没有待打分的 ${marketFilter} 数据了！\n`);
    return;
  }

  console.log(`📋 找到 ${jobs.length} 条待打分数据\n`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const prefix = `[${i + 1}/${jobs.length}]`;
    const shortTitle = (job.title || '').slice(0, 40);

    try {
      const raw = await callLLM(job);
      const result = validate(raw);
      updateDb(job.id, result);
      const intentEmoji = { hiring: '📋', sharing: '💡', seeking: '🙋', discussing: '💬' }[result.intent] || '❓';
      const remoteTag = result.is_remote === 'true' ? '🏠远程' : result.is_remote === 'false' ? '🏢坐班' : '❓远程不明';
      const matchCount = (result.skill_matches || []).length;
      const gapCount = (result.skill_gaps || []).length;
      const tip = result.resume_tailoring_tips || '';
      const extra = matchCount + gapCount > 0 ? ` 匹配${matchCount}/缺口${gapCount}` : '';
      console.log(`${prefix} ✅ ${intentEmoji}[${result.match_score}分] ${remoteTag} ${shortTitle} ${extra}`);
      if (result.score_breakdown) console.log(`       🧮 ${result.score_breakdown}`);
      if (tip) console.log(`       💡 ${tip}`);
      success++;
    } catch (err) {
      console.log(`${prefix} ❌ 失败: ${shortTitle} → ${err.message.slice(0, 80)}`);
      failed++;
    }

    if (i < jobs.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\n📊 完成！成功 ${success} 条，失败 ${failed} 条`);
  console.log(`   运行 npm run view 查看最新看板\n`);
}

main().catch(err => {
  console.error('❌ 运行出错:', err.message);
  process.exit(1);
});
