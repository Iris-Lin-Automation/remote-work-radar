/**
 * Enhanced Matcher - 增强型匹配器
 * 整合 Embedding + Reranker + LLM + 规则的完整匹配流程
 */

const CandidateProfile = require('./candidate-profile');
const EmbeddingMatcher = require('./embedding-matcher');
const { v4: uuidv4 } = require('uuid');

class EnhancedMatcher {
  constructor(config = {}) {
    this.config = {
      // 匹配参数
      topK: 50, // 第一阶段筛选数量
      finalTopK: 10, // 最终筛选数量
      scoreThreshold: 30, // 最低分数阈值
      
      // 权重配置
      weights: {
        embedding: 0.4,
        reranker: 0.3,
        llm: 0.3,
        skills: 0.4,
        remote: 0.2,
        cultural: 0.2,
        experience: 0.2
      },
      
      // 规则配置
      rules: {
        excludeKeywords: ['客服', '销售', '高频电话', '坐班', 'onsite'],
        mustHaveKeywords: [],
        preferredKeywords: ['remote', 'async', '分布式', '国际团队'],
        
        // 硬性约束
        hardConstraints: {
          maxExperienceGap: 3, // 最大经验差距
          minRemoteScore: 50, // 最低远程适配度
          excludeOnsite: true // 排除坐班岗位
        }
      },
      
      ...config
    };
    
    this.embeddingMatcher = null;
    this.candidateProfile = null;
    this.matchHistory = [];
  }

  /**
   * 初始化增强匹配器
   */
  async initialize() {
    console.log('🚀 初始化 Enhanced Matcher...');
    
    // 初始化候选人画像
    this.candidateProfile = new CandidateProfile();
    await this.candidateProfile.generateEmbedding();
    
    // 初始化嵌入匹配器
    this.embeddingMatcher = new EmbeddingMatcher(this.config);
    await this.embeddingMatcher.initialize();
    
    console.log('✅ Enhanced Matcher 初始化完成');
  }

  /**
   * 执行完整的增强匹配流程
   */
  async matchJobs(jobs) {
    console.log(`🎯 开始增强匹配 ${jobs.length} 个岗位...`);
    
    const startTime = Date.now();
    
    // 1. 预过滤：基于硬性规则
    console.log('🚫 第一阶段: 硬性规则过滤...');
    const filteredJobs = await this.applyHardConstraints(jobs);
    console.log(`📊 过滤后: ${jobs.length} → ${filteredJobs.length} 个岗位`);
    
    if (filteredJobs.length === 0) {
      console.log('❌ 没有符合硬性约束的岗位');
      return [];
    }
    
    // 2. 向量匹配：Embedding 快速筛选
    console.log('👀 第二阶段: 向量匹配筛选...');
    const vectorResults = await this.embeddingMatcher.embeddingFilter(
      filteredJobs, 
      this.config.topK
    );
    
    // 3. 重排序：Reranker 精排
    console.log('🔍 第三阶段: 重排序精排...');
    const rerankedResults = await this.embeddingMatcher.rerank(vectorResults);
    
    // 4. 规则增强：应用业务规则
    console.log('⚙️  第四阶段: 规则增强...');
    const ruleEnhancedResults = await this.applyBusinessRules(rerankedResults);
    
    // 5. LLM 深度判断
    console.log('🧠 第五阶段: LLM 深度判断...');
    const finalResults = await this.llmDeepAnalysis(ruleEnhancedResults);
    
    // 6. 最终排序和后处理
    console.log('🏆 第六阶段: 最终排序...');
    const processedResults = await this.finalProcessing(finalResults);
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.log(`✅ 增强匹配完成: ${processedResults.length} 个岗位，耗时 ${duration}ms`);
    
    // 记录匹配历史
    this.recordMatchHistory(processedResults, duration);
    
    return processedResults;
  }

