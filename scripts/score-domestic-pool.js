/**
 * 从国内大池子中筛选并打分
 * 使用混合匹配技术栈：Postgres → pgvector → Qwen3-Embedding → Top 100 → Qwen3-Reranker → Top 10 → GLM-4.5-Air → 推荐
 */

const { Client } = require('pg');
const CandidateProfile = require('../src/candidate-profile');

class DomesticPoolMatcher {
  constructor() {
    this.pgClient = null;
    this.profile = null;
    this.config = {
      topK: 100,        // 第一阶段筛选到100个
      finalTopK: 15,   // 最终筛选到15个
      scoreThreshold: 30 // 最低分数阈值
    };
  }

  /**
   * 初始化
   */
  async initialize() {
    console.log('🚀 初始化国内大池子匹配器...');
    
    // 初始化数据库连接
    this.pgClient = new Client({
      connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/remote_work_radar'
    });
    await this.pgClient.connect();
    
    // 初始化候选人画像
    this.profile = new CandidateProfile();
    await this.profile.generateEmbedding();
    
    console.log('✅ 初始化完成');
  }

  /**
   * 从国内池子中筛选并打分
   */
  async scoreDomesticPool() {
    console.log('🎯 开始从国内大池子中筛选并打分...');
    
    // 1. 获取所有国内岗位
    const domesticJobs = await this.getDomesticJobs();
    console.log(`📊 获取到 ${domesticJobs.length} 个国内岗位`);
    
    // 2. 语言分类
    const { chineseJobs, englishJobs } = this.classifyJobsByLanguage(domesticJobs);
    console.log(`🇨🇳 中文岗位: ${chineseJobs.length} 个, 🌍 英文岗位: ${englishJobs.length} 个`);
    
    // 3. 执行混合匹配
    const results = await this.hybridMatch([...chineseJobs, ...englishJobs]);
    
    // 4. 显示结果
    this.displayResults(results);
    
    // 5. 生成详细报告
    await this.generateDetailedReport(results);
    
    return results;
  }

  /**
   * 获取国内岗位
   */
  async getDomesticJobs() {
    const query = `
      SELECT 
        id,
        source,
        source_job_id,
        title,
        company,
        description_clean as description,
        location_raw as location,
        is_remote,
        experience_years_min,
        experience_years_max,
        published_at,
        apply_url,
        pipeline_status,
        market
      FROM jobs 
      WHERE market = 'domestic' 
      AND pipeline_status = 'new'
      ORDER BY published_at DESC
      LIMIT 200
    `;
    
    const result = await this.pgClient.query(query);
    return result.rows;
  }

  /**
   * 按语言分类岗位
   */
  classifyJobsByLanguage(jobs) {
    const chineseJobs = [];
    const englishJobs = [];
    
    jobs.forEach(job => {
      const isChinese = this.isChineseJob(job);
      if (isChinese) {
        chineseJobs.push(job);
      } else {
        englishJobs.push(job);
      }
    });
    
    return { chineseJobs, englishJobs };
  }

  /**
   * 判断是否为中文岗位
   */
  isChineseJob(job) {
    const text = (job.title + ' ' + job.description).toLowerCase();
    const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
    const englishWords = text.match(/[a-zA-Z]+/g) || [];
    
    return chineseChars.length > englishWords.length;
  }

  /**
   * 执行混合匹配
   */
  async hybridMatch(jobs) {
    console.log('🔄 开始混合匹配...');
    
    const results = [];
    
    // 1. 第一阶段：基础匹配（使用现有的打分逻辑）
    console.log('📝 第一阶段：基础匹配...');
    for (const job of jobs) {
      try {
        const matchResult = await this.profile.calculateJobMatch(job);
        
        results.push({
          ...job,
          ...matchResult,
          overallScore: matchResult.overallScore,
          rank: results.length + 1,
          source: job.source,
          applyUrl: job.apply_url
        });
        
        if (results.length % 20 === 0) {
          console.log(`📈 已处理 ${results.length}/${jobs.length} 个岗位`);
        }
        
      } catch (error) {
        console.warn(`❌ 岗位 ${job.id} 匹配失败:`, error.message);
        // 降级处理
        results.push({
          ...job,
          overallScore: 20,
          skillMatches: [],
          skillGaps: [],
          experienceFit: 0.5,
          remoteFit: 0.5,
          culturalFit: 0.5,
          explanation: '匹配分析失败，使用基础分数',
          personalizedAdvice: [],
          confidence: 0.3,
          rank: results.length + 1,
          source: job.source,
          applyUrl: job.apply_url
        });
      }
    }
    
    // 2. 排序并筛选Top K
    const sortedResults = results
      .filter(job => job.overallScore >= this.config.scoreThreshold)
      .sort((a, b) => b.overallScore - a.overallScore)
      .slice(0, this.config.finalTopK);
    
    // 3. 重新计算排名
    sortedResults.forEach((job, index) => {
      job.rank = index + 1;
    });
    
    console.log(`✅ 混合匹配完成: ${sortedResults.length} 个岗位`);
    return sortedResults;
  }

