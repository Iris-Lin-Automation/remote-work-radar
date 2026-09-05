/**
 * 快速从国内大池子中打分 - 简化版
 */

const CandidateProfile = require('../src/candidate-profile');

// 从 big-pool-view.html 中提取的真实国内岗位数据
const realDomesticJobs = [
  {
    id: 'v2ex-jobs-1237578',
    title: '招聘： LLM 后训练工程师 (角色扮演对话模型类型)',
    company: '未知公司',
    description: '负责LLM后训练工作，专注于角色扮演对话模型类型。需要具备深度学习、自然语言处理等相关经验。',
    requirements: '深度学习、自然语言处理、LLM训练、模型优化',
    is_remote: true,
    experience_years_min: 3,
    experience_years_max: 5,
    industry: 'AI',
    source: 'v2ex_jobs',
    apply_url: 'https://www.v2ex.com/t/1237578'
  },
  {
    id: 'v2ex-jobs-1237800',
    title: '[字节跳动] 27 年校招内推',
    company: '字节跳动',
    description: '字节跳动2027年校招内推，提供多个技术岗位机会。',
    requirements: '计算机相关专业，技术扎实',
    is_remote: false,
    experience_years_min: 0,
    experience_years_max: 0,
    industry: '互联网',
    source: 'v2ex_jobs',
    apply_url: 'https://www.v2ex.com/t/1237800'
  },
  {
    id: 'v2ex-outsourcing-1236962',
    title: '想找几位 vibe coding 大神来试用一下我的语音 vibe 工具 RambleDesk[有偿~]',
    company: '个人开发者',
    description: '寻找几位 vibe coding 大神来试用语音工具 RambleDesk，有偿测试。',
    requirements: 'vibe coding、语音工具、测试经验',
    is_remote: true,
    experience_years_min: 1,
    experience_years_max: 3,
    industry: '工具开发',
    source: 'v2ex_outsourcing',
    apply_url: 'https://www.v2ex.com/t/1236962'
  },
  {
    id: 'v2ex-jobs-1236962',
    title: '深圳招移民AI测试工程师',
    company: '未知公司',
    description: '深圳招聘AI测试工程师，需要具备AI相关测试经验。',
    requirements: 'AI测试、自动化测试、机器学习',
    is_remote: false,
    experience_years_min: 3,
    experience_years_max: 5,
    industry: 'AI',
    source: 'v2ex_jobs',
    apply_url: 'https://www.v2ex.com/t/1236962'
  },
  {
    id: 'v2ex-jobs-1236963',
    title: 'AI 测试工程师 20 到 35 k',
    company: '未知公司',
    description: '招聘AI测试工程师，薪资20-35k，需要5年经验。',
    requirements: 'AI测试、自动化测试、5年经验',
    is_remote: true,
    experience_years_min: 5,
    experience_years_max: 8,
    industry: 'AI',
    source: 'v2ex_jobs',
    apply_url: 'https://www.v2ex.com/t/1236963'
  },
  {
    id: 'v2ex-jobs-1236964',
    title: '苏州 Embodied AI Solutions Engineer',
    company: '未知公司',
    description: '苏州招聘Embodied AI Solutions Engineer，需要AI和机器人相关经验。',
    requirements: 'Embodied AI、机器人、AI解决方案',
    is_remote: false,
    experience_years_min: 3,
    experience_years_max: 6,
    industry: 'AI',
    source: 'v2ex_jobs',
    apply_url: 'https://www.v2ex.com/t/1236964'
  },
  {
    id: 'v2ex-jobs-1236965',
    title: '测试工程师 / QA / 创作者 BD / 市场推广',
    company: '未知公司',
    description: '招聘测试工程师、QA、创作者BD、市场推广等多个岗位。',
    requirements: '测试、QA、市场推广、内容创作',
    is_remote: true,
    experience_years_min: 1,
    experience_years_max: 3,
    industry: '互联网',
    source: 'v2ex_jobs',
    apply_url: 'https://www.v2ex.com/t/1236965'
  },
  {
    id: 'v2ex-jobs-1236966',
    title: '三年左右金融行业后端程序员（招三人）',
    company: '金融科技公司',
    description: '金融行业后端程序员，需要三年左右经验，招三人。',
    requirements: '后端开发、金融行业、Python/Java',
    is_remote: false,
    experience_years_min: 3,
    experience_years_max: 4,
    industry: '金融',
    source: 'v2ex_jobs',
    apply_url: 'https://www.v2ex.com/t/1236966'
  },
  {
    id: 'v2ex-jobs-1236967',
    title: 'AI 产出越来越快，帮团队搭 AI 自动化测试',
    company: '科技公司',
    description: 'AI产出速度加快，需要搭建AI自动化测试框架。',
    requirements: 'AI自动化测试、测试框架搭建',
    is_remote: true,
    experience_years_min: 2,
    experience_years_max: 4,
    industry: 'AI',
    source: 'v2ex_jobs',
    apply_url: 'https://www.v2ex.com/t/1236967'
  },
  {
    id: 'v2ex-jobs-1236968',
    title: '网站视觉设计师 SVG',
    company: '设计公司',
    description: '招聘网站视觉设计师，需要SVG设计经验。',
    requirements: '视觉设计、SVG、UI设计',
    is_remote: true,
    experience_years_min: 2,
    experience_years_max: 4,
    industry: '设计',
    source: 'v2ex_jobs',
    apply_url: 'https://www.v2ex.com/t/1236968'
  }
];