  /**
   * 应用硬性约束过滤
   */
  async applyHardConstraints(jobs) {
    return jobs.filter(job => {
      // 排除关键词检查
      if (this.config.rules.excludeKeywords.some(keyword => 
        job.title.toLowerCase().includes(keyword.toLowerCase()) ||
        job.description.toLowerCase().includes(keyword.toLowerCase())
      )) {
        return false;
      }
      
      // 必须包含关键词检查
      if (this.config.rules.mustHaveKeywords.length > 0) {
        const hasMustHave = this.config.rules.mustHaveKeywords.some(keyword => 
          job.title.toLowerCase().includes(keyword.toLowerCase()) ||
          job.description.toLowerCase().includes(keyword.toLowerCase())
        );
        if (!hasMustHave) {
          return false;
        }
      }
      
      // 坐班约束检查
      if (this.config.rules.hardConstraints.excludeOnsite) {
        if (job.is_remote === 'false') {
          return false;
        }
      }
      
      // 经验差距检查
      const jobMinExp = job.experience_years_min || 0;
      const candidateExp = this.candidateProfile.totalExperience || 0;
      const expGap = Math.abs(jobMinExp - candidateExp);
      
      if (expGap > this.config.rules.hardConstraints.maxExperienceGap) {
        return false;
      }
      
      return true;
    });
  }

  /**
   * 应用业务规则增强
   */
  async applyBusinessRules(jobs) {
    return jobs.map(job => {
      let ruleScore = 0;
      let ruleExplanation = [];
      
      // 优选关键词加分
      this.config.rules.preferredKeywords.forEach(keyword => {
        if (job.title.toLowerCase().includes(keyword.toLowerCase()) ||
            job.description.toLowerCase().includes(keyword.toLowerCase())) {
          ruleScore += 10;
          ruleExplanation.push(`包含优选关键词: ${keyword}`);
        }
      });
      
      // 薪资范围检查
      if (job.salary && this.candidateProfile.constraints.salaryRange) {
        const jobSalary = this.parseSalary(job.salary);
        const expectedSalary = this.candidateProfile.constraints.salaryRange;
        
        if (this.isSalaryInRange(jobSalary, expectedSalary)) {
          ruleScore += 15;
          ruleExplanation.push('薪资范围匹配');
        }
      }
      
      // 公司规模偏好
      if (this.candidateProfile.preferences.companySize && job.company_size) {
        if (this.isCompanySizeMatch(job.company_size, this.candidateProfile.preferences.companySize)) {
          ruleScore += 10;
          ruleExplanation.push('公司规模匹配偏好');
        }
      }
      
      // 行业偏好
      if (this.candidateProfile.preferences.industries.length > 0 && job.industry) {
        if (this.candidateProfile.preferences.industries.includes(job.industry)) {
          ruleScore += 20;
          ruleExplanation.push('行业匹配偏好');
        }
      }
      
      return {
        ...job,
        ruleScore,
        ruleExplanation
      };
    });
  }

  /**
   * LLM 深度分析
   */
  async llmDeepAnalysis(jobs) {
    const results = [];
    
    for (const job of jobs) {
      try {
        // 使用候选人画像进行深度分析
        const matchResult = await this.candidateProfile.calculateJobMatch(job);
        
        // 计算综合分数
        const combinedScore = this.calculateCombinedScore(matchResult, job);
        
        // 生成个性化建议
        const personalizedAdvice = await this.generatePersonalizedAdvice(matchResult, job);
        
        results.push({
          ...job,
          ...matchResult,
          combinedScore,
          personalizedAdvice,
          analysisTimestamp: new Date().toISOString(),
          confidence: this.calculateConfidence(matchResult)
        });
        
      } catch (error) {
        console.warn(`❌ 岗位 ${job.id} LLM 分析失败:`, error.message);
        // 降级处理
        results.push({
          ...job,
          combinedScore: job.similarity * 100,
          explanation: 'LLM 分析失败，使用基础匹配',
          personalizedAdvice: '建议人工审核该岗位',
          confidence: 0.5
        });
      }
    }
    
    return results;
  }

