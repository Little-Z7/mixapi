# mixapi Phase 1B-②′ · GLM coding + OpenCode Go 池化 — 设计文档

- **日期**：2026-07-02
- **状态**：设计已评审通过，待落实施计划
- **上游文档**：产品总设计 `2026-07-01-...-design.md`；1B-① 池化核心 `2026-07-02-mixapi-phase1b-pooling-core-design.md`
- **基线**：`main` @ `4baf616`（1A + 1B-① 已合入）

---

## 1. 背景与范围

用户首要目标：**把 GLM coding plan 和 OpenCode Go 订阅套餐做成池化**，并能通过它们的原生客户端消费（Claude Code / opencode 及 OpenAI 兼容工具）。

调研确认两者都是 **key-based**（无需 session/OAuth）：

| 平台 | 端点 | 协议 | 鉴权 |
|---|---|---|---|
| GLM coding plan（Z.ai） | `https://api.z.ai/api/anthropic` | Anthropic 兼容 | 静态 token |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | OpenAI 兼容 | 静态 key |

用户决定：**双入站**——保留 OpenAI `/v1/chat/completions`，新增 Anthropic `/v1/messages`。

**核心设计：同协议直连（passthrough），不做 OpenAI⇄Anthropic 翻译。** 两个目标流都是同协议：Claude Code(Anthropic)→GLM(Anthropic)、OpenAI 工具→OpenCode Go(OpenAI)。池化核心（`pool/router/health/failover`，1B-①）是 protocol-agnostic 的，两条协议原生管道直接共享它。保真度最高、工程量最小。

### 目标
- `config.json` 声明多账号入池（GLM 多 key + OpenCode Go 多 key），使池**可运维**（1B-① 只测过、无声明入口）。
- 新增 `anthropic` 透传 adapter（服务 GLM coding）。
- 新增 Anthropic 兼容入站 `/v1/messages`，透传消费 GLM coding 池。
- OpenCode Go 用**现有 `openai` adapter**，经 OpenAI 入站池化（几乎只差 config）。
- **协议过滤**：每个入站只路由到同协议账号（见 D2）。

### 非目标（deferred）
- **跨协议翻译**（OpenAI 工具→GLM，或 Anthropic→OpenCode）——需要 OpenAI⇄Anthropic 翻译，两个目标都不需要；留待"任意客户端×任意 provider"单独一刀。
- admin REST/控制台（Phase 3）；session/OAuth（Phase 2）；YAML 配置（用 JSON，见 D3）。

## 2. 关键决策

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| D1 | 翻译策略 | **同协议直连（passthrough），不翻译** | 两个目标流均同协议；保真度最高（Claude Code 的 Anthropic 原生请求原样到 GLM）、工程最小 |
| D2 | 协议过滤 | **候选按入站协议(adapter)过滤** | **GLM-5.2 在两个池都有**（GLM coding 与 OpenCode Go 都提供）；靠入站协议消歧——Anthropic 入站只选 `anthropic` 号，OpenAI 入站只选 `openai` 号，避免把 Anthropic 请求发给 openai adapter |
| D3 | 配置格式 | **`config.json`（非 YAML）** | Bun 原生解析 JSON，零依赖；密钥用 `keyEnv` 引用环境变量、不落配置文件 |
| D4 | 账号导入 | **首启幂等导入（按 name）** | config 是 bootstrap；DB 为运行时权威（沿用总设计）。name 已存在则跳过 |
| D5 | anthropic adapter | **透传**（非翻译） | `/v1/messages` 收到的已是 Anthropic 原生 body；adapter 只拼端点 + token 头 + 流式透传 + Anthropic 错误分类 |
| D6 | schema | **不改** | `accounts` 已有 `adapter`/`base_url`/`models`；config 导入即可 |

## 3. 组件设计

### 3.1 config loader — `src/config/load.ts`
```ts
export interface AccountConfig {
  name: string; provider: string; adapter: string; baseUrl: string;
  keyEnv: string; models: { public: string; target: string }[]; weight?: number;
}
export interface MixConfig { accounts: AccountConfig[] }
export function loadConfig(path: string): MixConfig            // Bun.file / JSON.parse
export function importAccounts(db: Database, cfg: MixConfig, masterKeyHex: string, env?: Record<string,string|undefined>): { imported: string[]; skipped: string[] }
```
- 对每个 account：`name` 已在 DB → skip；否则 `key = env[keyEnv]`（缺失 → 报错，不静默）→ `encryptSecret(key)` → `insertAccount`（1A，建号+state 行）。
- `env` 默认 `process.env`，可注入以便测试。
- `config.json` 与 `.env` 一并 gitignore。示例 `config.example.json` 入库。

### 3.2 anthropic adapter — `src/adapters/anthropic.ts`（透传）
```ts
export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',
  buildRequest(req, account, apiKey) → {
    url: joinPath(baseUrl, '/v1/messages'),
    headers: { 'content-type':'application/json', 'x-api-key': apiKey,
               authorization: `Bearer ${apiKey}`, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ ...req, model: mapModel(req.model, account) }),
  },
  parseResponse: passthrough(body),           // Anthropic 原生 → Anthropic 客户端
  translateStreamChunk: passthrough(raw),     // Anthropic SSE 透传
  classifyError(status, body, headers):       // Anthropic 错误：429→rate_limit(Retry-After，含 NaN 守卫)、401/403→auth、400→bad_request(非重试)、529 overloaded/5xx→server、其余→unknown
}
```
> 同时送 `x-api-key` 与 `Authorization: Bearer`（z.ai 用 ANTHROPIC_AUTH_TOKEN；两个头都带最稳）。Retry-After 加 `Number.isFinite` 守卫（顺带清 1A 遗留的 fix-in-1B 项）。

