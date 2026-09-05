/**
 * Hybrid Matcher Test - 小范围测试
 * 从100个岗位中筛选出10几个
 */

const { Client } = require('pg');
const CandidateProfile = require('../src/candidate-profile');
const HybridMatcher = require('../src/hybrid-matcher');

async function testHybridMatcher() {
  console.log('🚀 开始混合匹配器测试...');
  
  // 1. 初始化
  const matcher = new HybridMatcher({
    topK: 50,    // 第一阶段筛选到50个
    finalTopK: 15 // 最终筛选到15个
  });
  
  await matcher.initialize();
  
  // 2. 模拟100个岗位数据
  const mockJobs = generateMockJobs(100);
  
  console.log(`📊 生成了 ${mockJobs.length} 个测试岗位`);
  
  // 3. 执行混合匹配
  const startTime = Date.now();
  const results = await matcher.matchJobs(mockJobs);
  const endTime = Date.now();
  
  console.log(`⏱️ 匹配完成，耗时: ${endTime - startTime}ms`);
  console.log(`🎯 最终结果: ${results.length} 个岗位`);
  
  // 4. 显示结果
  displayResults(results);
  
  // 5. 生成报告
  generateReport(results);
  
  return results;
}

/**
 * 生成模拟岗位数据
 */
function generateMockJobs(count) {
  const jobTemplates = [
    {
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
      title: 'AI产品经理',
      company: 'AI公司',
      description: '负责AI产品的设计和规划，需要技术和业务结合',
      requirements: 'AI知识, 产品设计, 技术理解, 业务分析',
      is_remote: true,
      experience_years_min: 3,
      experience_years_max: 5,
      industry: 'AI产品'
    },
    {
      title: '前端开发工程师',
      company: '互联网公司',
      description: '开发React和Next.js前端应用',
      requirements: 'React, Next.js, TypeScript, Tailwind CSS',
      is_remote: true,
      experience_years_min: 2,
      experience_years_max: 4,
      industry: '互联网'
    },
    {
      title: 'Python后端工程师',
      company: '科技公司',
      description: '开发Python后端API和数据处理系统',
      requirements: 'Python, FastAPI, SQL, 数据处理',
      is_remote: true,
      experience_years_min: 2,
      experience_years_max: 5,
      industry: '科技'
    },
    {
      title: '自动化测试工程师',
      company: '软件公司',
      description: '设计和实施自动化测试流程',
      requirements: '自动化测试, Python, Selenium, CI/CD',
      is_remote: true,
      experience_years_min: 2,
      experience_years_max: 4,
      industry: '软件'
    }
  ];
  
  const jobs = [];
  const industries = ['跨境电商', 'AI应用', 'B2B SaaS', '电商', '互联网', '科技'];
  
  for (let i = 0; i < count; i++) {
    const template = jobTemplates[Math.floor(Math.random() * jobTemplates.length)];
    const industry = industries[Math.floor(Math.random() * industries.length)];
    
    jobs.push({
      id: `job-${i + 1}`,
      title: `${template.title} (${i + 1})`,
      company: template.company,
      description: `${template.description} 这是第${i + 1}个${template.title}岗位，主要负责相关工作。`,
      requirements: template.requirements,
      location: i % 3 === 0 ? 'Remote' : '广州/Remote',
      is_remote: i % 3 !== 2 ? 'true' : 'false',
      experience_years_min: template.experience_years_min,
      experience_years_max: template.experience_years_max,
      industry: industry,
      salary: `${15 + Math.floor(Math.random() * 15)}k-${20 + Math.floor(Math.random() * 10)}k`,
      created_at: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString()
    });
  }
  
  return jobs;
}

/**
 * 显示结果
 */
function displayResults(results) {
  console.log('\n🎯 匹配结果（前15个）：');
  console.log('='.repeat(80));
  
  results.forEach((job, index) => {
    console.log(`${index + 1}. ${job.title} - ${job.company}`);
    console.log(`   得分: ${job.overallScore} | 推荐等级: ${job.recommendation}`);
    console.log(`   行业: ${job.industry} | 经验: ${job.experience_years_min}-${job.experience_years_max}年`);
    console.log(`   技能匹配: ${job.skillMatches?.length || 0}项 | 缺口: ${job.skillGaps?.length || 0}项`);
    console.log(`   远程适配: ${job.remoteFit} | 文化适配: ${job.culturalFit}`);
    console.log(`   匹配说明: ${job.explanation}`);
    if (job.personalizedAdvice) {
      console.log(`   建议: ${job.personalizedAdvice}`);
    }
    console.log('-'.repeat(80));
  });
}

/**
 * 生成报告
 */
