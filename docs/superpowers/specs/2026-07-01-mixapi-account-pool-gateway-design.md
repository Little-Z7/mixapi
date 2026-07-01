# mixapi · Coding Plan 账号池网关 — 设计文档

- **日期**：2026-07-01
- **状态**：一期设计已评审通过，待落实施计划
- **范围**：本文档聚焦**一期 MVP**，二~四期仅列路线图供上下文

---

## 1. 背景与目标

不同平台的 coding plan / 模型 API 各有账号、额度、客户端、协议和调用方式。本产品作为中间层，把它们抽象成统一资源池，对外提供**一个统一的 OpenAI 兼容出口**，实现统一配置、统一调用、统一路由、统一统计、统一失败切换。

**定位**：个人 + 小团队内部工具，暂不做公开售卖平台。

**规模假设**：≤ 几十个账号、≤ 二十来个用户、单机部署、SQLite（后续可换 Postgres），无需分布式。

### 明确目标（一期）
- 把多个 **key-based** 账号（如 GLM coding plan、火山 Ark）组成一个池，对外是一个 OpenAI 兼容地址。
- 按模型路由、按健康度/额度选号、失败自动切换、掉号自动摘除与恢复。
- 调用日志与基础用量/成本统计。

### 非目标（一期不做，见分期）
- session/OAuth 登录态池化（二期）
- 多用户/团队/RBAC/配额/成本看板/Web 控制台（三期）
- 插件市场（四期）
- embeddings 等非 chat 端点、精确余额读取

---

## 2. 关键决策记录（ADR 摘要）

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| D1 | 共享方式 | **真·池化共享**（1 份当 N 份） | 用户明确要最大价值点；接受"号是消耗品" |
| D2 | 鉴权范围 | **key-based 与 session/OAuth 两种都要** | 架构一次到位，靠凭证抽象容纳两者 |
| D3 | 构建路线 | **从零 + 干净 adapter 内核**（非 fork） | 现有工具无人统一"两种 + 插件市场"，这是真实空位 |
| D4 | 技术栈 | **TypeScript**（Bun + Hono） | 要伪装的 session 客户端多为 TS 写成，保真度高、迭代快、全栈一门语言 |
| D5 | 一期切法 | **脊柱 + key-based 池化**，单一 gateway-key | 先用最小可用切片验证核心抽象，session 插同一脊柱 |

---

## 3. 风险与合规（如实记录）

把一份订阅套餐拆给多人/多出口轮流用，对绝大多数 coding plan **属于违反其服务条款**（账号共享 / 转售 / 非官方客户端程序化访问），平台会用并发、IP 分散、客户端指纹、请求节奏等手段检测 → 轻则限速、重则封号。

**设计原则**：本系统按"**账号会失效/被封**"来设计——健康检查、自动摘除、冷却、告警、便于补号，而非假设账号永久可用。key-based 账号（多个合法 key 轮询）风险相对低；session 类（二期）风险显著更高，为其保留独立出口 IP 绑定等缓解手段。

本工具用于个人/小团队使用自己持有的账号，不面向公开转售。

---

## 4. 整体架构

```
Client ──OpenAI 兼容请求 (Bearer gateway-key)──▶
  ① Ingress/Auth       验 gateway-key、认调用方、查配额、限流
  ② Normalizer         OpenAI 报文 ⇄ 内部规范请求/响应（统一 API 契约）
  ③ Router/Selector    model→候选账号→过滤(健康/额度)→选(粘性/加权)→失败切换链
  ④ ProviderAdapter    规范请求 → 目标平台方言 + 注入客户端指纹/headers   〔可插拔〕
  ⑤ CredentialSource   StaticKey 直给 │ OAuthSession 刷新后给（二期）       〔可插拔〕
  ⑥ Egress             (可选) 绑定该账号出口代理/IP；流式 SSE 透传发出
  ◀── Adapter 回程：目标平台响应 → OpenAI 兼容 + 流式回传 ──
  ⑦ Health/Quota       记用量、更新健康/额度；错误→冷却 + 触发 ③ 重选
  ⑧ Logger/Usage       落库：调用日志、成本、归属调用方
持久化：SQLite → Postgres      管理面：admin REST + 控制台(三期)
```

### 核心抽象（"两种都要"落地的关键）
池中每个成员都是"**一个可池化的凭证资源**"，只有两处实现不同，其余全部共用：

- **CredentialSource**（怎么拿到有效鉴权）：`StaticKey`（一期）│ `OAuthSession`（二期，负责刷新/重登）
- **ProviderAdapter**（怎么把规范请求翻成该家方言 + 伪装官方客户端）：`openai` / `anthropic`（一期）│ Claude-Code/Cursor/Copilot（二期）

> key 号 = `StaticKey + openai/anthropic adapter`；session 号 = `OAuthSession + 对应 adapter`。**同一个 Account 结构、同一个 Router、同一套 Health/Quota/Log**，只有 ④⑤ 不同。

