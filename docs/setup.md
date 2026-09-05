# Remote Work Radar - 环境设置指南

## 快速开始

### 1. 克隆项目
```bash
git clone <your-repo-url>
cd remote-work-radar
```

### 2. 环境要求
- Node.js 18+
- Docker & Docker Compose
- Git

### 3. 安装依赖
```bash
npm install
```

### 4. 环境配置
```bash
# 复制环境变量模板
cp .env.example .env

# 编辑环境变量
nano .env
```

### 5. 启动服务
```bash
# 启动数据库
docker-compose up -d postgres

# 初始化数据库
docker exec -i remote-job-monitor-postgres psql -U job_monitor -d job_monitor < sql/create_jobs_table.sql

# 启动应用
npm run dev
```

## 详细配置

### 数据库配置
```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=job_monitor
DB_USER=job_monitor
DB_PASSWORD=your_password
```

### AI 服务配置
```env
SILICONFLOW_API_KEY=your_api_key
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_MODEL=deepseek-ai/deepseek-r1
```

### n8n 配置
```env
N8N_HOST=http://localhost:5678
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=admin
```

## 开发工作流

### 1. 数据采集
```bash
# 启动 n8n
n8n start

# 导入工作流
# 从 workflows/ 目录导入相应的工作流文件
```

### 2. AI 评分
```bash
# 运行国内岗位评分
npm run score-domestic

# 运行国外岗位评分
npm run score-global
```

### 3. 生成报告
```bash
# 生成看板
npm run generate-view

# 查看输出
open output/big-pool-view.html
```

### 4. 测试
```bash
# 运行测试
npm test

# 运行代码检查
npm run lint
```

## 部署

### 开发环境
```bash
docker-compose -f docker-compose.dev.yml up -d
```

### 生产环境
```bash
docker-compose -f docker-compose.prod.yml up -d
```

## 常见问题

### 1. 数据库连接失败
```bash
# 检查服务状态
docker-compose ps

# 查看日志
docker-compose logs postgres
```

### 2. API 调用失败
```bash
# 检查 API 密钥
echo $SILICONFLOW_API_KEY

# 测试 API 连接
curl -H "Authorization: Bearer $SILICONFLOW_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model": "deepseek-ai/deepseek-r1", "messages": [{"role": "user", "content": "Hello"}]}' \
     $SILICONFLOW_BASE_URL/chat/completions
```

### 3. n8n 工作流失败
```bash
# 检查 n8n 日志
docker-compose logs n8n

# 手动触发工作流
# 登录 n8n 界面，手动运行工作流
```

## 项目结构

```
remote-work-radar/
├── config/           # 配置文件
├── scripts/          # 脚本工具
├── workflows/        # n8n 工作流
├── output/           # 输出文件
├── docs/             # 文档
├── src/              # 源代码
└── tests/            # 测试文件
```

## 下一步

1. 配置个人画像
2. 设置数据源
3. 运行数据采集
4. 测试 AI 评分
5. 生成可视化报告