  /**
   * 计算综合分数
   */
  calculateCombinedScore(matchResult, job) {
    const weights = this.config.weights;
    
    const skillScore = matchResult.skillMatches.length * 10;
    const remoteScore = matchResult.remoteFit;
    const culturalScore = matchResult.culturalFit;
    const experienceScore = matchResult.experienceFit;
    
    const llmScore = (
      skillScore * weights.skills +
      remoteScore * weights.remote +
      culturalScore * weights.cultural +
      experienceScore * weights.experience
    );
    
    // 结合向量分数和重排序分数
    const embeddingScore = job.similarity * 100;
    const rerankerScore = job.rerankerScore || 0;
    const ruleScore = job.ruleScore || 0;
    
    const finalScore = (
      llmScore * weights.llm +
      embeddingScore * weights.embedding +
      rerankerScore * weights.reranker +
      ruleScore * 0.1 // 规则分数权重较低
    );
    
    return Math.round(Math.min(100, Math.max(0, finalScore)));
  }

  /**
   * 生成个性化建议
   */
  async generatePersonalizedAdvice(matchResult, job) {
    const advice = [];
    
    // 技能建议
    if (matchResult.skillGaps.length > 0) {
      const topGaps = matchResult.skillGaps.slice(0, 3);
      advice.push(`重点学习: ${topGaps.map(g => g.skill).join(', ')}`);
    }
    
    if (matchResult.skillMatches.length > 0) {
      const topMatches = matchResult.skillMatches.slice(0, 3);
      advice.push(`突出技能: ${topMatches.map(m => m.candidateSkill).join(', ')}`);
    }
    
    // 工作方式建议
    if (matchResult.remoteFit >= 80) {
      advice.push('该岗位支持远程工作，非常适合你的偏好');
    } else if (matchResult.remoteFit < 50) {
      advice.push('该岗位远程适配度较低，需要考虑工作方式');
    }
    
    // 经验建议
    if (matchResult.experienceFit >= 80) {
      advice.push('你的经验要求与岗位匹配良好');
    } else {
      const gap = (job.experience_years_min || 0) - (this.candidateProfile.totalExperience || 0);
      advice.push(`建议强调相关项目经验，弥补 ${gap} 年经验差距`);
    }
    
    // 投递策略建议
    if (matchResult.overallScore >= 80) {
      advice.push('强烈建议立即投递');
    } else if (matchResult.overallScore >= 60) {
      advice.push('建议投递，可针对性优化简历');
    } else {
      advice.push('建议作为备选，等待更合适的机会');
    }
    
    return advice.join(' | ');
  }

  /**
   * 计算置信度
   */
  calculateConfidence(matchResult) {
    const factors = [];
    
    // 技能匹配数量
    if (matchResult.skillMatches.length >= 3) {
      factors.push(0.8);
    } else if (matchResult.skillMatches.length >= 1) {
      factors.push(0.5);
    } else {
      factors.push(0.2);
    }
    
    // 远程适配度
    factors.push(matchResult.remoteFit / 100);
    
    // 经验适配度
    factors.push(matchResult.experienceFit / 100);
    
    // 技能缺口数量
    if (matchResult.skillGaps.length <= 2) {
      factors.push(0.8);
    } else if (matchResult.skillGaps.length <= 5) {
      factors.push(0.5);
    } else {
      factors.push(0.3);
    }
    
    // 综合置信度
    return factors.reduce((sum, factor) => sum + factor, 0) / factors.length;
  }

