/**
 * Hybrid Matcher - 混合匹配引擎
 * 结合 Qwen3-Embedding + Qwen3-Reranker + GLM-4.5-Air 的中文优化方案
 */

const { Client } = require('pg');
const { VectorStore } = require('pgvector');

class HybridMatcher {
  constructor(config = {}) {
    this.config = {
      // 中文岗位使用 Qwen3-Embedding
      chineseEmbedding: {
        model: 'Qwen/Qwen3-Embedding',
        dimensions: 768,
        apiEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
        apiKey: process.env.DASHSCOPE_API_KEY
      },
      
      // 英文岗位使用 sentence-transformers
      englishEmbedding: {
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
        local: true
      },
      
      // 重排序使用 Qwen3-Reranker
      reranker: {
        model: 'Qwen/Qwen3-Reranker',
        apiEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
        apiKey: process.env.DASHSCOPE_API_KEY,
        maxTokens: 2048
      },
      
      // LLM 使用 GLM-4.5-Air
      llm: {
        model: 'GLM-4.5-Air',
        apiEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/text-generation',
        apiKey: process.env.DASHSCOPE_API_KEY,
        maxTokens: 2000,
        temperature: 0.7
      },
      
      // 匹配参数
      topK: 100,
      finalTopK: 10,
      scoreThreshold: 30,
      
      ...config
    };
    
    this.pgClient = null;
    this.vectorStore = null;
    this.candidateProfile = null;
  }

  /**
   * 初始化混合匹配器
   */
  async initialize() {
    console.log('🚀 初始化 Hybrid Matcher...');
    
    // 初始化数据库连接
    this.pgClient = new Client({
      connectionString: process.env.DATABASE_URL
    });
    await this.pgClient.connect();
    
    // 初始化向量存储
    this.vectorStore = new VectorStore(this.pgClient);
    
    // 初始化候选人画像
    const CandidateProfile = require('./candidate-profile');
    this.candidateProfile = new CandidateProfile();
    await this.candidateProfile.generateEmbedding();
    
    console.log('✅ Hybrid Matcher 初始化完成');
  }

  /**
   * 执行混合匹配流程
   */
  async matchJobs(jobs) {
    console.log(`🎯 开始混合匹配 ${jobs.length} 个岗位...`);
    
    // 1. 按语言分类岗位
    const { chineseJobs, englishJobs } = this.classifyJobsByLanguage(jobs);
    
    console.log(`📊 岗位分类: 中文 ${chineseJobs.length} 个, 英文 ${englishJobs.length} 个`);
    
    // 2. 分别进行嵌入
    const chineseResults = await this.processChineseJobs(chineseJobs);
    const englishResults = await this.processEnglishJobs(englishJobs);
    
    // 3. 合并结果
    const allResults = [...chineseResults, ...englishResults];
    
    // 4. 重排序
    const rerankedResults = await this.rerank(allResults);
    
    // 5. LLM 深度分析
    const finalResults = await this.llmAnalysis(rerankedResults);
    
    // 6. 最终排序
    const sortedResults = this.finalSort(finalResults);
    
    console.log(`✅ 混合匹配完成: ${sortedResults.length} 个岗位`);
    
    return sortedResults;
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
    const chineseText = (job.title + ' ' + job.description).toLowerCase();
    const englishText = (job.title + ' ' + job.description).toLowerCase();
    
    // 简单的语言判断
    const chineseChars = chineseText.match(/[\u4e00-\u9fff]/g) || [];
    const englishWords = englishText.match(/[a-zA-Z]+/g) || [];
    
    return chineseChars.length > englishWords.length;
  }

