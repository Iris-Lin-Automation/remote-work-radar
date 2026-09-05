/**
 * Candidate Profile - 候选人画像
 * 包含个人技能、经验、偏好等信息
 */

class CandidateProfile {
  constructor() {
    this.skills = [
      'Python', 'JavaScript', 'TypeScript', 'SQL', 'React', 'Next.js', 
      'FastAPI', 'LangGraph', 'LangChain', 'OpenAI', 'Claude', 'DeepSeek',
      'Dify', '飞书API', 'n8n', 'Make', 'RPA', 'pandas', 'numpy',
      '数据分析', 'AI自动化', 'B2B获客', '跨境电商', '电商运营',
      '千川投放', 'ROI分析', 'API集成', '全栈开发', '前端开发',
      '后端开发', '产品方案', '业务分析', '流程优化'
    ];
    
    this.experience = {
      total_years: 3,
      industries: ['跨境电商', 'AI应用', 'B2B SaaS', '电商'],
      roles: ['AI自动化工程师', '全栈开发工程师', '产品经理', '数据分析师']
    };
    
    this.preferences = {
      remote_only: true,
      async_work: true,
      international_team: true,
      tech_business_mix: true,
      avoid_sales_pressure: true,
      avoid_customer_service: true,
      avoid_phone_calls: true,
      avoid_office_work: true
    };
    
    this.skillsMapping = {
      'Python': ['Python', 'Python3', 'Python 3'],
      'JavaScript': ['JavaScript', 'JS', 'ES6', 'ES2020'],
      'React': ['React', 'React.js', 'ReactJS', 'Next.js', 'NextJS'],
      'FastAPI': ['FastAPI', 'Fast API', 'Python FastAPI'],
      'LangGraph': ['LangGraph', 'Lang Graph', 'LangChain Graph'],
      'AI自动化': ['AI自动化', 'AI Automation', '自动化', 'Automation'],
      'B2B获客': ['B2B获客', 'B2B销售', 'B2B Marketing', '销售自动化'],
      '跨境电商': ['跨境电商', 'Cross-border', 'E-commerce', '电商'],
      '数据分析': ['数据分析', 'Data Analysis', '数据挖掘', 'Data Mining']
    };
    
    this.vectorEmbedding = null;
  }
  
  /**
   * 生成向量嵌入
   */
  async generateEmbedding() {
    console.log('🔄 生成候选人画像向量嵌入...');
    
    // 使用简化的嵌入方法
    const profileText = this.getProfileText();
    
    // 这里应该使用真正的嵌入模型，现在用模拟数据
    this.vectorEmbedding = this.simulateEmbedding(profileText);
    
    console.log('✅ 向量嵌入生成完成');
    return this.vectorEmbedding;
  }
  
  /**
   * 获取候选人画像文本
   */
  getProfileText() {
    return `
AI自动化方案架构师，专注于跨境电商和B2B获客领域
核心技能：Python、React、FastAPI、LangGraph、AI自动化、数据分析
项目经验：AI_Find_Customer、LinkedIn_B2B_Agent、qianchuan-feishu
工作偏好：Remote/Async、国际团队、技术+商业结合、独立交付
职业目标：AI自动化工程师、AI应用架构师、全栈开发者
`;
  }
  
  /**
   * 计算岗位匹配度
   */
  async calculateJobMatch(job) {
    const jobText = `${job.title} ${job.description} ${job.requirements}`;
    
    // 1. 技能匹配分析
    const skillMatches = this.findSkillMatches(jobText);
    const skillGaps = this.findSkillGaps(jobText);
    
    // 2. 经验适配分析
    const experienceFit = this.calculateExperienceFit(job);
    
    // 3. 工作方式匹配分析
    const remoteFit = this.calculateRemoteFit(job);
    
    // 4. 文化适配分析
    const culturalFit = this.calculateCulturalFit(job);
    
    // 5. 计算总分
    const skillScore = Math.min(skillMatches.length * 15, 60); // 技能匹配最多60分
    const experienceScore = experienceFit * 30; // 经验适配最多30分
    const remoteScore = remoteFit * 10; // 远程适配最多10分
    const culturalScore = culturalFit * 10; // 文化适配最多10分
    
    const overallScore = Math.round(skillScore + experienceScore + remoteScore + culturalScore);
    
    // 6. 生成解释
    const explanation = this.generateExplanation(skillMatches, skillGaps, experienceFit, remoteFit, culturalFit);
    
    // 7. 生成建议
    const personalizedAdvice = this.generatePersonalizedAdvice(skillGaps, job);
    
    return {
      skillMatches,
      skillGaps,
      experienceFit,
      remoteFit,
      culturalFit,
      overallScore,
      explanation,
      personalizedAdvice,
      confidence: this.calculateConfidence(overallScore, skillMatches.length, skillGaps.length)
    };
  }
  
  /**
   * 查找技能匹配
   */
  findSkillMatches(jobText) {
    const matches = [];
    const lowerJobText = jobText.toLowerCase();
    
    for (const skill of this.skills) {
      // 检查技能映射
      const mappedSkills = this.skillsMapping[skill] || [skill];
      
      for (const mappedSkill of mappedSkills) {
        if (lowerJobText.includes(mappedSkill.toLowerCase())) {
          matches.push(skill);
          break;
        }
      }
    }
    
    return [...new Set(matches)]; // 去重
  }
  
