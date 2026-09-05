/**
 * Embedding Matcher - 向量匹配引擎
 * 实现三层匹配架构：Embedding → Reranker → LLM 判断
 */

const CandidateProfile = require('./candidate-profile');
const { SentenceTransformer } = require('sentence-transformers');

class EmbeddingMatcher {
  constructor(config = {}) {
    this.config = {
      embeddingModel: 'all-MiniLM-L6-v2',
      rerankerModel: 'bge-reranker-base',
      topK: 50, // 第一阶段筛选数量
      finalTopK: 10, // 最终筛选数量
      ...config
    };
    
    this.embeddingModel = null;
    this.rerankerModel = null;
    this.candidateProfile = null;
  }

  /**
   * 初始化匹配器
   */
  async initialize() {
    console.log('🚀 初始化 Embedding Matcher...');
    
    // 初始化嵌入模型
    this.embeddingModel = new SentenceTransformer(this.config.embeddingModel);
    console.log(`✅ 嵌入模型加载完成: ${this.config.embeddingModel}`);
    
    // 初始化重排序模型
    if (this.config.rerankerModel) {
      this.rerankerModel = await this.loadReranker(this.config.rerankerModel);
      console.log(`✅ 重排序模型加载完成: ${this.config.rerankerModel}`);
    }
    
    // 加载候选人画像
    this.candidateProfile = new CandidateProfile();
    await this.candidateProfile.generateEmbedding();
    console.log('✅ 候选人画像加载完成');
    
    console.log('🎯 Embedding Matcher 初始化完成');
  }

  /**
   * 执行完整的三层匹配流程
   */
  async matchJobs(allJobs) {
    console.log(`🔄 开始匹配 ${allJobs.length} 个岗位...`);
    
    // 第一阶段：Embedding 快速筛选
    console.log('👀 第一阶段: Embedding 快速筛选...');
    const topCandidates = await this.embeddingFilter(allJobs, this.config.topK);
    
    // 第二阶段：Reranker 精排
    console.log('🔍 第二阶段: Reranker 精排...');
    const rerankedResults = await this.rerank(topCandidates);
    
    // 第三阶段：LLM 深度判断
    console.log('🧠 第三阶段: LLM 深度判断...');
    const finalResults = await this.llmJudge(rerankedResults);
    
    console.log(`✅ 匹配完成，最终结果: ${finalResults.length} 个岗位`);
    
    return finalResults;
  }

  /**
   * 第一阶段：Embedding 快速筛选
   */
  async embeddingFilter(jobs, topK) {
    console.log(`📊 计算岗位向量相似度...`);
    
    const jobEmbeddings = [];
    const processedJobs = [];
    
    // 批量计算岗位向量
    for (let i = 0; i < jobs.length; i += 10) {
      const batch = jobs.slice(i, i + 10);
      const batchEmbeddings = await this.embeddingModel.encode(
        batch.map(job => this.getJobText(job))
      );
      
      batchEmbeddings.forEach((embedding, index) => {
        jobEmbeddings.push(embedding);
        processedJobs.push({
          ...batch[index],
          embedding: embedding,
          similarity: this.calculateCosineSimilarity(
            this.candidateProfile.vectorEmbedding,
            embedding
          )
        });
      });
      
      if (i % 50 === 0) {
        console.log(`📈 已处理 ${Math.min(i + 10, jobs.length)}/${jobs.length} 个岗位`);
      }
    }
    
    // 按相似度排序，取 Top K
    const sortedJobs = processedJobs
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
    
    console.log(`🎯 第一阶段筛选完成: ${jobs.length} → ${topK} 个岗位`);
    console.log(`📈 最高相似度: ${Math.max(...sortedJobs.map(j => j.similarity)).toFixed(3)}`);
    
    return sortedJobs;
  }

  /**
   * 第二阶段：Reranker 精排
   */
  async rerank(jobs) {
    if (!this.rerankerModel || jobs.length <= this.config.finalTopK) {
      return jobs;
    }
    
    console.log(`🔄 对 ${jobs.length} 个岗位进行重排序...`);
    
    const rerankedJobs = [];
    
    // 分批处理，避免内存问题
    for (let i = 0; i < jobs.length; i += 5) {
      const batch = jobs.slice(i, i + 5);
      const batchTexts = batch.map(job => this.getJobText(job));
      const candidateText = this.candidateProfile.getProfileText();
      
      // 使用重排序模型计算相关性分数
      const scores = await this.rerankerModel.computeScore(
        [candidateText],
        batchTexts
      );
      
      batch.forEach((job, index) => {
        rerankedJobs.push({
          ...job,
          rerankerScore: scores[index] || 0,
          combinedScore: this.combineScores(job.similarity, scores[index] || 0)
        });
      });
    }
    
    // 按综合分数排序，取最终 Top K
    const finalResults = rerankedJobs
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, this.config.finalTopK);
    
    console.log(`🎯 第二阶段筛选完成: ${jobs.length} → ${this.config.finalTopK} 个岗位`);
    
