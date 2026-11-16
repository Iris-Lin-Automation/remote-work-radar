# Remote Job Copilot — PRD 现状对照（2026-11-16 更新）

> **结论（当前）：** 云端 P0 四块已打通——**Supabase 真库 + 地区资格 + Groq 六维评分 + Telegram 推送/双向对话**。  
> 仍未完整实现「ApplyPack / JobRadar 级」V0.2（按源水位、alive check、证据句、申请状态机产品化、向量相似搜）。  
> **自动简历 PDF：明确后置，先不做。**

---

## 0. 云端运行事实（2026-11-16 已验证）

| 项 | 状态 | 证据 |
|----|------|------|
| Supabase Postgres | ✅ | 本机 `db:health` 通；Actions 日志 `DB ok (supabase)` |
| 表结构 / service_role 权限 | ✅ | `sql/create_radar_cloud_bootstrap.sql` + `grant-service-role.sql` |
| 历史导入 | ✅ | 约 **302** 条在 `jobs`（几乎全是 `legacy_import=true`） |
| `recommendation_status` | ⚠️ | **apply_now ≈ 0**；**verify ≈ 302**（历史岗未按新门槛重评到「可投」） |
| GitHub Actions Secrets | ✅ | `DATABASE_URL` / `SUPABASE_*` / `TELEGRAM_*` / `GROQ_*` 已写入 |
| Actions 双写云库 | ✅ | 推送含云端代码后的 run 出现 `💾 DB ok (supabase)` |
| CF Worker | ✅ | `https://remote-job-copilot-tg.irislin.workers.dev` |
| Telegram webhook | ✅ | 指向上述 Worker；401 已修 |
| Bot 命令 | ✅ | `/status` `/apply` `/review` `/check` `/prefs`；自然语言查库 |

**因此：** `/apply` 空 ≠ 库断；而是库里几乎没有 `apply_now`，请先用 **`/review`** 看 verify 存货。

---

## 1. 产品版本对照

| 版本 | 目标 | 现状 |
|------|------|------|
| **V0.1 Job Radar** | 多源抓取 → 过滤 → 打分 → Telegram 推送 | ✅ 已上线（Actions ~2h + 本地 `radar-cycle`） |
| **V0.2 Job Intelligence** | Postgres 真源、地区资格、按源水位、核验、状态机 | ⚠️ **PG 真源已挂上**；资格/六维在跑；水位/核验/状态机产品化 **未做** |
| **V0.3 Job Copilot** | Telegram 双向：查岗、解释、改偏好 | ✅ **CF Worker 已为线上入口**；偏好 propose→confirm 有；本地 `chat` 仍可调试 |
| **V1.0 Workspace** | 网页工作台、申请进度、简历匹配 | ❌ 未做（简历 PDF 后置） |

---

## 2. 当前真实筛选流水线

```
多源抓取 (RSS/JSON/HTML/ATS)
    │
    ▼
时间窗：统一 RADAR_MAX_AGE_HOURS（Actions 默认 24h）
    │  ⚠️ 尚未按源差异化
    ▼
Layer 1 关键词白名单（画像技能）
    │
    ▼
Layer 1.5 Eligibility + Hard rules
    │  china_eligible = true | false | unclear
    │  Worldwide ≠ 中国可雇 → 最多 verify
    ▼
Layer 2 Groq 六维（tech/delivery/level/workstyle/comp/trust）
    │  失败 → score_status=error，不写假分
    ▼
recommendation_status: apply_now | verify | skip
    ▼
双写：Supabase upsert（pg，失败可 REST）+ seen_jobs.json
    ▼
Telegram 推送（Actions）+ 双向查询（CF Worker）
```

### 状态门槛（简化）

| 状态 | 条件 |
|------|------|
| `skip` | 签证/onsite/渣岗，或分数过低 |
| `verify` | 中国可雇 unclear，或分数在 verify 档 |
| `apply_now` | `china_eligible=true` 且总分达 `apply_now_min`（默认 70）等 |

配置：`config/scoring-weights.json`

### 没有的能力

- ❌ 向量相似搜索（「喂一条样例岗找同类」）  
- ❌ embedding / pgvector  

---

## 3. 数据源现状

| 来源 | 代码 | 实际 |
|------|------|------|
| Himalayas | ✅ | ⚠️ 仍 limit/offset；无 cursor；少前置筛 |
| Remotive | ✅ | ⚠️ 未强化延迟/attribution |
| Jobicy | ✅ | ⚠️ 结构化字段未用满 |
| WWR / RemoteOK | ✅ | ✅ 可用 |
| Growix / OpenTrain | ✅ | ⚠️ 仍与正式全职混轨 |
| Greenhouse/Ashby | ✅ | ✅ `config/ats-boards.json` |

