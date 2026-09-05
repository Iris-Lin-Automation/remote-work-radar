# Remote Work Radar - 匹配架构设计文档

## 架构概述

本项目采用三层匹配架构，实现从海量岗位到精准推荐的完整流程：

```
10000 个岗位
     ↓
👀  快速扫 (Embedding)
     ↓
100 个
     ↓
🔍  仔细排 (Reranker)
     ↓
20 个
     ↓
🧠  深度理解 (LLM + 规则)
     ↓
5 个
```

## 核心理念

### 从"简历匹配"到"人岗匹配"
- **传统方式**: 简历文本 vs JD 文本的关键词匹配
- **升级方式**: Candidate Profile vs Job Opportunity 的语义理解匹配

### Candidate Profile 的价值
不仅仅是技能列表，而是完整的个人画像：

```javascript
{
  // 我能做
  skills: [
    { name: 'Python', category: 'programming', proficiency: 4 },
    { name: '数据分析', category: 'analysis', proficiency: 4 },
    { name: 'AI Agent', category: 'ai', proficiency: 3 }
  ],
  
  // 我做过
  projects: [
    { title: 'B2B业务分析系统', technologies: ['Python', 'SQL', 'Pandas'] },
    { title: 'AI智能体获客系统', technologies: ['Dify', 'Hunter.io', 'LLM'] }
  ],
  
  // 我喜欢
  preferences: {
    workStyle: ['remote', 'async'],
    industries: ['technology', 'internet'],
    remote: true,
    asyncWork: true
  },
  
  // 我不要
  constraints: {
    exclude: ['坐班', '高频电话'],
    minExperience: 2,
    maxExperience: 5
  },
  
  // 我的目标
  careerGoals: {
    targetRoles: ['数据分析师', 'AI工程师'],
    growthAreas: ['机器学习', '自动化']
  }
}
```

## 三层匹配架构详解

### 第一层：Embedding 快速筛选

**目标**: 从 10000 个岗位中快速筛选出 100 个候选

**技术实现**:
- 使用 `sentence-transformers/all-MiniLM-L6-v2` 生成向量嵌入
- 计算候选人画像与岗位描述的余弦相似度
- 按相似度排序，取 Top 100

**关键优势**:
- 速度快：批量处理 10000 个岗位约 30 秒
- 语义理解：捕捉技能、经验、偏好的深层含义
- 可扩展：支持增量更新和实时匹配

**代码实现**:
```javascript
// 生成候选人向量
const candidateEmbedding = await model.encode(candidateProfileText);

// 批量计算岗位向量
const jobEmbeddings = await model.encode(jobDescriptions);

// 计算相似度
const similarities = jobEmbeddings.map(embedding => 
  calculateCosineSimilarity(candidateEmbedding, embedding)
);

// 排序筛选
const topJobs = jobs
  .map((job, index) => ({ ...job, similarity: similarities[index] }))
  .sort((a, b) => b.similarity - a.similarity)
  .slice(0, 100);
```

### 第二层：Reranker 精排

**目标**: 从 100 个候选岗位中精排选出 20 个

**技术实现**:
- 使用 `BAAI/bge-reranker-base` 进行重排序
- 考虑技能匹配度、经验要求、工作方式等多个维度
- 生成更精细的相关性分数

**关键优势**:
- 多维度评估：不仅仅是语义相似度
- 上下文理解：考虑技能关系和业务逻辑
- 可解释性：提供详细的匹配分析

**代码实现**:
```javascript
// 使用重排序模型
const reranker = await CrossEncoder.fromPretrained('bge-reranker-base');

// 计算相关性分数
const scores = await reranker.predict([
  [candidateText, job1Text],
  [candidateText, job2Text],
  // ...
]);

// 综合评分
const rerankedJobs = jobs.map((job, index) => ({
  ...job,
  rerankerScore: scores[index],
  combinedScore: job.similarity * 0.6 + scores[index] * 0.4
}));
```

### 第三层：LLM 深度判断

**目标**: 从 20 个岗位中深度分析出 5 个最匹配的

**技术实现**:
- 使用 DeepSeek/R1 进行深度分析
- 结合 Candidate Profile 进行个性化匹配
- 应用业务规则进行约束检查

**关键优势**:
- 个性化匹配：基于个人画像的定制化分析
- 深度理解：捕捉岗位要求和个人能力的深层匹配
- 可解释性：提供详细的匹配理由和建议

**代码实现**:
```javascript
// 深度分析每个岗位
const finalResults = [];

for (const job of top20Jobs) {
  const matchResult = await candidateProfile.calculateJobMatch(job);
  
  finalResults.push({
    ...job,
    ...matchResult,
    overallScore: calculateOverallScore(matchResult),
    personalizedAdvice: generateAdvice(matchResult, job)
  });
}
```

## Candidate Profile 系统

### 技能图谱构建

**技能分类体系**:
```javascript
const skillCategories = {
  programming: ['Python', 'JavaScript', 'Java', 'Go', 'C++'],
  frameworks: ['React', 'Django', 'Node.js', 'Spring Boot'],
  databases: ['PostgreSQL', 'MongoDB', 'Redis', 'MySQL'],
  cloud: ['AWS', 'Azure', 'GCP', 'Kubernetes'],
  tools: ['n8n', 'Git', 'Docker', 'Jenkins'],
  analysis: ['Pandas', 'NumPy', 'Scikit-learn', 'Tableau'],
  ai: ['TensorFlow', 'PyTorch', 'LangChain', 'OpenAI'],
  business: ['数据分析', '业务分析', '项目管理']
};
```