---

## 5. 一期详细设计

### 5.1 数据模型（SQLite，Drizzle ORM）

将「配置」「热状态」「密钥」分表：配置低频、状态高频、密钥需单独加密。

**accounts**（账号配置）
```
id            uuid pk
name          text                     -- 人类可读标签
provider      text                     -- 'glm' | 'volcano' | ...（自由字符串）
adapter       text                     -- 'openai' | 'anthropic'
base_url      text                     -- 账号级：接入时填写该家端点
models        json                     -- [{ public: string, target: string }]
weight        int   default 1          -- 加权选号
enabled       bool  default true
egress        text  null               -- 出口代理 URL（一期留空）
created_at / updated_at
```

**credentials**（密钥，单独加密存）
```
id            uuid pk
account_id    uuid fk -> accounts
type          text                     -- 'static_key'
secret_enc    blob                     -- AES-256-GCM 密文
meta          json  null               -- 如 org/project id
```

**account_state**（热状态，高频更新）
```
account_id        uuid pk fk
status            text   -- 'healthy'|'cooling'|'exhausted'|'disabled'|'unknown'
cooldown_until    timestamp null
consecutive_errors int   default 0
last_used_at      timestamp null
last_error        text null
last_checked_at   timestamp null
```

**request_logs**（调用日志）
```
id, ts, gateway_key_id, public_model, account_id, status('ok'|'error'|'failover'),
http_status, latency_ms, prompt_tokens, completion_tokens, total_tokens,
est_cost, attempt_count, stream, client_ip
```

**gateway_keys**（调用方密钥，一期先一个，建表便于撤销/扩展）
```
id, key_hash, name, enabled, created_at
```

**模型映射**：网关对外暴露 **public 模型名**；每个账号在 `models` 声明服务哪些 public 名并可 rename 到该家真实 model id。**多个账号服务同一 public 名 = 池**。`base_url + adapter` 均为账号级配置，故接入时才需知道各家确切端点（GLM coding→`anthropic`，火山 Ark→`openai`）。

### 5.2 路由与切换（核心）

选号流水线（public 模型 M、会话标识 S）：

1. **候选** = `enabled && status ∈ {healthy, unknown} && M ∈ models && (cooldown_until 为空或已过)`
2. **粘性**（可配置，默认开）：会话标识 `S` 取请求头 `x-session-id`（客户端可选传入）；**未提供时跳过粘性**、直接走加权选号。提供时用 `hash(S)` 一致性哈希使同一会话尽量固定同号，减少上下文串号并为二期风控铺路；命中号不健康时回退到常规选号
3. **选号**：按 `weight × 健康因子` **加权随机**，在飞请求少者优先（power-of-two-choices 破平）
4. **切换**：`maxAttempts = 3`，跨**不同**账号重试

**流式切换边界（关键正确性点）**：只能在**首个 token 下发给客户端之前**切换。实现为 **pre-flight then commit**——先取得上游第一个成功 chunk 再"提交"该账号并开始透传：
- 首 chunk 前出错 → 标记该号状态并换号重试
- 首 chunk 后出错 → 只能带错误收尾（不重复产出、因此不重复计费）

**错误分类归属 adapter**：`classifyError(resp) → { retryable, reason: 'rate_limit'|'quota'|'auth'|'server'|'bad_request'|'unknown', cooldownMs? }`，**同时驱动切换与健康状态机**。用户侧 4xx（参数错误、超长）不重试、不烧号，直接回传。

### 5.3 健康度与额度

**状态机**（account_state.status）：
- `429 / rate_limit` → `cooling`（优先用响应 Retry-After，否则按 consecutive_errors 指数退避）
- `额度耗尽` → `exhausted`（较长冷却或定时复查）
- `401 / 403 持续` → `disabled`（需人工换 key，触发告警）
- `5xx / 网络错误` → `cooling`（短退避）
- 冷却到点 → `unknown` → 下次真实请求或探针成功 → `healthy`（重置 consecutive_errors）

**熔断**：`consecutive_errors` 超阈值即开断路，停止捶打死号。
**主动探针**（可选、默认关）：对 cooling/unknown 账号定时轻量探测以自动恢复。
**额度处理（诚实）**：多数平台不在响应回传剩余余额，故一期**以错误信号 + 用量计数为主**，不假装精确读余额；为有余额 API 的平台预留 `fetchQuota()` 可选钩子（二期接入）。

### 5.4 网关 API 契约

**对外（OpenAI 兼容，`Authorization: Bearer <gateway-key>`）**
- `POST /v1/chat/completions` — 支持 `stream: true|false`，返回 OpenAI 形状响应 / SSE
- `GET /v1/models` — 返回池子可服务的 public 模型名并集（OpenAI 形状）