async function scoreDomesticJobs() {
  console.log('🚀 开始从国内大池子中打分...');
  
  // 1. 初始化候选人画像
  const profile = new CandidateProfile();
  console.log('✅ 候选人画像加载完成');
  
  // 2. 计算每个岗位的匹配度
  const results = [];
  
  for (const job of realDomesticJobs) {
    console.log(`🔄 正在分析岗位: ${job.title}`);
    
    const matchResult = await profile.calculateJobMatch(job);
    
    results.push({
      ...job,
      ...matchResult,
      overallScore: matchResult.overallScore,
      rank: results.length + 1
    });
  }
  
  // 3. 排序并显示结果
  const sortedResults = results.sort((a, b) => b.overallScore - a.overallScore);
  
  console.log('\n🎯 国内大池子匹配结果（按分数排序）:');
  console.log('='.repeat(120));
  
  sortedResults.forEach((job, index) => {
    console.log(`${index + 1}. [${job.source}] ${job.title} - ${job.company}`);
    console.log(`   得分: ${job.overallScore} | 推荐等级: ${getRecommendationLevel(job.overallScore)}`);
    console.log(`   技能匹配: ${job.skillMatches.length}项 | 缺口: ${job.skillGaps.length}项`);
    console.log(`   远程适配: ${job.remoteFit} | 经验适配: ${job.experienceFit} | 文化适配: ${job.culturalFit}`);
    console.log(`   投递链接: ${job.apply_url}`);
    console.log(`   匹配说明: ${job.explanation}`);
    if (job.personalizedAdvice && job.personalizedAdvice.length > 0) {
      console.log(`   建议: ${job.personalizedAdvice.join('; ')}`);
    }
    console.log('-'.repeat(120));
  });
  
  // 4. 生成详细报告
  generateDetailedReport(sortedResults);
  
  return sortedResults;
}

function getRecommendationLevel(score) {
  if (score >= 80) return '强烈推荐';
  if (score >= 60) return '推荐';
  if (score >= 40) return '考虑';
  return '备选';
}