function generateReport(results) {
  const stats = {
    total: results.length,
    highScore: results.filter(r => r.overallScore >= 80).length,
    mediumScore: results.filter(r => r.overallScore >= 60 && r.overallScore < 80).length,
    lowScore: results.filter(r => r.overallScore < 60).length,
    averageScore: results.reduce((sum, r) => sum + r.overallScore, 0) / results.length,
    remoteJobs: results.filter(r => r.is_remote === 'true').length,
    avgSkillMatches: results.reduce((sum, r) => sum + (r.skillMatches?.length || 0), 0) / results.length,
    avgSkillGaps: results.reduce((sum, r) => sum + (r.skillGaps?.length || 0), 0) / results.length
  };
  
  const report = `
# 混合匹配器测试报告

## 测试概览
- **测试岗位数**: 100个
- **筛选结果数**: ${stats.total}个
- **筛选比例**: ${(stats.total / 100 * 100).toFixed(1)}%
- **平均匹配度**: ${stats.averageScore.toFixed(1)}分

## 匹配分布
- **强烈推荐** (80分以上): ${stats.highScore}个 (${(stats.highScore / stats.total * 100).toFixed(1)}%)
- **推荐** (60-79分): ${stats.mediumScore}个 (${(stats.mediumScore / stats.total * 100).toFixed(1)}%)
- **备选** (60分以下): ${stats.lowScore}个 (${(stats.lowScore / stats.total * 100).toFixed(1)}%)

## 岗位特征
- **远程岗位**: ${stats.remoteJobs}个 (${(stats.remoteJobs / stats.total * 100).toFixed(1)}%)
- **平均技能匹配**: ${stats.avgSkillMatches.toFixed(1)}项
- **平均技能缺口**: ${stats.avgSkillGaps.toFixed(1)}项

## Top 5 岗位
${results.slice(0, 5).map((job, index) => 
  `${index + 1}. ${job.title} - ${job.company} (${job.overallScore}分)`
).join('\n')}

## 建议
1. 重点投递强烈推荐的岗位
2. 针对技能缺口进行补充学习
3. 优化简历以突出匹配的技能
4. 准备面试材料时参考个性化建议

生成时间: ${new Date().toLocaleString()}
`;
  
  // 保存报告
  const fs = require('fs');
  const reportPath = '../output/hybrid-matcher-test-report.md';
  fs.writeFileSync(reportPath, report);
  console.log(`\n📊 报告已生成: ${reportPath}`);
  
  // 生成HTML结果页
  const html = generateHTMLReport(results, stats);
  const htmlPath = '../output/hybrid-matcher-test.html';
  fs.writeFileSync(htmlPath, html);
  console.log(`🌐 HTML报告已生成: ${htmlPath}`);
  
  // 打开HTML报告
  const { exec } = require('child_process');
  exec(`start ${htmlPath}`);
}

/**
 * 生成HTML报告
 */
function generateHTMLReport(results, stats) {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>混合匹配器测试报告</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background-color: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: #f8f9fa; padding: 20px; border-radius: 8px; text-align: center; }
        .stat-value { font-size: 2em; font-weight: bold; color: #007bff; }
        .stat-label { color: #666; margin-top: 5px; }
        .job-card { border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin-bottom: 20px; background: white; }
        .job-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .job-title { font-size: 1.2em; font-weight: bold; color: #333; }
        .job-score { font-size: 1.1em; font-weight: bold; padding: 5px 10px; border-radius: 5px; }
        .score-high { background: #d4edda; color: #155724; }
        .score-medium { background: #fff3cd; color: #856404; }
        .score-low { background: #f8d7da; color: #721c24; }
        .job-details { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-top: 15px; }
        .detail-item { background: #f8f9fa; padding: 10px; border-radius: 5px; }
        .detail-label { font-weight: bold; color: #666; }
        .detail-value { color: #333; margin-top: 5px; }
        .recommendation { margin-top: 10px; padding: 10px; border-radius: 5px; }
        .recommendation-high { background: #d4edda; color: #155724; }
        .recommendation-medium { background: #fff3cd; color: #856404; }
        .recommendation-low { background: #f8d7da; color: #721c24; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎯 混合匹配器测试报告</h1>
            <p>从100个岗位中筛选出最适合的15个岗位</p>
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
        </div>
        
        <h2>🎯 匹配结果</h2>
        ${results.map((job, index) => `
            <div class="job-card">
                <div class="job-header">
                    <div class="job-title">${index + 1}. ${job.title}</div>
                    <div class="job-score score-${job.overallScore >= 80 ? 'high' : job.overallScore >= 60 ? 'medium' : 'low'}">
                        ${job.overallScore}分
                    </div>
                </div>
                <div><strong>公司:</strong> ${job.company}</div>
                <div><strong>行业:</strong> ${job.industry} | <strong>经验:</strong> ${job.experience_years_min}-${job.experience_years_max}年</div>
                <div><strong>技能匹配:</strong> ${job.skillMatches?.length || 0}项 | <strong>技能缺口:</strong> ${job.skillGaps?.length || 0}项</div>
                <div><strong>远程适配:</strong> ${job.remoteFit} | <strong>文化适配:</strong> ${job.culturalFit}</div>
                
                <div class="recommendation recommendation-${job.overallScore >= 80 ? 'high' : job.overallScore >= 60 ? 'medium' : 'low'}">
                    <strong>推荐等级:</strong> ${job.recommendation}
                </div>
                
                <div class="job-details">
                    <div class="detail-item">
                        <div class="detail-label">匹配说明</div>
                        <div class="detail-value">${job.explanation}</div>
                    </div>
                    ${job.personalizedAdvice ? `
                    <div class="detail-item">
                        <div class="detail-label">个性化建议</div>
                        <div class="detail-value">${job.personalizedAdvice}</div>
                    </div>
                    ` : ''}
                </div>
            </div>
        `).join('')}
    </div>
</body>
</html>
  `;
}

// 运行测试
if (require.main === module) {
  testHybridMatcher().catch(console.error);
}

module.exports = { testHybridMatcher, generateMockJobs };