# Cloud Deployment — Remote Job Copilot (P0)

目标：不跑本地 Docker / 不依赖本机 Postgres / 电脑不必常开，也能自动抓岗写入 **Supabase**，并用 **Cloudflare Worker** 做 Telegram 双向对话。

> 本文只写配置步骤。在你完成 Secrets + SQL + `setWebhook` 并跑通测试之前，**不能宣称云端已部署成功**。

---

## 0. 审计结论（最小变更）

| 组件 | 数据库访问 | 环境变量 |
|------|------------|----------|
| GitHub Actions `run-radar-cycle` | `pg` → `DATABASE_URL`（Supabase pooler） | `TELEGRAM_*`, `GROQ_*`, `DATABASE_URL` |
| Cloudflare Worker | Supabase **REST** | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_*`, `GROQ_*`, `TELEGRAM_WEBHOOK_SECRET` |
| 本地 `npm run chat` | 可选 DB；否则 JSON | 仅调试；生产用 Worker |
| `pushed_jobs.json` | 历史导入源 | `npm run import-legacy` |

本机 `.env` 若仍是 `localhost:5432` → **必须改成 Supabase pooler**。

---

## 1. Supabase

1. 创建项目 → **SQL Editor** 执行整份：
   - [`sql/create_radar_cloud_bootstrap.sql`](sql/create_radar_cloud_bootstrap.sql)
2. **Project Settings → API**
   - `SUPABASE_URL` = Project URL  
   - `SUPABASE_SERVICE_ROLE_KEY` = `service_role`（**仅服务器 / Worker / Actions**，禁止进前端）
3. **Database → Connect → Transaction pooler**
   - 复制 URI → `DATABASE_URL`  
   - 形如：`postgresql://postgres.xxx:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres`
4. 健康检查（本机，URL 已改非 localhost）：
   ```bash
   npm run test:cloud-p0
   ```

---

## 2. GitHub Actions Secrets

Repo → Settings → Secrets and variables → Actions，设置：

| Secret | 用途 |
|--------|------|
| `TELEGRAM_BOT_TOKEN` | 推送 +（可选）调试 |
| `TELEGRAM_CHAT_ID` | 你的 user/chat id |
| `GROQ_API_KEY` | 六维评分 |
| `GROQ_MODEL` | `openai/gpt-oss-20b`（也可写死在 workflow） |
| `DATABASE_URL` | Supabase **Transaction pooler** URI |
| `SUPABASE_URL` | Project URL（REST 兜底 / 与 Worker 相同） |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role / Secret key（REST 兜底） |

Workflow 读 `DATABASE_URL`；pg 失败时用 `SUPABASE_*` REST 双写。CI 下云库不可用会失败（避免假装没岗）。

手动跑：Actions → Remote Work Radar → Run workflow。

---

## 3. 历史导入

```bash
# .env 中 DATABASE_URL 已指向 Supabase
npm run import-legacy
```

- 从 `data/pushed_jobs.json` 导入  
- `legacy_import=true`（不当新岗刷推送）  
- 过旧标记 `expired`  
- 打印 total / success / duplicate / failed

---

## 4. Cloudflare Worker（Telegram Webhook）

```bash
cd workers/telegram-webhook
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ALLOWED_TELEGRAM_USER_ID   # 同 TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET    # 自拟长随机串
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GROQ_MODEL                 # openai/gpt-oss-20b
npx wrangler deploy
```

设置 Webhook（替换域名与 secret）：

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://remote-job-copilot-tg.<ACCOUNT>.workers.dev/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

验证：

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

手机对 Bot：`/status` → `/apply` → `/review` → `/check https://...`

---

## 5. 命令语义

| 命令 | 行为 |
|------|------|
| `/apply` | 仅 `china_eligible=true` 且评分成功的可投标 |
| `/review` | `unclear` / `score_status=error` / `verify` |
| `/status` | DB + 最近 `radar_runs` 统计 |
| `/check <url>` | 人工提交，`source=manual`，绕过自动时间窗 |

Growix → `evergreen_contractor`；OpenTrain → `flexible_ai_tasks`（不进正式全职主榜 `apply_now`）。

---

## 6. 评分规则（P0）

- 模型：`GROQ_MODEL=openai/gpt-oss-20b`（勿再默认 `llama-3.1-8b-instant`）  
- 失败 → `score_status=error`，**不写假分 40/45/100**  
- 失败岗进入 `/review`（verify），**不能** `apply_now`  
- 缓存键：`dedup_key + jd_hash + profile_version + prompt_version`

---

## 7. 验收清单

- [ ] Supabase SQL 已执行  
- [ ] `DATABASE_URL` 非 localhost，`npm run test:cloud-p0` live DB = ok  
- [ ] `npm run import-legacy` 有成功数  
- [ ] Actions 跑通且 jobs 表有新行  
- [ ] Worker deployed + `getWebhookInfo` 显示 URL  
- [ ] Telegram `/status` 不报 DB 错误  

全部勾选前：**不要对外说云端部署成功**。