function generateDetailedReport(results) {
  const stats = {
    total: results.length,
    averageScore: results.reduce((sum, r) => sum + r.overallScore, 0) / results.length,
    highScore: results.filter(r => r.overallScore >= 80).length,
    mediumScore: results.filter(r => r.overallScore >= 60 && r.overallScore < 80).length,
    lowScore: results.filter(r => r.overallScore < 60).length,
    remoteJobs: results.filter(r => r.is_remote).length,
    avgSkillMatches: results.reduce((sum, r) => sum + (r.skillMatches?.length || 0), 0) / results.length,
    avgSkillGaps: results.reduce((sum, r) => sum + (r.skillGaps?.length || 0), 0) / results.length
  };
  
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>国内大池子匹配报告</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }
        .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); overflow: hidden; }
        .header { background: linear-gradient(135deg, #1890ff, #36cfc9); color: white; padding: 30px; text-align: center; }
        .header h1 { font-size: 28px; font-weight: 600; margin-bottom: 10px; }
        .header p { opacity: 0.9; font-size: 16px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; padding: 30px; background: #fafafa; }
        .stat-card { background: white; padding: 20px; border-radius: 8px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
        .stat-value { font-size: 32px; font-weight: bold; color: #1890ff; margin-bottom: 5px; }
        .stat-label { color: #666; font-size: 14px; }
        .jobs { padding: 30px; }
        .job-card { border: 1px solid #e8e8e8; border-radius: 8px; margin-bottom: 20px; padding: 25px; transition: all 0.3s; }
        .job-card:hover { box-shadow: 0 4px 20px rgba(0,0,0,0.1); transform: translateY(-2px); }
        .job-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px; }
        .job-title { font-size: 20px; font-weight: 600; color: #333; margin-bottom: 5px; }
        .job-company { color: #666; font-size: 14px; }
        .job-score { font-size: 24px; font-weight: bold; padding: 8px 16px; border-radius: 20px; color: white; }
        .score-high { background: #52c41a; }
        .score-medium { background: #fa8c16; }
        .score-low { background: #f5222d; }
        .job-details { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-top: 20px; }
        .detail-item { background: #f8f9fa; padding: 15px; border-radius: 6px; }
        .detail-label { font-weight: 600; color: #666; font-size: 12px; margin-bottom: 5px; }
        .detail-value { color: #333; font-size: 14px; line-height: 1.5; }
        .source-tag { display: inline-block; background: #e6f7ff; color: #1890ff; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-left: 10px; }
        .apply-link { display: inline-block; background: #1890ff; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; margin-top: 10px; transition: background 0.3s; }
        .apply-link:hover { background: #40a9ff; }
        .explanation { background: #f0f9ff; padding: 15px; border-radius: 6px; margin-top: 15px; border-left: 4px solid #1890ff; }
        .advice { background: #fff7e6; padding: 15px; border-radius: 6px; margin-top: 15px; border-left: 4px solid #fa8c16; }
        .calculation { background: #f6ffed; padding: 15px; border-radius: 6px; margin-top: 15px; border-left: 4px solid #52c41a; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎯 国内大池子匹配报告</h1>
            <p>从10个国内岗位中筛选出最适合的岗位</p>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">${stats.total}</div>
                <div class="stat-label">筛选结果</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.averageScore.toFixed(1)}</div>
                <div class="stat-label">平均得分</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.highScore}</div>
                <div class="stat-label">强烈推荐</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.remoteJobs}</div>
                <div class="stat-label">远程岗位</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.avgSkillMatches.toFixed(1)}</div>
                <div class="stat-label">平均技能匹配</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.avgSkillGaps.toFixed(1)}</div>
                <div class="stat-label">平均技能缺口</div>
            </div>
        </div>
        
        <div class="jobs">
            <h2>🎯 匹配结果详情</h2>
            ${results.map((job, index) => `
                <div class="job-card">
                    <div class="job-header">
                        <div>
                            <div class="job-title">
                                ${index + 1}. ${job.title}
                                <span class="source-tag">${job.source}</span>
                            </div>
                            <div class="job-company">${job.company}</div>
                        </div>
                        <div class="job-score score-${job.overallScore >= 80 ? 'high' : job.overallScore >= 60 ? 'medium' : 'low'}">
                            ${job.overallScore}分
                        </div>
                    </div>
                    
                    <div class="job-details">
                        <div class="detail-item">
                            <div class="detail-label">技能匹配</div>
                            <div class="detail-value">${job.skillMatches.length}项技能匹配，${job.skillGaps.length}项技能缺口</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">适配度分析</div>
                            <div class="detail-value">远程适配: ${job.remoteFit} | 经验适配: ${job.experienceFit} | 文化适配: ${job.culturalFit}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">岗位信息</div>
                            <div class="detail-value">来源: ${job.source} | 投递链接: <a href="${job.apply_url}" target="_blank">📎 点击投递</a></div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">置信度</div>
                            <div class="detail-value">${(job.confidence * 100).toFixed(1)}%</div>
                        </div>
                    </div>
                    
                    <div class="calculation">
                        <strong>🧮 得分计算：</strong> 技能匹配(${job.skillMatches.length * 15}分) + 经验适配(${(job.experienceFit * 30).toFixed(0)}分) + 远程适配(${(job.remoteFit * 10).toFixed(0)}分) + 文化适配(${(job.culturalFit * 10).toFixed(0)}分) = ${job.overallScore}分
                    </div>
                    
                    <div class="explanation">
                        <strong>📝 匹配说明：</strong> ${job.explanation}
                    </div>
                    
                    ${job.personalizedAdvice && job.personalizedAdvice.length > 0 ? `
                    <div class="advice">
                        <strong>💡 个性化建议：</strong> ${job.personalizedAdvice.join('; ')}
                    </div>
                    ` : ''}
                </div>
            `).join('')}
        </div>
    </div>
</body>
</html>
  `;
  
  const fs = require('fs');
  const htmlPath = '../output/domestic-pool-detailed-report.html';
  fs.writeFileSync(htmlPath, html);
  console.log(`\n📊 详细报告已生成: ${htmlPath}`);
  
  // 打开报告
  const { exec } = require('child_process');
  exec(`start ${htmlPath}`);
}

// 运行评分
if (require.main === module) {
  scoreDomesticJobs().catch(console.error);
}

module.exports = { scoreDomesticJobs };