    return finalResults;
  }

  /**
   * 第三阶段：LLM 深度判断
   */
  async llmJudge(jobs) {
    console.log(`🧠 对 ${jobs.length} 个岗位进行深度判断...`);
    
    const finalResults = [];
    
    for (const job of jobs) {
      try {
        const matchResult = await this.candidateProfile.calculateJobMatch(job);
        
        finalResults.push({
          ...job,
          ...matchResult,
          embeddingScore: job.similarity,
          rerankerScore: job.rerankerScore || 0,
          combinedScore: matchResult.overallScore,
          finalJudgment: this.generateFinalJudgment(matchResult, job)
        });
        
        // 显示进度
        if (finalResults.length % 5 === 0) {
          console.log(`📊 已完成 ${finalResults.length}/${jobs.length} 个岗位的深度判断`);
        }
        
      } catch (error) {
        console.warn(`❌ 岗位 ${job.id} 深度判断失败:`, error.message);
        // 即使 LLM 判断失败，也保留基础匹配结果
        finalResults.push({
          ...job,
          overallScore: job.similarity * 100,
          explanation: 'LLM 判断失败，使用基础相似度分数',
          finalJudgment: '基础匹配，建议人工审核'
        });
      }
    }
    
    // 最终排序
    const sortedResults = finalResults
      .sort((a, b) => b.overallScore - a.overallScore);
    
    console.log(`🎯 第三阶段完成，最终结果: ${sortedResults.length} 个岗位`);
    
    return sortedResults;
  }

  /**
   * 计算余弦相似度
   */
  calculateCosineSimilarity(vecA, vecB) {
    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    
    return dotProduct / (magnitudeA * magnitudeB);
  }

  /**
   * 组合不同分数
   */
  combineScores(embeddingScore, rerankerScore) {
    const embeddingWeight = 0.6;
    const rerankerWeight = 0.4;
    
    return embeddingScore * embeddingWeight + rerankerScore * rerankerWeight;
  }

  /**
   * 获取岗位文本表示
   */
  getJobText(job) {
    const sections = [
      job.title,
      job.company,
      job.description,
      job.location,
      job.salary
    ].filter(Boolean);
    
    return sections.join(' | ');
  }

  /**
   * 生成最终判断
   */
  generateFinalJudgment(matchResult, job) {
    const parts = [];
    
    // 基于总分给出建议
    if (matchResult.overallScore >= 80) {
      parts.push('强烈推荐');
    } else if (matchResult.overallScore >= 60) {
      parts.push('推荐');
    } else if (matchResult.overallScore >= 40) {
      parts.push('考虑');
    } else {
      parts.push('不推荐');
    }
    
    // 添加具体原因
    if (matchResult.skillMatches.length >= 3) {
      parts.push('技能匹配度高');
    }
    
    if (matchResult.remoteFit >= 80) {
      parts.push('远程工作适配');
    }
    
    if (matchResult.experienceFit >= 80) {
      parts.push('经验匹配良好');
    }
    
    if (matchResult.skillGaps.length > 3) {
      parts.push('存在较多技能缺口');
    }
    
    return parts.join(' | ');
  }

  /**
   * 加载重排序模型
   */
  async loadReranker(modelName) {
    try {
      // 这里使用 CrossEncoder 作为重排序模型
      const { CrossEncoder } = require('cross-encoder');
      const model = await CrossEncoder.fromPretrained(modelName);
      return model;
    } catch (error) {
      console.warn(`⚠️ 重排序模型加载失败，将使用基础相似度:`, error.message);
      return null;
    }
  }

  /**
   * 批量匹配（用于定期更新）
   */
  async batchMatch(jobs, batchSize = 20) {
    const allResults = [];
    
    for (let i = 0; i < jobs.length; i += batchSize) {
      const batch = jobs.slice(i, i + batchSize);
      console.log(`🔄 处理批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(jobs.length / batchSize)}`);
      
      const batchResults = await this.matchJobs(batch);
      allResults.push(...batchResults);
      
      // 批次间延迟，避免 API 限制
      if (i + batchSize < jobs.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return allResults;
  }

  /**
   * 获取匹配统计信息
   */
  getMatchStats(results) {
    const stats = {
      total: results.length,
      highScore: results.filter(r => r.overallScore >= 80).length,
      mediumScore: results.filter(r => r.overallScore >= 60 && r.overallScore < 80).length,
      lowScore: results.filter(r => r.overallScore < 60).length,
      averageScore: 0,
      skillMatches: 0,
      remoteFriendly: 0,
      experienceMatch: 0
    };
    
    if (results.length > 0) {
      stats.averageScore = results.reduce((sum, r) => sum + r.overallScore, 0) / results.length;
      stats.skillMatches = results.reduce((sum, r) => sum + r.skillMatches.length, 0);
      stats.remoteFriendly = results.filter(r => r.remoteFit >= 80).length;
      stats.experienceMatch = results.filter(r => r.experienceFit >= 80).length;
    }
    
    return stats;
  }
}

module.exports = EmbeddingMatcher;