**管理（`admin-key`，与 gateway-key 分离）**
- `GET/POST/PATCH/DELETE /admin/accounts` — 账号 CRUD（含加密写入 credential）
- `GET /admin/accounts/:id/state`、`POST /admin/accounts/:id/{enable,disable,reset-cooldown}`
- `GET /admin/logs`（按 model/account/status 过滤）、`GET /admin/stats`
- `GET/POST/DELETE /admin/gateway-keys`
- `GET /healthz`、`GET /admin/pool`（池概览）

**配置 vs DB 权威**：**DB 为运行时唯一权威**；`config.yaml` 仅在首次启动**导入/bootstrap** 账号与密钥，之后以 DB 为准，避免配置与库两头漂移。

### 5.5 部署与密钥安全

- **运行时/框架**：**Bun + Hono**（SSE 一等公民，Node 兼容便于切换）；上游调用用原生 `fetch`，流式响应 body 直接 pipe 透传下游。
- **部署**：单 Docker 容器 + SQLite volume，前置 Caddy/nginx 负责 TLS；后续换 Postgres 仅改连接串。
- **密钥安全**：
  - `MASTER_KEY`(env) 对 `credentials.secret_enc` 做 **AES-256-GCM** 落库加密
  - gateway-key / admin-key **哈希存储**（不存明文）
  - **任何日志一律脱敏，绝不打印 token/密钥**；`.env` 纳入 .gitignore
- **出口**：一期直连；账号级 `egress` 字段预留（二期用 undici `ProxyAgent` / fetch dispatcher 绑定每账号出口 IP）。

### 5.6 模块划分（接口先行，为四期插件市场留缝）

```
src/
  ingress/{auth, openai-routes, admin-routes}.ts
  core/{normalizer, router, failover, pool, health}.ts
  adapters/{types, openai, anthropic, registry}.ts     ← ProviderAdapter 接口
  credentials/{types, static-key, crypto}.ts           ← CredentialSource 接口
  data/{schema, db, repos}.ts
  usage/{logger, cost}.ts
  config/load.ts
  index.ts
tests/                                                  ← 每模块单测 + 端到端集成
```

每模块单一职责、接口先行。`adapters` 与 `credentials` 均为接口，`openai`/`anthropic`/`static-key` 只是首批实现——二期 session、四期插件市场都从这两个缝插入。

---

## 6. 测试策略

- **单元测试**：normalizer（OpenAI ⇄ Anthropic 双向）、router 选号（给定池状态 → 期望选择）、failover（mock adapter 失败 N 次 → 验证换号 + pre-flight-commit 语义）、health 状态机（错误 → 冷却 → 恢复）、crypto 加解密往返。
- **集成测试**：启动应用连接一个 **mock 上游服务**（可编排返回 SSE / 429 / 额度错误 / 5xx）→ 断言端到端池化、"首 token 前失败自动换号"、流式透传、日志落库。
- **不打真实平台**。实现阶段按 TDD（先测后码）。

---

## 7. 一期验收标准（Definition of Done）

1. 配置 ≥2 个服务同一 public 模型的 key-based 账号后，`GET /v1/models` 返回该 public 名。
2. `POST /v1/chat/completions`（非流式）成功经由某账号返回 OpenAI 兼容响应；`request_logs` 落一行含账号与用量。
3. `stream:true` 流式透传正常；**首 chunk 前**上游返回 429 → 自动换号成功、客户端无感；**首 chunk 后**上游断开 → 带错误收尾且无重复内容。
4. 某账号连续错误 → 进入 `cooling` 并被摘除；冷却到点后自动恢复参与选号。
5. 无效 gateway-key → 401；用户侧 4xx 错误不触发换号。
6. 数据库中 credential 为密文；任何日志中均无明文 token。
7. mock 上游的集成测试与核心模块单测全部通过。

---

## 8. 分期路线图（一期之后，供上下文）

- **二期 · session/OAuth 池化**：`OAuthSession`（token 抓取/刷新/掉线重登）、各家客户端指纹伪装（Claude Code / Cursor / Copilot / opencode）、每账号出口 IP/代理绑定、粘性加固。
- **三期 · 团队运营**：React 控制台、用户/团队/RBAC、按用户/团队配额、成本看板、审计。
- **四期 · 插件市场**：adapter 打包分发（npm）、第三方 adapter SDK。

---

## 9. 未决问题（接入/实现时确认，不阻塞设计）

1. GLM / 火山 的确切 `base_url`、可用 model id、以及 GLM 走 Anthropic 兼容还是 OpenAI 兼容路径——接入账号时填入配置即可，设计不依赖具体值。
2. `OpenCode Go 套餐` 的接入方式与鉴权类型未知，二期研究。
3. 成本估算的价格表来源：一期内置一个**可配置的 price map**（按 public 模型每百万 token 计），缺失时成本记为 0 并标记。
4. 粘性默认开启（可配置关闭）——已在 5.2 采纳，实现时提供开关。