  /**
   * 处理中文岗位（使用 Qwen3-Embedding）
   */
  async processChineseJobs(jobs) {
    console.log(`🇨🇳 处理中文岗位: ${jobs.length} 个`);
    
    if (jobs.length === 0) return [];
    
    // 批量生成嵌入
    const embeddings = await this.generateQwenEmbeddings(
      jobs.map(job => this.getJobText(job))
    );
    
    // 计算相似度
    const results = jobs.map((job, index) => ({
      ...job,
      embedding: embeddings[index],
      similarity: this.calculateCosineSimilarity(
        this.candidateProfile.vectorEmbedding,
        embeddings[index]
      ),
      source: 'qwen-embedding'
    }));
    
    // 排序并取 Top K
    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.config.topK);
  }

  /**
   * 处理英文岗位（使用 sentence-transformers）
   */
  async processEnglishJobs(jobs) {
    console.log(`🌍 处理英文岗位: ${jobs.length} 个`);
    
    if (jobs.length === 0) return [];
    
    const { SentenceTransformer } = require('sentence-transformers');
    const model = new SentenceTransformer('all-MiniLM-L6-v2');
    
    // 批量生成嵌入
    const embeddings = await model.encode(
      jobs.map(job => this.getJobText(job))
    );
    
    // 计算相似度
    const results = jobs.map((job, index) => ({
      ...job,
      embedding: embeddings[index],
      similarity: this.calculateCosineSimilarity(
        this.candidateProfile.vectorEmbedding,
        embeddings[index]
      ),
      source: 'sentence-transformers'
    }));
    
    // 排序并取 Top K
    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.config.topK);
  }

  /**
   * 生成 Qwen3-Embedding
   */
  async generateQwenEmbeddings(texts) {
    console.log('🇨🇳 生成 Qwen3-Embedding...');
    
    const embeddings = [];
    
    for (let i = 0; i < texts.length; i += 10) {
      const batch = texts.slice(i, i + 10);
      
      const response = await fetch(this.config.chineseEmbedding.apiEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.chineseEmbedding.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.chineseEmbedding.model,
          input: batch,
          parameters: {
            text_type: 'document'
          }
        })
      });
      
      const data = await response.json();
      const batchEmbeddings = data.output.embeddings;
      
      embeddings.push(...batchEmbeddings);
      
      if (i % 50 === 0) {
        console.log(`📈 已处理 ${Math.min(i + 10, texts.length)}/${texts.length} 个文本`);
      }
    }
    
    return embeddings;
  }

  /**
   * 重排序（使用 Qwen3-Reranker）
   */
  async rerank(jobs) {
    console.log('🔄 使用 Qwen3-Reranker 进行重排序...');
    
    if (jobs.length <= this.config.finalTopK) {
      return jobs;
    }
    
    const candidateText = this.candidateProfile.getProfileText();
    const jobTexts = jobs.map(job => this.getJobText(job));
    
    // 分批处理
    const rerankedJobs = [];
    
    for (let i = 0; i < jobs.length; i += 5) {
      const batchJobs = jobs.slice(i, i + 5);
      const batchTexts = jobTexts.slice(i, i + 5);
      
      const response = await fetch(this.config.reranker.apiEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.reranker.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.reranker.model,
          documents: batchTexts,
          query: candidateText,
          parameters: {
            top_n: batchTexts.length,
            return_documents: false
          }
        })
      });
      
      const data = await response.json();
      const scores = data.output.top_k;
      
      batchJobs.forEach((job, index) => {
        const score = scores[index] || 0;
        rerankedJobs.push({
          ...job,
          rerankerScore: score.score,
          rerankerRank: score.index,
          combinedScore: this.combineScores(job.similarity, score.score)
        });
      });
    }
    
    // 排序并取最终 Top K
    return rerankedJobs
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, this.config.finalTopK);
  }

  /**
   * LLM 深度分析（使用 GLM-4.5-Air）
   */
  async llmAnalysis(jobs) {
    console.log('🧠 使用 GLM-4.5-Air 进行深度分析...');
    
    const results = [];
    
    for (const job of jobs) {
      try {
        const analysis = await this.analyzeJobWithGLM(job);
        
        results.push({
          ...job,
          ...analysis,
          analysisTimestamp: new Date().toISOString(),
          confidence: this.calculateConfidence(analysis)
        });
        
        if (results.length % 5 === 0) {
          console.log(`📊 已完成 ${results.length}/${jobs.length} 个岗位的分析`);
        }
        
      } catch (error) {
        console.warn(`❌ 岗位 ${job.id} GLM 分析失败:`, error.message);
        // 降级处理
        results.push({
          ...job,
          overallScore: job.similarity * 100,
          explanation: 'GLM 分析失败，使用基础匹配',
          confidence: 0.5
        });
      }
    }
    
    return results;
  }

  /**
   * 使用 GLM-4.5-Air 分析岗位
   */
  async analyzeJobWithGLM(job) {
    const prompt = `
你是一个专业的职业匹配顾问。请基于以下信息分析候选人与岗位的匹配度：

候选人画像：
${this.candidateProfile.getProfileText()}

岗位信息：
标题：${job.title}
公司：${job.company}
描述：${job.description}
要求：${job.requirements || ''}

请从以下维度进行分析：
1. 技能匹配度（40%权重）
2. 经验适配度（30%权重）
3. 工作方式匹配度（20%权重）
4. 文化适配度（10%权重）

输出格式：
{
  "skillMatches": ["技能1", "技能2"],
  "skillGaps": ["技能A", "技能B"],
  "remoteFit": 85,
  "experienceFit": 90,
  "culturalFit": 75,
  "overallScore": 85,
  "explanation": "详细解释",
  "personalizedAdvice": ["建议1", "建议2"]
}
`;

    const response = await fetch(this.config.llm.apiEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.llm.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.llm.model,
        input: prompt,
        parameters: {
          max_tokens: this.config.llm.maxTokens,
          temperature: this.config.llm.temperature
        }
      })
    });

    const data = await response.json();
    const result = JSON.parse(data.output.text);
    
    return result;
  }

  /**
   * 计算置信度
   */
  calculateConfidence(analysis) {
    const factors = [
      analysis.overallScore / 100,
      analysis.remoteFit / 100,
      analysis.experienceFit / 100,
      analysis.culturalFit / 100
    ];
    
    return factors.reduce((sum, factor) => sum + factor, 0) / factors.length;
  }

  /**
   * 组合分数
   */
  combineScores(similarity, rerankerScore) {
    const embeddingWeight = 0.6;
    const rerankerWeight = 0.4;
    
    return similarity * embeddingWeight + rerankerScore * rerankerWeight;
  }

  /**
   * 最终排序
   */
  finalSort(results) {
    return results
      .filter(result => result.overallScore >= this.config.scoreThreshold)
      .sort((a, b) => b.overallScore - a.overallScore)
      .map((result, index) => ({
        ...result,
        rank: index + 1,
        recommendation: this.getRecommendationLevel(result.overallScore, result.confidence)
      }));
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
   * 计算余弦相似度
   */
  calculateCosineSimilarity(vecA, vecB) {
    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    
    return dotProduct / (magnitudeA * magnitudeB);
  }

  /**
   * 获取岗位文本
   */
  getJobText(job) {
    return `${job.title} ${job.company} ${job.description} ${job.requirements || ''}`;
  }

  /**
   * 获取匹配统计
   */
  getMatchStats(results) {
    return {
      total: results.length,
      highScore: results.filter(r => r.overallScore >= 80).length,
      mediumScore: results.filter(r => r.overallScore >= 60 && r.overallScore < 80).length,
      lowScore: results.filter(r => r.overallScore < 60).length,
      averageScore: results.reduce((sum, r) => sum + r.overallScore, 0) / results.length,
      chineseJobs: results.filter(r => r.source === 'qwen-embedding').length,
      englishJobs: results.filter(r => r.source === 'sentence-transformers').length
    };
  }
}

module.exports = HybridMatcher;