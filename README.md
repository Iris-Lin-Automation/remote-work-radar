# Remote Work Radar

AI 驱动的远程岗位情报与筛选系统，聚合多源招聘信息，帮助候选人快速判断岗位是否适合自己，并提供更高质量的投递决策支持。

## 项目简介
这个项目的目标是：
- 聚合海外远程岗位信息
- 自动识别“是否真的远程 / 是否适合中国候选人”
- 对岗位进行意图识别、技能匹配和排序
- 输出简洁清晰的职位分析结果，减少人工筛选成本

适合用于：
- 远程岗位监控
- AI 语义筛选
- 求职者的岗位匹配分析
- 数据采集与简历定制工作流

## 核心功能
- 多源岗位采集：V2EX、电鸭社区、RemoteOK、WeWorkRemotely 等
- 统一去重与状态跟踪
- AI 识别岗位类型和匹配程度
- 中国候选人适配性判断
- 结果输出到 HTML / CSV / 报告页面
- 可扩展的 n8n + Node.js 自动化工作流

## 技术栈
- Node.js 18+
- PostgreSQL
- Docker / Docker Compose
- Python 3.10+
- n8n
- LLM API（DeepSeek / Qwen / Moonshot 等）
- Jest + ESLint

## 项目结构
```bash
remote-work-radar/
├── .env.example             # 环境变量示例
├── .gitignore               # Git 忽略规则
├── README.md                # 项目说明
├── PROJECT_MEMORY.md        # 项目长期记忆与经验记录
├── TODO.md                  # 待办和迭代计划
├── package.json             # Node.js 项目配置
├── docker-compose.yml       # Docker 服务配置
├── config/                  # 个人画像和配置文件
├── scripts/                 # 数据处理与输出脚本
├── src/                     # 核心应用源码
├── sql/                     # 数据库脚本
├── workflows/               # n8n 工作流
├── docs/                    # 文档说明
├── output/                  # 生成的结果文件
├── research/                # 调研资料和抓取结果
├── data/                    # 本地数据缓存（通常不上传）
├── node_modules/            # 依赖包（本地安装，不建议提交）
└── package-lock.json        # 锁定依赖版本
```

## 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
复制示例文件：
```bash
cp .env.example .env
```
编辑 `.env`，填入自己的 LLM API Key 和基础配置。

示例：
```bash
DOMESTIC_LLM_API_KEY=your_api_key
DOMESTIC_LLM_BASE_URL=https://api.deepseek.com/v1
DOMESTIC_LLM_MODEL=deepseek-chat
```

### 3. 启动数据库
```bash
docker-compose up -d
```

### 4. 启动项目
```bash
npm start
```

### 5. 运行脚本
```bash
npm run score-domestic
npm run generate-view
```

## 关键配置
- `.env`：敏感配置，不能上传到 GitHub
- `.env.example`：给其他用户参考的模板文件，可以上传
- `config/my-profile.md`：你的个人画像与技术背景配置
- `workflows/`：自动化采集/处理流程

## 上传到 GitHub 时应该上传什么
建议上传这些内容：

必须上传：
- `src/`
- `scripts/`
- `config/`（如无敏感信息）
- `sql/`
- `workflows/`
- `docs/`
- `package.json`
- `package-lock.json`
- `.gitignore`
- `.env.example`
- `README.md`
- `PROJECT_MEMORY.md`
- `TODO.md`
- `docker-compose.yml`

不要上传：
- `.env`（包含 API Key、数据库凭据等敏感信息）
- `node_modules/`
- `data/` 中的浏览器缓存和本地缓存
- `output/` 中的生成结果（如果不需要公开）
- 任何真实账号、token、个人配置文件

如果项目对外公开，推荐保留一个模板化的内容，并将敏感信息放到 `.env` 本地，不提交到 GitHub。

## Git 提交建议
```bash
git init
git add .
git commit -m "feat: initialize remote work radar"
git branch -M main
git remote add origin https://github.com/<your-username>/remote-work-radar.git
git push -u origin main
```

## 许可证
MIT License

## 说明
这个项目适合用来展示：
- AI + 数据抓取 + 远程岗位筛选
- 自动化工作流
- 个人求职与岗位匹配能力

如果你准备把它公开发布到 GitHub，建议先保留代码和文档，去掉本地敏感配置和缓存文件，再推送。