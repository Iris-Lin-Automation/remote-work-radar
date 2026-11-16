# Remote Job Copilot — PRD 现状对照（2026-11-15）

> 结论先说：**还没有完整实现**你贴的那份「V0.2 Job Intelligence / ApplyPack 级」方案。  
> 现在是 **V0.1 Radar（能跑）+ V0.3 Copilot 半成品（能聊）**；**V0.2 的 Postgres 真库在本机是断的**，所以 Bot 说「一个岗都没有」——不是全世界没岗，是**正式评分库是空的 / 连不上**。

---

## 1. 产品版本对照

| 版本 | 目标 | 现状 |
|------|------|------|
| **V0.1 Job Radar** | 多源抓取 → 过滤 → 打分 → Telegram 推送 | ✅ 已上线（GitHub Actions 每 2h + 本地 `npm run radar-cycle`） |
| **V0.2 Job Intelligence** | Postgres 结构化、地区资格证据、按源水位、职位核验、状态机 | ⚠️ Schema/代码有了，**本机 DB 未跑通**；Himalayas cursor / 按源水位 / 有效性检查 **未做** |
| **V0.3 Job Copilot** | Telegram 双向：查岗、解释、改偏好 | ⚠️ 本地 `npm run chat` 可用；CF Worker 已写未强制部署；自然语言刚接上历史 JSON 知识库 |
| **V1.0 Workspace** | 网页工作台、申请进度、简历匹配 | ❌ 仅有旧 pool-view / application-manager 脚本，未成产品 |

---

## 2. 当前真实筛选流水线（你问的「筛选方式是什么样」）

```
多源抓取 (RSS/JSON/HTML/ATS)
    │
    ▼
时间窗过滤：统一 RADAR_MAX_AGE_HOURS（Actions 默认 24h；本地默认 4h）
    │  ⚠️ 尚未按源差异化（Himalayas 日更 / Remotive 延迟 / Jobicy 7 天）
    ▼
Layer 1 关键词白名单（画像技能：AI/自动化/数据/n8n/…）
    │  命中数 ≥ RADAR_L1_MIN_HITS（默认 1）
    ▼
Layer 1.5 Eligibility
    │  拒：签证锁死 / 地区锁 / 渣岗职业
    │  加分：worldwide、APAC、contractor、quality-role…
    ▼
Hard rules（规则，非 LLM）
    │  china_eligible = true | false | unclear
    │  work_mode / hire_vehicle / employment_type
    │  ★ Worldwide ≠ 中国可雇 → unclear 最多只能 verify
    ▼
Layer 2 Groq 六维分
    │  tech / delivery / level / workstyle / comp / trust
    │  加权 → 总分；可注入偏好摘要（DB 通时）
    ▼
recommendation_status
    │  apply_now | verify | skip
    ▼
双写：Postgres upsert（有 DATABASE_URL 且能连）+ seen_jobs.json
    ▼
Telegram：先推 apply_now，再推 verify；高分 apply_now 再发详情
```

### 推送门槛（代码逻辑）

| 状态 | 条件（简化） |
|------|----------------|
| `skip` | 签证/onsite/渣岗，或分数太低 |
| `verify` | 中国可雇 unclear，或分数在 verify 档 |
| `apply_now` | `china_eligible=true` 且总分 ≥70（权重可配）且 tech 够高 |

配置：`config/scoring-weights.json`（`apply_now_min=70`, `verify_min=40`）

---

## 3. 数据源现状 vs 你那张表的建议

| 来源 | 代码里有没有 | 定位建议 | 实际做到哪 |
|------|-------------|----------|------------|
| **Himalayas** | ✅ 有 | 核心 | ⚠️ 仍用 `limit=50&offset=0`（文档说 max 20 + cursor）；**没用** location/timezone/employment 前置筛；**没**单岗有效性 API；注释写了 cursor 但没实现 |
| **Remotive** | ✅ AI + Dev | 核心 | ⚠️ 当普通源抓；未标注 24h 延迟；来源归属字段弱 |
| **Jobicy** | ✅ APAC v2 | 核心 | ⚠️ 仍 `/api/v2/remote-jobs`；未用满 jobGeo/jobLevel/salary 结构化筛 |
| **WWR** | ✅ 多分类 RSS | 核心 | ✅ 可用 |
| **RemoteOK** | ✅ `/api` | 补充 | ✅ 有（RSS 410 已绕过） |
| **Growix** | ✅ HTML | 应单独分类 | ⚠️ **仍和正式全职混在同一 EN 轨推送** |
| **OpenTrain** | ✅ HTML | 副线兼职 | ⚠️ **同上，未拆「兼职/标注」轨道** |
| **Greenhouse/Ashby** | ✅ `config/ats-boards.json` | Watchlist | ✅ 有公司板列表抓取 |

---

## 4. 功能清单：已实现 / 半成品 / 未做

### ✅ 已实现（能用）

- 中英双轨抓取 + Telegram 分组推送  
- Layer1 关键词 + 签证/地区硬过滤 + Groq 打分（现六维）  
- `china_eligible` 硬规则：Worldwide ≠ apply_now  
- `seen_jobs.json` 跨 Actions 运行持久化（workflow 会 commit 回仓库）  
- `pushed_jobs.json` 保留最近推送历史（约 300 条）  
- ATS 公司板（Greenhouse/Ashby）  
- 本地对话 `npm run chat`（Token 修好后）  
- Copilot SQL 迁移文件、`scripts/db.js`、CF Worker 代码、偏好/反馈表设计  

