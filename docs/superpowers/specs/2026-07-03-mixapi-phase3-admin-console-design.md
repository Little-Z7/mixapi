# mixapi Phase 3 · Admin 控制台 — 设计文档

- **日期**：2026-07-03
- **状态**：设计已评审通过，待落实施计划
- **基线**：`main` @ `2e84a27`（1A + 1B-① + 1B-②′ 已合入）

---

## 1. 背景与范围

到 1B-②′，网关已能池化 GLM coding + OpenCode Go，但账号只能靠 `config.json` 声明，健康/日志/用量只在 SQLite 里、无界面。本阶段补上 **admin 控制台**：一个 web 界面来管理账号池、gateway-key，并查看健康 / 调用日志 / 用量。

**切法**：**3a · Admin REST（无头后端，先做、全测）→ 3b · 控制台 UI（消费 3a 的自包含页面）。**

### 目标
- 管理员登录（独立 `ADMIN_KEY`），进入控制台。
- 账号：查看（含健康）、增、改、删、启用/禁用、重置冷却。
- gateway-key：查看（掩码）、新建（原文只显一次）、撤销。
- 观测：调用日志（可过滤）、用量/成本聚合。
- 前端**零构建、自包含**，由网关在 `/admin` 直接托管。

### 非目标（deferred）
- 用户/团队/RBAC、审计（多管理员）；session/OAuth 池化（Phase 2）；跨协议翻译；控制台里的测试 playground（可后加）；重的前端 e2e（Playwright）。

## 2. 关键决策（ADR）

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| D1 | 前端栈 | **零构建自包含页面**（vanilla JS + fetch，Hono 托管） | 契合项目"少依赖、单进程、`bun run` 就跑"；网关本身即完整交付；无前端工具链 |
| D2 | admin 鉴权 | **独立 `ADMIN_KEY`（env）+ httpOnly HMAC 会话 cookie** | 与 gateway-key 分离；cookie 无状态签名（不建表）；不把密钥留在 JS/localStorage |
| D3 | 密钥可见性 | **账号 API key 只写不回读；gateway-key 原文仅建时回显一次** | 控制台永不泄漏已存密钥 |
| D4 | schema | **不改** | accounts/credentials/account_state/request_logs/gateway_keys 均已存在，够用 |
| D5 | CSRF | **SameSite=Strict cookie** | 内部工具，SameSite 已挡跨站；状态变更端点可选再加 header token（deferred） |

## 3. 架构与鉴权

- **`ADMIN_KEY`**（env，与 `GATEWAY_KEY`/`MASTER_KEY` 并列）。校验用 `timingSafeEqual` 比对 `sha256(input)` 与 `sha256(ADMIN_KEY)`（复用 `hashKey`）。
- **会话（无状态 HMAC）**：`src/admin/session.ts`
  - `signSession(now): string` → token = `${exp}.${hmacHex}`，`exp = now + TTL`（默认 12h），`hmac = HMAC-SHA256(exp, sessionSecret)`，`sessionSecret = hashKey('session:' + ADMIN_KEY)`。
  - `verifySession(token, now): boolean` → 解析 exp，`timingSafeEqual` 比对 hmac，且 `exp > now`。
- **登录/登出**：`POST /admin/login {key}` 校验 → `Set-Cookie: mixadmin=<token>; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=…`（`Secure` 默认加，`ADMIN_INSECURE_COOKIE=1` 时省略以便本地 http 调试）。`POST /admin/logout` 清 cookie。
- **中间件**：`app.use('/admin/*')` 校验 cookie，**放行** `POST /admin/login` 与 `GET /admin`（静态页本身公开，页面加载后再登录）。失败 → 401。
- **静态页**：`GET /admin` 返回自包含 HTML（内联 CSS/JS），页面用 `fetch('/admin/…', { credentials:'same-origin' })` 调数据端点。
- `buildApp` 里注册 `registerAdminRoutes(app, deps)`（deps 增加 `adminKey`）。**零新依赖**（HMAC/随机用 `node:crypto`）。

## 4. 3a · Admin REST 端点（无头后端，先做）

全部在 `src/ingress/admin-routes.ts`（登录/登出/会话）+ 数据端点；返回 JSON。**任何端点都不返回 `secretEnc` 或明文 key。**

- `POST /admin/login {key}` → 200+Set-Cookie / 401；`POST /admin/logout`；`GET /admin/session` → `{authed:true}`
- **账号**
  - `GET /admin/accounts` → `[{id,name,provider,adapter,baseUrl,models,weight,enabled, state:{status,cooldownUntil,consecutiveErrors,lastUsedAt,lastError}}]`（含 disabled；无密钥）
  - `POST /admin/accounts {name,provider,adapter,baseUrl,models,weight,key}` → 201；`key` 经 `encryptSecret` 存
  - `PATCH /admin/accounts/:id {baseUrl?,models?,weight?,enabled?,key?}` → 改；带 `key` 则重新加密替换
  - `DELETE /admin/accounts/:id` → 删账号+credential+state
  - `POST /admin/accounts/:id/reset-cooldown` → state `status='unknown'`, `cooldown_until=NULL`, `consecutive_errors=0`