### 3.3 registry 重构 — `src/adapters/registry.ts`
把 `REGISTRY` map 从 `openai.ts` 挪到 `registry.ts`，注册 `openai` + `anthropic`；`getAdapter` 在此实现。`openai.ts`/`anthropic.ts` 只导出各自 adapter（消除 1A 遗留的"registry.ts 只是薄壳"账，避免 openai.ts 承载跨 adapter 依赖）。

### 3.4 协议过滤 — `pool.ts` + `failover.ts`
- `listCandidates(db, publicModel, now?, adapter?)`：新增可选 `adapter`，非空时 SQL 加 `AND a.adapter = ?`。
- `routeAndCall(..., opts)`：`opts.adapter?` 透传给 `listCandidates`。
- 两个入站各自传自己的协议。

### 3.5 Anthropic 入站 — `src/ingress/anthropic-routes.ts`
- `POST /v1/messages`，复用 `/v1/*` 的 gateway-key 中间件（已覆盖 `/v1/messages`）。
- 解析 Anthropic body → 取 `model`/`stream`，其余原样透传；以 `as ChatRequest` 传给 `routeAndCall`（它只读 `model`+`stream`，body 由 anthropic adapter 原样 `JSON.stringify`，故 Anthropic 的 block-content messages **无需**符合 `ChatMessage` 的 `content:string`）。
- `routeAndCall(db, req, masterKeyHex, { fetchFn, sessionId, adapter:'anthropic' })`。
- 分支同 OpenAI 路由，但**错误用 Anthropic 形状**（`{ type:'error', error:{ type, message } }`）：noCandidates→404、!ok→末次状态(网络/5xx→用 Anthropic `api_error`/529 语义)、stream→SSE 透传、非流式→透传 body。
- `server.ts` 的 `buildApp` 同时 `registerOpenAIRoutes` + `registerAnthropicRoutes`。

### 3.6 OpenAI 入站微调 — `src/ingress/openai-routes.ts`
`routeAndCall` 调用加 `adapter:'openai'`（现在有了 anthropic 账号，OpenAI 入站必须只选 openai 号）。其余不变。

## 4. 切片顺序

- **2a · OpenCode Go 池化**（快）：config loader（3.1）→ 声明 OpenCode Go 账号 → OpenAI 入站（现有 openai adapter + 1B-① 池化）即可池化 + 失败切换。协议过滤(3.4/3.6)一并落地。
- **2b · GLM coding 池化**：registry 重构（3.3）→ anthropic adapter（3.2）→ `/v1/messages` 入站（3.5）→ 声明 GLM 账号 → 验收。

## 5. 数据模型
**不改 schema。** `accounts.adapter` 取 `'openai'|'anthropic'`；config 导入写入。

## 6. 测试策略（全程 mock 上游）
- **config loader**：JSON 解析；按 name 幂等（重复导入不重复插）；`keyEnv` 缺失报错；导入后 `listCandidates` 能查到；key 落库为密文。
- **anthropic adapter**：buildRequest 拼 `/v1/messages` + 两个鉴权头 + model rename；classifyError 各 Anthropic 状态（含 429 Retry-After NaN 守卫、529→server）；parse/stream 透传。
- **协议过滤**：同一 model 同时有 openai + anthropic 号时，`listCandidates(..., 'anthropic')` 只返回 anthropic 号，`'openai'` 只返回 openai 号。
- **/v1/messages 集成**：注入 stub fetch——鉴权 401；池化 + 失败切换（首 GLM 号 429→切次号）；流式 SSE 透传；错误为 Anthropic 形状；无候选 404。
- **验收**：config 声明 2×GLM(anthropic) + 2×OpenCode Go(openai)；`/v1/messages` 请求 glm-5.2 只落 GLM 号并可切换；`/v1/chat/completions` 请求 OpenCode 模型只落 OpenCode 号；交叉协议不串（Anthropic 入站不会选到 openai 的 glm-5.2 号）。

## 7. 验收标准（DoD）
1. `config.json` 声明多账号 → 启动导入 → `GET /v1/models`（及池）可见；密钥库中为密文；重复启动不重复导入。
2. **OpenCode Go**：多个 Go key 经 `/v1/chat/completions` 组池，掉号自动切，`attempt_count` 反映。
3. **GLM coding**：多个 GLM key 经 `/v1/messages`（Anthropic 原生透传）组池，掉号自动切；响应/流式为 Anthropic 形状。
4. **协议不串**：对同时存在于两池的 `glm-5.2`，`/v1/messages` 只路由 anthropic 号、`/v1/chat/completions` 只路由 openai 号。
5. 无密钥进日志；`bun test` 全绿、`bunx tsc --noEmit` 干净。

## 8. Deferred（后续）
跨协议翻译（OpenAI⇄Anthropic，任意客户端×任意 provider）；admin REST/控制台（Phase 3）；session/OAuth 池化（Phase 2）；`config.json` 的热重载/更新既有账号（现仅首启导入缺失项）。以及仍未清的 fix-in-1B 小项（见 `.superpowers/sdd/progress.md`）。