  /**
   * 查找技能缺口
   */
  findSkillGaps(jobText) {
    const requiredSkills = this.extractRequiredSkills(jobText);
    const matches = this.findSkillMatches(jobText);
    
    const gaps = requiredSkills.filter(skill => !matches.includes(skill));
    return gaps.slice(0, 5); // 最多显示5个缺口
  }
  
  /**
   * 提取要求的技能
   */
  extractRequiredSkills(jobText) {
    const commonSkills = [
      'Python', 'JavaScript', 'React', 'Vue', 'Angular', 'Node.js',
      'Java', 'C++', 'Go', 'Rust', 'SQL', 'NoSQL',
      'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes',
      '机器学习', '深度学习', 'AI', '数据分析', '数据科学',
      '产品管理', '项目管理', '敏捷开发', 'Scrum'
    ];
    
    const foundSkills = [];
    const lowerJobText = jobText.toLowerCase();
    
    for (const skill of commonSkills) {
      if (lowerJobText.includes(skill.toLowerCase())) {
        foundSkills.push(skill);
      }
    }
    
    return foundSkills;
  }
  
  /**
   * 计算经验适配度
   */
  calculateExperienceFit(job) {
    if (!job.experience_years_min) return 0.8; // 没有经验要求，默认80%
    
    const minYears = job.experience_years_min;
    const maxYears = job.experience_years_max || minYears;
    
    if (this.experience.total_years >= minYears && this.experience.total_years <= maxYears) {
      return 1.0; // 完美匹配
    } else if (this.experience.total_years < minYears) {
      return Math.max(0.3, this.experience.total_years / minYears); // 经验不足，按比例计算
    } else {
      return Math.max(0.7, 1 - (this.experience.total_years - maxYears) / maxYears); // 经验过剩，适当降低
    }
  }
  
  /**
   * 计算远程适配度
   */
  calculateRemoteFit(job) {
    if (job.is_remote) {
      return 1.0; // 明确支持远程
    } else if (job.location && job.location.includes('Remote')) {
      return 0.9; // 提到远程
    } else if (job.location && (job.location.includes('广州') || job.location.includes('深圳'))) {
      return 0.7; // 本地城市，可能支持远程
    } else {
      return 0.3; // 没有提到远程
    }
  }
  
  /**
   * 计算文化适配度
   */
  calculateCulturalFit(job) {
    let score = 0.5; // 基础分
    
    // 根据公司类型和行业调整
    if (job.company && job.company.includes('科技')) {
      score += 0.2;
    }
    if (job.company && job.company.includes('AI')) {
      score += 0.3;
    }
    if (job.company && job.company.includes('互联网')) {
      score += 0.1;
    }
    
    // 根据行业调整
    if (job.industry && this.experience.industries.includes(job.industry)) {
      score += 0.2;
    }
    
    return Math.min(1.0, score);
  }
  
  /**
   * 生成匹配解释
   */
  generateExplanation(skillMatches, skillGaps, experienceFit, remoteFit, culturalFit) {
    const skillMatchText = skillMatches.length > 0 ? `技能匹配${skillMatches.length}项` : '技能匹配较少';
    const skillGapText = skillGaps.length > 0 ? `存在${skillGaps.length}项技能缺口` : '技能要求基本匹配';
    
    const experienceText = experienceFit >= 0.8 ? '经验要求适配良好' : '经验要求有一定差距';
    const remoteText = remoteFit >= 0.8 ? '远程工作适配良好' : '远程工作适配一般';
    const culturalText = culturalFit >= 0.7 ? '企业文化适配良好' : '企业文化适配一般';
    
    return `${skillMatchText}，${skillGapText}。${experienceText}，${remoteText}，${culturalText}。`;
  }
  
  /**
   * 生成个性化建议
   */
  generatePersonalizedAdvice(skillGaps, job) {
    const advice = [];
    
    if (skillGaps.length > 0) {
      advice.push(`重点学习：${skillGaps.slice(0, 3).join('、')}`);
    }
    
    if (job.experience_years_min && job.experience_years_min > this.experience.total_years) {
      advice.push('考虑强调相关项目经验以弥补经验差距');
    }
    
    if (job.is_remote) {
      advice.push('突出远程工作经验和异步协作能力');
    }
    
    if (job.company && job.company.includes('AI')) {
      advice.push('准备AI相关的技术案例和项目展示');
    }
    
    return advice;
  }
  
  /**
   * 计算置信度
   */
  calculateConfidence(overallScore, skillMatches, skillGaps) {
    const scoreFactor = overallScore / 100;
    const skillFactor = Math.min(skillMatches / 5, 1);
    const gapFactor = Math.max(0, 1 - skillGaps / 10);
    
    return (scoreFactor + skillFactor + gapFactor) / 3;
  }
  
  /**
   * 模拟向量嵌入
   */
  simulateEmbedding(text) {
    // 这里应该使用真正的嵌入模型，现在用随机数据模拟
    const embedding = [];
    for (let i = 0; i < 384; i++) {
      embedding.push(Math.random() * 2 - 1); // -1 到 1 之间的随机数
    }
    return embedding;
  }
}

module.exports = CandidateProfile;