**技能关系网络**:
- 直接技能：Python → 数据分析
- 相关技能：React → JavaScript
- 依赖技能：机器学习 → Python

### 多维度匹配算法

**技能匹配分析**:
```javascript
skillMatches = candidateSkills.filter(skill => 
  jobRequirements.some(req => 
    isSkillMatch(skill.name, req)
  )
);

skillGaps = jobRequirements.filter(req => 
  !candidateSkills.some(skill => 
    isSkillMatch(skill.name, req)
  )
);
```

**工作方式匹配**:
- 远程适配度：检查是否支持远程工作
- 时区重叠：评估时区兼容性
- 异步友好：判断是否支持异步工作

**经验适配度**:
```javascript
experienceFit = calculateExperienceFit(
  candidateExperience,
  jobMinExperience,
  jobMaxExperience
);
```

## 规则引擎

### 硬性约束规则

```javascript
const hardConstraints = {
  // 排除关键词
  excludeKeywords: ['客服', '销售', '高频电话', '坐班'],
  
  // 必须包含关键词
  mustHaveKeywords: [],
  
  // 优选关键词
  preferredKeywords: ['remote', 'async', '分布式'],
  
  // 硬性约束
  maxExperienceGap: 3, // 最大经验差距
  minRemoteScore: 50,  // 最低远程适配度
  excludeOnsite: true  // 排除坐班岗位
};
```

### 软性增强规则

```javascript
const softRules = {
  // 薪资匹配
  salaryRange: { min: 15, max: 30, currency: 'k' },
  
  // 公司规模偏好
  companySize: 'medium', // startup, small, medium, large
  
  // 行业偏好
  industries: ['technology', 'internet', 'finance'],
  
  // 团队类型偏好
  teamType: ['remote-first', 'distributed']
};
```

## 评分体系

### 综合分数计算

```javascript
const weights = {
  skills: 0.4,      // 技能匹配权重
  remote: 0.2,      // 远程适配权重
  cultural: 0.2,    // 文化适配权重
  experience: 0.2   // 经验适配权重
};

overallScore = (
  skillScore * weights.skills +
  remoteScore * weights.remote +
  culturalScore * weights.cultural +
  experienceScore * weights.experience
);
```

### 推荐等级划分

- **强烈推荐** (80-100分): 高匹配度，高置信度
- **推荐** (70-79分): 良好匹配，中等置信度
- **考虑** (60-69分): 基本匹配，需要优化
- **备选** (50-59分): 低匹配度，可作为备选
- **不推荐** (<50分): 不建议投递

## 性能优化

### 批量处理策略

```javascript
// 分批处理大量岗位
async function batchMatch(jobs, batchSize = 20) {
  const results = [];
  
  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);
    const batchResults = await matchJobs(batch);
    results.push(...batchResults);
    
    // 批次间延迟，避免 API 限制
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return results;
}
```

### 缓存机制

```javascript
// 向量嵌入缓存
const embeddingCache = new Map();

async function getCachedEmbedding(text) {
  if (embeddingCache.has(text)) {
    return embeddingCache.get(text);
  }
  
  const embedding = await model.encode(text);
  embeddingCache.set(text, embedding);
  return embedding;
}
```

### 异步并发

```javascript
// 并发处理多个岗位
const promises = jobs.map(job => processJob(job));
const results = await Promise.all(promises);
```

## 监控与分析

### 匹配质量监控

```javascript
const matchStats = {
  totalJobs: processedJobs.length,
  highScoreCount: processedJobs.filter(j => j.score >= 80).length,
  averageScore: processedJobs.reduce((sum, j) => sum + j.score, 0) / processedJobs.length,
  averageConfidence: processedJobs.reduce((sum, j) => sum + j.confidence, 0) / processedJobs.length
};
```

### 技能趋势分析

```javascript
const skillTrends = {
  inDemand: [],     // 热门技能
  emerging: [],     // 新兴技能
  declining: []     // 衰落技能
};
```

## 技术栈对比

| 层级 | 传统方式 | 升级方式 | 优势 |
|------|---------|---------|------|
| 筛选 | 关键词匹配 | 向量嵌入 | 语义理解，速度更快 |
| 精排 | 简单排序 | 重排序模型 | 多维度评估，更精准 |
| 判断 | 规则引擎 | LLM + 规则 | 个性化，可解释 |

## 未来演进方向

### 短期优化
1. **增加更多数据源**：LinkedIn、Indeed、Glassdoor
2. **优化技能图谱**：更精细的技能分类和关系
3. **增强规则引擎**：更多业务规则和约束条件

### 中期发展
1. **半监督学习**：基于用户反馈优化匹配算法
2. **多目标优化**：薪资、发展、文化等多维度平衡
3. **实时推荐**：基于用户行为的动态推荐

### 长期愿景
1. **专用模型**：训练针对招聘场景的专用 embedding 模型
2. **知识图谱**：构建完整的职业发展知识图谱
3. **个性化服务**：基于个人历史的深度个性化推荐

---

**文档更新时间**: 2026-09-02
**当前状态**: 三层匹配架构已实现，正在进行测试和优化