---

## 4. 功能清单

### ✅ 已实现（能用）

- 中英双轨抓取 + Telegram 推送  
- 关键词 + `china_eligible` 硬规则 + Groq 六维  
- **Supabase 云库双写**（Actions + 本地）  
- 历史岗导入云库（~302，多为 verify）  
- `seen_jobs.json` Actions 持久化  
- **CF Worker 线上 Bot**（`/apply` `/review` `/status` `/check` `/prefs`）  
- GitHub Secrets 云端配置  

### ⚠️ 半成品

- 历史岗多为 verify / 旧分 → **`/apply` 仍常空**；需重评或等新扫出 apply_now  
- 偏好摘要可写入评分，覆盖与效果仍弱  
- Growix/OpenTrain 未拆轨道  
- 申请 `pipeline_status` 有字段，未接 Bot 流程  

### ❌ 未做（PRD 重点）

| 项 | 状态 |
|----|------|
| Himalayas cursor + 官方前置筛 | ❌ |
| 按源时间窗 / 抓取水位 | ❌ |
| Growix / OpenTrain 分流 | ❌ |
| 职位 alive check | ❌ |
| 申请生命周期产品化（Applied→Interview…） | ❌ |
| JD 证据句入库 | ❌ |
| 向量相似搜「像某条岗」 | ❌ |
| 网页工作台 / 自动简历 PDF | ❌（PDF 明确后置） |

---

## 5. 「为什么 /apply 还是空？」——更新后的真相

| 现象 | 原因（2026-11-16） |
|------|-------------------|
| `/apply` 空 | 库 **已通**；但 `apply_now` 计数 ≈ **0** |
| `/review` 有货 | ~302 条在 `verify`（历史导入 + 资格 unclear / 分不够） |
| Actions 推 0 条 | 该时间窗内无新过线岗（扫描可有数百条入库前过滤） |

不是「库挂了」，是「存货未达到立刻推荐门槛」。

---

## 6. 与 ApplyPack / JobRadar 差距（诚实）

| 借鉴点 | 现在 |
|--------|------|
| PG 真源 + 规则/AI 分层 | ✅ 分层有；**PG 已是云端真源** |
| 申请生命周期 + 有效性 | ⚠️ 字段影子；产品化未做 |
| ATS 规模化 Watchlist | ⚠️ 小型 boards，非海量 |
| 样例岗向量召回 | ❌ |
| 工作台 / 简历包 | ❌ |

---

## 7. 建议下一步（开发顺序）

### 立即（产品体验）

1. 手机 Bot：`/status` → **`/review`** 翻历史岗  
2. 需要可投清单：对未过期历史岗 **重跑资格+六维**，或 Actions `replay` 出 apply_now  

### P0 开发

3. 刷新本对照表后，按项做：Himalayas cursor / 前置筛  
4. 产出稳定的 `apply_now` 供给（重评或调门槛，需产品决策）  

### P1

5. 按源时间窗 + 水位  
6. Growix / OpenTrain 拆轨  
7. Jobicy / Remotive 结构化强化  

### P2

8. alive check；申请状态机接 Telegram  
9. 证据句；可选：向量「像某条岗」  
10. 简历 PDF / 网页工作台（更后）  

---

## 8. 关键文件索引

| 文件 | 作用 |
|------|------|
| `scripts/run-radar-cycle.js` | 主扫描 + 推送 |
| `scripts/quick-match.js` | L1 / 硬条件 / 六维 / status |
| `scripts/db.js` | Supabase pg + REST upsert |
| `scripts/import-legacy-jobs.js` | 历史导入 |
| `config/scoring-weights.json` | 分数门槛 |
| `sql/create_radar_cloud_bootstrap.sql` | 云库建表 |
| `sql/grant-service-role.sql` | REST/Worker 权限 |
| `workers/telegram-webhook/` | **线上** Telegram Webhook |
| `README_CLOUD_DEPLOYMENT.md` | 云端部署说明 |
| `docs/COPILOT-ARCHITECTURE.md` | 架构短述 |
| `data/seen_jobs.json` / `pushed_jobs.json` | 去重与历史（JSON 侧） |

---

**一句话：**  
云端库、资格、评分、Telegram（推送+对话）已通；库里主要是 **verify 存货**。下一步优先 **让 apply_now 真正有货** + 按源改造，而不是简历 PDF 或向量搜索。