  /**
   * 最终处理
   */
  async finalProcessing(results) {
    // 应用最低分数阈值
    const thresholdResults = results.filter(
      result => result.combinedScore >= this.config.scoreThreshold
    );
    
    // 按综合分数排序
    const sortedResults = thresholdResults.sort(
      (a, b) => b.combinedScore - a.combinedScore
    );
    
    // 添加排名和推荐等级
    const finalResults = sortedResults.map((result, index) => ({
      ...result,
      rank: index + 1,
      recommendation: this.getRecommendationLevel(result.combinedScore, result.confidence)
    }));
    
    return finalResults;
  }

  /**
   * 获取推荐等级
   */
  getRecommendationLevel(score, confidence) {
    if (score >= 80 && confidence >= 0.7) return '强烈推荐';
    if (score >= 70 && confidence >= 0.6) return '推荐';
    if (score >= 60 && confidence >= 0.5) return '考虑';
    if (score >= 50 && confidence >= 0.4) return '备选';
    return '不推荐';
  }

  /**
   * 解析薪资
   */
  parseSalary(salaryText) {
    // 简单的薪资解析逻辑
    const numbers = salaryText.match(/\d+/g);
    if (numbers && numbers.length >= 2) {
      return {
        min: parseInt(numbers[0]),
        max: parseInt(numbers[1]),
        currency: salaryText.includes('k') ? 'k' : 'unknown'
      };
    }
    return null;
  }

  /**
   * 检查薪资是否在范围内
   */
  isSalaryInRange(jobSalary, expectedRange) {
    if (!jobSalary || !expectedRange) return false;
    
    const jobMin = jobSalary.min;
    const jobMax = jobSalary.max;
    const expectedMin = expectedRange.min;
    const expectedMax = expectedRange.max;
    
    return jobMax >= expectedMin && jobMin <= expectedMax;
  }

  /**
   * 检查公司规模匹配
   */
  isCompanySizeMatch(companySize, preference) {
    const sizeMap = {
      'startup': '1-50',
      'small': '1-100',
      'medium': '100-500',
      'large': '500+'
    };
    
    return sizeMap[companySize] === preference;
  }

  /**
   * 记录匹配历史
   */
  recordMatchHistory(results, duration) {
    const history = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      totalJobs: results.length,
      averageScore: results.reduce((sum, r) => sum + r.combinedScore, 0) / results.length,
      highScoreCount: results.filter(r => r.combinedScore >= 80).length,
      duration,
      results: results.map(r => ({
        id: r.id,
        title: r.title,
        score: r.combinedScore,
        recommendation: r.recommendation
      }))
    };
    
    this.matchHistory.push(history);
    
    // 保持历史记录在合理范围内
    if (this.matchHistory.length > 100) {
      this.matchHistory = this.matchHistory.slice(-100);
    }
  }

  /**
   * 获取匹配统计
   */
  getMatchStats() {
    if (this.matchHistory.length === 0) {
      return {
        totalMatches: 0,
        averageScore: 0,
        averageDuration: 0,
        highScoreRate: 0
      };
    }
    
    const totalMatches = this.matchHistory.length;
    const averageScore = this.matchHistory.reduce((sum, h) => sum + h.averageScore, 0) / totalMatches;
    const averageDuration = this.matchHistory.reduce((sum, h) => sum + h.duration, 0) / totalMatches;
    const highScoreRate = this.matchHistory.reduce((sum, h) => sum + h.highScoreCount, 0) / 
                         this.matchHistory.reduce((sum, h) => sum + h.totalJobs, 0);
    
    return {
      totalMatches,
      averageScore: Math.round(averageScore),
      averageDuration: Math.round(averageDuration),
      highScoreRate: Math.round(highScoreRate * 100)
    };
  }

  /**
   * 获取技能趋势分析
   */
  getSkillTrends() {
    // 分析历史匹配数据，找出热门技能和缺口技能
    const skillTrends = {
      inDemand: [],
      emerging: [],
      declining: []
    };
    
    // 这里可以实现更复杂的趋势分析逻辑
    // 基于历史匹配数据统计技能出现频率
    
    return skillTrends;
  }
}

module.exports = EnhancedMatcher;