- **gateway-key**
  - `GET /admin/gateway-keys` → `[{id,name,keyHashPrefix,enabled,createdAt}]`（掩码：仅 hash 前 8 位）
  - `POST /admin/gateway-keys {name}` → 生成随机 key → hash 存 → **回 `{id, key:<原文>}` 仅此一次**
  - `DELETE /admin/gateway-keys/:id` → 撤销（删除）
- **观测**
  - `GET /admin/logs?limit&model&account&status` → 近 N 条 request_logs
  - `GET /admin/stats?sinceMs` → `{totalRequests, errorCount, errorRate, totalTokens, totalCost, byModel:[…], byAccount:[…]}`
  - `GET /admin/models` → public 模型名（复用 `listPublicModels`）

**新增 repo/辅助函数**（保持文件单一职责）：
- `src/data/accounts.ts`：`listAccountsWithState`、`getAccount`、`updateAccount`、`deleteAccount`、`setCredential`、`resetCooldown`
- `src/ingress/auth.ts`：`listGatewayKeys`、`createGatewayKey(db,name)→{id,rawKey}`、`deleteGatewayKey`
- `src/admin/queries.ts`：`listLogs(db,filters)`、`aggregateStats(db,sinceMs)`
- `src/admin/session.ts`：`signSession`/`verifySession`

## 5. 3b · 控制台 UI（自包含页面，消费 3a）

`GET /admin` 返回单页（侧栏 tab）；未登录先显登录框。vanilla JS，`fetch` 调 `/admin/*`。

- **Pool / 账号**：表格（名 · provider · adapter · 模型 · **状态色标** healthy·cooling·exhausted·disabled · 冷却剩余 · 连续错误 · 最近用），行内：启用/禁用（PATCH enabled）· 重置冷却 · 编辑 · 删除；顶部「加账号」表单（含 key 输入，提交即加密存）。
- **Logs**：request_logs 表（时间·model·account·status·http·延迟·attempt_count·token·成本）+ model/account/status 过滤。
- **Stats**：汇总卡（总请求 · 错误率 · token · 估算成本）+ 按 model / account 的简单分布表。
- **Keys**：gateway-key 列表（掩码）+ 新建（弹出**只显一次**的原文）+ 撤销。
- 明暗主题、干净排版、桌面优先。

## 6. 数据模型

**不改 schema。** 复用现有五表。`gateway_keys`（id/key_hash/name/enabled/created_at）支持列表/新建/撤销；账号写操作走 accounts/credentials/account_state。

## 7. 安全

- 账号 API key **任何端点都不回读**（`secretEnc` 从不进响应）；gateway-key 原文**仅新建时回显一次**，之后只存/显哈希。
- admin cookie：httpOnly + SameSite=Strict（+ Secure，默认）；HMAC 无状态、带过期；`ADMIN_KEY` 校验用 timing-safe 比对。
- `/admin/*`（除登录与静态页）全需会话；静态页仅是 HTML 外壳。
- 参数化 SQL（无拼接）；日志/响应**永不含密钥**。

## 8. 测试策略（bun test，注入 db）

- **session**：sign→verify 往返；过期 token 拒绝；篡改 hmac 拒绝。
- **鉴权**：无 cookie 调 `/admin/accounts` → 401；错 key 登录 → 401；对 key 登录 → 200 + cookie，带 cookie 再调 → 200。
- **账号 CRUD**：建→列出（含健康、**无 secretEnc**）→改→删；`reset-cooldown` 生效；建账号后 key 库中为密文。
- **gateway-key**：新建回原文一次、库存哈希；列表掩码不含原文；撤销后失效（`verifyGatewayKey` 拒绝）。
- **logs/stats**：造几条 request_logs → 过滤/聚合数值正确（错误率、token、成本、按 model/account）。
- **UI 冒烟**：`GET /admin` 返回 200 HTML 且含登录框标记；页面不内联任何密钥。
- 重的浏览器 e2e（Playwright）默认不做。

## 9. 切法（Phase 3 内部）

- **3a · Admin REST + 鉴权**（session、登录中间件、账号/key/logs/stats 端点 + 新增 repo 函数）——无头、全 bun test。
- **3b · 控制台 UI**（`GET /admin` 自包含页面消费 3a）。
先 3a 后 3b。

## 10. Deferred
测试 playground、用户/团队/RBAC/审计（多管理员）、CSRF header token、浏览器 e2e、config.json 与 admin 双写协调（目前 admin 写 DB、config 仅首启导入缺失项——admin 改动以 DB 为准，符合"DB 运行时权威"）。以及历史累积的 fix-in-next-slice 小项（见 git 历史 / 各 spec）。
