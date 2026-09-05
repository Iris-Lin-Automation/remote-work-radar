/**
 * 简化版测试 - 快速验证匹配逻辑
 */

const CandidateProfile = require('../src/candidate-profile');

// 模拟岗位数据
const mockJobs = [
  {
    id: 'job-1',
    title: 'AI自动化工程师',
    company: '跨境电商科技公司',
    description: '负责AI自动化流程设计和开发，需要Python和LangGraph经验',
    requirements: 'Python, FastAPI, LangGraph, React',
    is_remote: true,
    experience_years_min: 2,
    experience_years_max: 5,
    industry: '跨境电商'
  },
  {
    id: 'job-2',
    title: '全栈开发工程师',
    company: 'AI创业公司',
    description: '开发AI应用的全栈系统，需要React和Python后端经验',
    requirements: 'React, Next.js, Python, FastAPI',
    is_remote: true,
    experience_years_min: 3,
    experience_years_max: 6,
    industry: 'AI应用'
  },
  {
    id: 'job-3',
    title: 'B2B销售自动化专家',
    company: 'SaaS公司',
    description: '设计和实施B2B销售自动化流程，需要LinkedIn和邮件自动化经验',
    requirements: 'LinkedIn, 邮件自动化, API集成, 数据分析',
    is_remote: true,
    experience_years_min: 2,
    experience_years_max: 4,
    industry: 'B2B SaaS'
  },
  {
    id: 'job-4',
    title: '数据分析师',
    company: '电商平台',
    description: '负责电商数据的分析和自动化报表生成',
    requirements: 'Python, SQL, pandas, 数据可视化',
    is_remote: true,
    experience_years_min: 1,
    experience_years_max: 3,
    industry: '电商'
  },
  {
    id: 'job-5',
    title: '前端开发工程师',
    company: '互联网公司',
    description: '开发React和Next.js前端应用',
    requirements: 'React, Next.js, TypeScript, Tailwind CSS',
    is_remote: true,
    experience_years_min: 2,
    experience_years_max: 4,
    industry: '互联网'
  }
];

async function testSimpleMatching() {
  console.log('🚀 开始简化版匹配测试...');
  
  // 1. 初始化候选人画像
  const profile = new CandidateProfile();
  console.log('✅ 候选人画像加载完成');
  
  // 2. 计算每个岗位的匹配度
  const results = [];
  
  for (const job of mockJobs) {
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
  
  console.log('\n🎯 匹配结果（按分数排序）:');
  console.log('='.repeat(80));
  
  sortedResults.forEach((job, index) => {
    console.log(`${index + 1}. ${job.title} - ${job.company}`);
    console.log(`   得分: ${job.overallScore} | 推荐等级: ${getRecommendationLevel(job.overallScore)}`);
    console.log(`   技能匹配: ${job.skillMatches.length}项 | 缺口: ${job.skillGaps.length}项`);
    console.log(`   远程适配: ${job.remoteFit} | 经验适配: ${job.experienceFit}`);
    console.log(`   说明: ${job.explanation}`);
    console.log('-'.repeat(80));
  });
  
  // 4. 生成报告
  generateReport(sortedResults);
  
  return sortedResults;
}

function getRecommendationLevel(score) {
  if (score >= 80) return '强烈推荐';
  if (score >= 60) return '推荐';
  if (score >= 40) return '考虑';
  return '备选';
}

function generateReport(results) {
  const stats = {
    total: results.length,
    averageScore: results.reduce((sum, r) => sum + r.overallScore, 0) / results.length,
    highScore: results.filter(r => r.overallScore >= 80).length,
    mediumScore: results.filter(r => r.overallScore >= 60 && r.overallScore < 80).length
  };
  
  const report = `
# 简化版匹配测试报告

## 测试结果
- **测试岗位数**: ${results.length}个
- **平均匹配度**: ${stats.averageScore.toFixed(1)}分
- **强烈推荐**: ${stats.highScore}个
- **推荐**: ${stats.mediumScore}个

## Top 3 岗位
${results.slice(0, 3).map((job, index) => 
  `${index + 1}. ${job.title} - ${job.company} (${job.overallScore}分)`
).join('\n')}

## 详细结果
${results.map(job => 
  `- ${job.title}: ${job.overallScore}分 (${getRecommendationLevel(job.overallScore)}) - ${job.skillMatches.length}项技能匹配, ${job.skillGaps.length}项缺口`
).join('\n')}

生成时间: ${new Date().toLocaleString()}
`;
  
  // 保存报告
  const fs = require('fs');
  const reportPath = '../output/simple-test-report.md';
  fs.writeFileSync(reportPath, report);
  console.log(`\n📊 报告已生成: ${reportPath}`);
  
  // 生成HTML
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>简化版匹配测试报告</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        .job-card { border: 1px solid #ddd; margin: 10px 0; padding: 15px; border-radius: 5px; }
        .job-title { font-size: 1.2em; font-weight: bold; color: #333; }
        .job-score { font-size: 1.1em; font-weight: bold; color: #007bff; }
        .job-details { margin-top: 10px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎯 简化版匹配测试报告</h1>
        <p>从${results.length}个岗位中筛选出最适合的岗位</p>
        
        ${results.map(job => `
            <div class="job-card">
                <div class="job-title">${job.title} - ${job.company}</div>
                <div class="job-score">匹配度: ${job.overallScore}分 (${getRecommendationLevel(job.overallScore)})</div>
                <div class="job-details">
                    技能匹配: ${job.skillMatches.length}项 | 技能缺口: ${job.skillGaps.length}项<br>
                    远程适配: ${job.remoteFit} | 经验适配: ${job.experienceFit}<br>
                    ${job.explanation}
                </div>
            </div>
        `).join('')}
    </div>
</body>
</html>
  `;
  
  const htmlPath = '../output/simple-test-report.html';
  fs.writeFileSync(htmlPath, html);
  console.log(`🌐 HTML报告已生成: ${htmlPath}`);
  
  // 打开HTML报告
  const { exec } = require('child_process');
  exec(`start ${htmlPath}`);
}

// 运行测试
if (require.main === module) {
  testSimpleMatching().catch(console.error);
}

module.exports = { testSimpleMatching };