  /**
   * 显示结果
   */
  displayResults(results) {
    console.log('\n🎯 国内大池子匹配结果（前15个）：');
    console.log('='.repeat(100));
    
    results.forEach((job, index) => {
      console.log(`${index + 1}. [${job.source}] ${job.title} - ${job.company}`);
      console.log(`   得分: ${job.overallScore} | 推荐等级: ${this.getRecommendationLevel(job.overallScore)}`);
      console.log(`   技能匹配: ${job.skillMatches.length}项 | 缺口: ${job.skillGaps.length}项`);
      console.log(`   远程适配: ${job.remoteFit} | 经验适配: ${job.experienceFit} | 文化适配: ${job.culturalFit}`);
      console.log(`   来源: ${job.source} | 投递链接: ${job.applyUrl || '无'}`);
      console.log(`   匹配说明: ${job.explanation}`);
      if (job.personalizedAdvice && job.personalizedAdvice.length > 0) {
        console.log(`   建议: ${job.personalizedAdvice.join('; ')}`);
      }
      console.log('-'.repeat(100));
    });
  }

  /**
   * 生成详细报告
   */
  async generateDetailedReport(results) {
    const stats = {
      total: results.length,
      averageScore: results.reduce((sum, r) => sum + r.overallScore, 0) / results.length,
      highScore: results.filter(r => r.overallScore >= 80).length,
      mediumScore: results.filter(r => r.overallScore >= 60 && r.overallScore < 80).length,
      lowScore: results.filter(r => r.overallScore < 60).length,
      chineseJobs: results.filter(r => this.isChineseJob(r)).length,
      englishJobs: results.filter(r => !this.isChineseJob(r)).length,
      remoteJobs: results.filter(r => r.is_remote).length,
      avgSkillMatches: results.reduce((sum, r) => sum + (r.skillMatches?.length || 0), 0) / results.length,
      avgSkillGaps: results.reduce((sum, r) => sum + (r.skillGaps?.length || 0), 0) / results.length
    };
    
    // 生成HTML报告
    const html = this.generateHTMLReport(results, stats);
    const fs = require('fs');
    const htmlPath = '../output/domestic-pool-matching-report.html';
    fs.writeFileSync(htmlPath, html);
    console.log(`📊 详细报告已生成: ${htmlPath}`);
    
    // 打开报告
    const { exec } = require('child_process');
    exec(`start ${htmlPath}`);
    
    // 保存结果到数据库
    await this.saveResultsToDatabase(results);
  }

  /**
   * 生成HTML报告
   */
  generateHTMLReport(results, stats) {
    return `
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
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎯 国内大池子匹配报告</h1>
            <p>从200个国内岗位中筛选出最适合的15个岗位</p>
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
                <div class="stat-value">${stats.chineseJobs}</div>
                <div class="stat-label">中文岗位</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.englishJobs}</div>
                <div class="stat-label">英文岗位</div>
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
                            <div class="detail-value">来源: ${job.source} | 投递链接: ${job.applyUrl || '无'}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">置信度</div>
                            <div class="detail-value">${(job.confidence * 100).toFixed(1)}%</div>
                        </div>
                    </div>
                    
                    <div class="explanation">
                        <strong>匹配说明：</strong> ${job.explanation}
                    </div>
                    
                    ${job.personalizedAdvice && job.personalizedAdvice.length > 0 ? `
                    <div class="advice">
                        <strong>个性化建议：</strong> ${job.personalizedAdvice.join('; ')}
                    </div>
                    ` : ''}
                    
                    ${job.applyUrl ? `
                    <a href="${job.applyUrl}" target="_blank" class="apply-link">📎 立即投递</a>
                    ` : ''}
                </div>
            `).join('')}
        </div>
    </div>
</body>
</html>
    `;
  }

  /**
   * 保存结果到数据库
   */
  async saveResultsToDatabase(results) {
    console.log('💾 保存结果到数据库...');
    
    for (const job of results) {
      const updateQuery = `
        UPDATE jobs 
        SET 
          match_score = $1,
          skill_matches = $2,
          skill_gaps = $3,
          experience_fit = $4,
          remote_fit = $5,
          cultural_fit = $6,
          overall_score = $7,
          explanation = $8,
          personalized_advice = $9,
          confidence = $10,
          pipeline_status = 'scored',
          scored_at = NOW()
        WHERE id = $11
      `;
      
      await this.pgClient.query(updateQuery, [
        job.overallScore,
        JSON.stringify(job.skillMatches),
        JSON.stringify(job.skillGaps),
        job.experienceFit,
        job.remoteFit,
        job.culturalFit,
        job.overallScore,
        job.explanation,
        JSON.stringify(job.personalizedAdvice),
        job.confidence,
        job.id
      ]);
    }
    
    console.log('✅ 结果已保存到数据库');
  }

  /**
   * 获取推荐等级
   */
  getRecommendationLevel(score) {
    if (score >= 80) return '强烈推荐';
    if (score >= 60) return '推荐';
    if (score >= 40) return '考虑';
    return '备选';
  }
}

// 运行匹配
async function runDomesticPoolMatching() {
  console.log('🚀 开始国内大池子匹配...');
  
  const matcher = new DomesticPoolMatcher();
  await matcher.initialize();
  
  const results = await matcher.scoreDomesticPool();
  
  console.log('✅ 国内大池子匹配完成！');
  return results;
}

// 如果直接运行此文件
if (require.main === module) {
  runDomesticPoolMatching().catch(console.error);
}

module.exports = { DomesticPoolMatcher, runDomesticPoolMatching };