### ⚠️ 半成品（有代码/文件，但未形成闭环）

- **Postgres 双写**：代码有，但本机 `DATABASE_URL=localhost:5432` **ECONNREFUSED**（没跑 Docker/Postgres）→ Bot `/apply` 空  
- **偏好写入评分**：依赖 DB；DB 断则无效  
- **CF Worker 双向 Bot**：写了，未作为默认线上入口  
- **Growix/OpenTrain 分流**：仍在 EN 主推混排  
- **历史岗「知识库问答」**：刚改为可读 `pushed_jobs.json`；不是完整结构化库  

### ❌ 明确未做（你贴文里的重点）

| 建议项 | 状态 |
|--------|------|
| Himalayas cursor 分页 + 官方参数前置筛 | ❌ |
| Himalayas 每日水位（不必 2h 全抓） | ❌ |
| 按来源不同时间窗 / 抓取水位 | ❌（仍统一 `MAX_AGE_HOURS`） |
| Remotive 延迟与 attribution 强化 | ❌ |
| Jobicy 新 API / 结构化字段筛 | ❌ |
| Growix=常青承包商单独分类 | ❌ |
| OpenTrain=兼职副线单独分类 | ❌ |
| 职位仍有效核验（alive check） | ❌ |
| ApplyPack 式 Normalize→Dedup→规则→AI→Dashboard | ❌ 仅 Radar 简化版 |
| JobRadar 式 New→Shortlisted→Applied→Interview | ⚠️ 有 `pipeline_status` 字段/旧脚本，未接 Telegram Copilot |
| 判断证据句（JD 原文摘录存证） | ❌ 只有 reason 短句 |
| 网页求职工作台 V1 | ❌ |

---

## 5. 「为什么一个岗位都没有？」——真相

| 你看到的 | 原因 |
|----------|------|
| Bot：`库里暂无 apply_now` | 查的是 **Postgres `recommendation_status=apply_now`**；本机 DB **连不上** → 永远空 |
| 历史 `pushed_jobs.json` | **有 300 条**（Jobicy 140、电鸭 99、V2EX 37、WWR/远程.work 等） |
| 其中分数 ≥40 | **0 条**（旧推送多数 0–20 分，且是旧评分体系） |
| 最近更新 | `2026-11-12`，距今约 **2.5 天+**；最近条目约 **63h 前** |
| Himalayas/Remotive/Growix | **几乎没进这份 pushed 历史**（当时推送主力是 Jobicy + 中文源） |

所以：  
**不是「筛选后全世界 0 岗」**，而是：

1. 正式 Copilot 库（Postgres）没挂上 → `/apply` 空  
2. 旧推送分数普遍低，且过了新的 `apply_now` 硬门槛  
3. 统一 24h 窗 + 严筛，Actions 若某几天无过线，手机就像「没岗」

---

## 6. 和 ApplyPack / JobRadar / freehire 的差距（诚实版）

| 借鉴点 | 我们现在 |
|--------|----------|
| ApplyPack：采集与存储分离、规则/AI 分层、PG 真源 | 分层有；**PG 未成为真源**；Telegram/JSON 仍是主记忆 |
| JobRadar：申请生命周期 + 有效性 + 跟进 | 字段有影子；**流程产品化未做** |
| freehire：ATS Watchlist 规模化 | **有小型 ats-boards.json**，不是 700k 公司级 |
| Simplify 工作台体验 | ❌ |

**没有换技术栈的必要**；缺的是把 V0.2 数据层跑通 + 按源改造，而不是再套 Agent 框架。

---

## 7. 建议的下一步（可直接交给 Cursor 执行的顺序）

### P0（先让「有岗可问」）
1. 修好 `DATABASE_URL`（本机 Docker Postgres **或** Supabase）并执行 `sql/create_radar_copilot_tables.sql`  
2. 跑一轮 `npm run radar-cycle`（或 Actions replay）写入带 `recommendation_status` 的岗位  
3. Himalayas：改 cursor、`limit≤20`，用 location/employment 前置筛  

### P1
4. 按源时间窗 + 水位（不要统一 24h 丢弃）  
5. Growix / OpenTrain 拆轨道（常青承包商 / 兼职标注）  
6. Jobicy 结构化字段利用；Remotive attribution  

### P2
7. 职位 alive check；申请状态机接 Telegram  
8. 判断证据句入库  

---

## 8. 关键文件索引

| 文件 | 作用 |
|------|------|
| `scripts/run-radar-cycle.js` | 主扫描循环 |
| `scripts/quick-match.js` | L1 / 硬条件 / 六维 / status |
| `scripts/db.js` | Postgres upsert / 偏好 |
| `scripts/telegram-chat-poll.js` | 本地自然语言对话 |
| `config/scoring-weights.json` | 权重与门槛 |
| `sql/create_radar_copilot_tables.sql` | Copilot 表结构 |
| `data/pushed_jobs.json` | 历史推送（当前聊天后备知识库） |
| `data/seen_jobs.json` | 去重（Actions 会 commit） |
| `docs/COPILOT-ARCHITECTURE.md` | Copilot 架构短述 |
| `workers/telegram-webhook/` | 云端 Webhook（未默认部署） |

---

**一句话**：  
筛选逻辑已经从「关键词推送」升级到「硬条件 + 六维 + apply_now/verify」；但 **数据库没连上 + 源 API 未按新文档改 + 常青/兼职未分流**，所以体验上会像「智能体很虚、库里没岗」。先把库跑通并扫一轮，Bot 才能真正当知识库用。
