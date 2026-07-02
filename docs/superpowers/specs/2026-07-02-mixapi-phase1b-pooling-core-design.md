# mixapi Phase 1B-① · 池化核心（Pooling Core）— 设计文档

- **日期**：2026-07-02
- **状态**：设计已评审通过，待落实施计划
- **上游文档**：产品总设计 `2026-07-01-mixapi-account-pool-gateway-design.md`；1A 实施计划 `2026-07-01-mixapi-phase1a-walking-skeleton.md`
- **基线**：`main` @ `6a376fc`（Phase 1A 已合入）

---

## 1. 背景与范围

Phase 1A 交付了单账号的 OpenAI 兼容网关（`selectAccountForModel` 取第一个可用账号）。本切片（1B-①）把它升级为**真正的账号池 + 健康路由 + 失败切换**：同一 public 模型的多个账号组成池，掉号自动切到健康账号。

这是 Phase 1B 的第一刀。1B 的其余部分（Anthropic adapter、admin CRUD、config 引导、验收套件）属于 **1B-②**，不在本 spec。

### 目标（1B-①）
- 同一 model 的多账号组成池，按健康度/权重/粘性选号。
- 上游返回可重试错误（429/5xx/网络异常/auth）时，自动切换到另一个健康账号，客户端无感。
- 掉号进入冷却并被摘除，冷却到点自动重新入选。

### 非目标（本切片不做）
- **多账号的声明/运维入口**（config.yaml 引导、admin CRUD）→ 1B-②。本切片靠测试 + 程序化 `insertAccount` 验证池化逻辑。
- Anthropic adapter、验收套件 → 1B-②。
- session/OAuth 凭证、每账号出口 IP → Phase 2。
- 在飞请求计数 / power-of-two-choices 负载感知选号（YAGNI，后续增强）。

## 2. 关键决策

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| D1 | failover 流式提交粒度 | **按响应状态提交（A）** | `callUpstream` 已只在 `resp.ok && body` 时返回 stream，否则降级 json 错误；有 stream 即提交+透传，无 stream 且可重试即换号。客户端见到字节前决定好，覆盖 429/401/5xx 等绝大多数掉号，复用现成代码。"200 后 SSE 内出错"的罕见边缘不换号（文档化后续增强 = 偷看首 token）。 |
| D2 | 账号恢复机制 | **走时间，不用定时任务** | 候选查询用 `cooldown_until 为空或已过` 过滤；冷却到点的号自动重新入选，下次成功即回 `healthy`。零后台调度。 |
| D3 | 选号策略 | **粘性 → 加权随机** | `x-session-id` 一致性哈希粘同号（健康时）；否则 `weight×健康因子` 加权随机。选号是纯函数 + 可注入 rng，确定性可测。 |
| D4 | 网络异常处理 | **当作可重试，换号** | 单账号 fetch 抛错 → 视为 server/可重试 → 尝试下一个候选（优于 1A 的直接 502）。 |
| D5 | schema | **不改** | `account_state`（1A 已建：status/cooldown_until/consecutive_errors/last_used_at/last_error/last_checked_at）已足够。 |

## 3. 组件设计（全部在 `src/core/`）

### 3.1 `health.ts` — 健康状态机

纯粹的状态转移 + 持久化，无网络、无调度。

```ts
export function applyError(db: Database, accountId: string, cls: ErrorClassification): void
export function applySuccess(db: Database, accountId: string): void
```

**`applyError` 转移规则**（读当前 `consecutive_errors` 决定退避）：
- `reason='rate_limit'` → `status='cooling'`，`cooldown_until = now + (cls.cooldownMs ?? backoff(n))`，`consecutive_errors++`
- `reason='quota'` → `status='exhausted'`，`cooldown_until = now + QUOTA_COOLDOWN_MS`（默认 1h，常量），`consecutive_errors++`
- `reason='auth'` → `status='disabled'`，`cooldown_until=NULL`（需人工/enable 才回），`consecutive_errors++`
- `reason='server'` → `status='cooling'`，`cooldown_until = now + backoff(n)`（短），`consecutive_errors++`
- `reason='bad_request'` 或 `'unknown'` → **不改状态**（无法归因到账号，不惩罚；`bad_request` 且 `retryable=false` 还会终止 failover）
- 熔断：`backoff(n)` 随 `consecutive_errors` 指数增长并封顶，天然实现"连续失败→越冷越久"。

**`applySuccess`** → `status='healthy'`，`consecutive_errors=0`，`last_used_at=now`，`last_checked_at=now`。

**常量**（模块内，便于测试与调参）：`BACKOFF_BASE_MS=5000`、`BACKOFF_CAP_MS=300000`、`QUOTA_COOLDOWN_MS=3600000`、`CIRCUIT_THRESHOLD=5`。`backoff(n)=min(BACKOFF_BASE_MS * 2^min(n,6), BACKOFF_CAP_MS)`。

> `bad_request` 的判定沿用 adapter.classifyError 的 `retryable`：`retryable=false` 一律不改健康、不换号。

### 3.2 `pool.ts` — 候选查询

```ts
export interface Candidate extends ResolvedAccount { secretEnc: Uint8Array; status: string; }
export function listCandidates(db: Database, publicModel: string, now?: number): Candidate[]
```

SQL：join `accounts` + `account_state`，筛选
`a.enabled=1 AND s.status != 'disabled' AND (s.cooldown_until IS NULL OR s.cooldown_until <= now)`，
再在 JS 侧 `.filter(models 含 publicModel)`（与 1A `listEnabledAccountsForModel` 同法）。
`now` 参数默认 `Date.now()`，便于测试注入时间。

> 缺 `account_state` 行的账号（理论上不会，`insertAccount` 建号即建 state 行）用 `LEFT JOIN` + `COALESCE(status,'unknown')` 兜底，视为可选。

### 3.3 `router.ts` — 选号（纯函数）

```ts
export function selectCandidate(
  candidates: Candidate[],
  opts?: { sessionId?: string; exclude?: Set<string>; rng?: () => number }
): Candidate | null
```

- 先按 `opts.exclude`（已尝试过的 account id）过滤。
- `sessionId` 存在：`hash(sessionId) % pool.length` 取稳定索引；若该候选未被 exclude 则选它（粘性）。
- 否则：按 `weight`（默认 1）加权随机，`rng` 可注入（默认 `Math.random`）。
- 空 → `null`。

纯函数，不碰 DB/网络；`hash` 用一个简单稳定字符串哈希（如 FNV-1a），确定性可测。

### 3.4 `failover.ts` — 尝试循环

```ts
export interface RouteOutcome {
  ok: boolean;
  result?: UpstreamResult;      // 成功时的上游结果（stream 或 json）
  account?: ResolvedAccount;    // 命中的账号
  attempts: number;             // 实际尝试次数
  lastError?: { httpStatus: number; reason: ErrorReason };  // 全失败时
  noCandidates?: boolean;       // 池中无候选
}

export async function routeAndCall(
  db: Database, req: ChatRequest, masterKeyHex: string,
  opts: { fetchFn?: typeof fetch; sessionId?: string; maxAttempts?: number }
): Promise<RouteOutcome>
```

流程：
1. `candidates = listCandidates(db, req.model)`；空 → `{ ok:false, noCandidates:true, attempts:0 }`。
2. 循环，`maxAttempts` 默认 3，`tried = new Set()`：
   - `cand = selectCandidate(candidates, { sessionId, exclude: tried, rng })`；`null` → 结束循环。
   - `tried.add(cand.id)`；`apiKey = new StaticKeyCredential(cand.secretEnc, masterKeyHex).getApiKey()`。
   - `adapter = getAdapter(cand.adapter)`；`u = adapter.buildRequest(req, cand, apiKey)`。
   - `try { result = await callUpstream(u, req.stream, fetchFn) } catch { 视为网络错：applyError(server, retryable); continue }`。
   - **成功判定（提交点）**：`result.stream`（流式 200）或 `result.status < 400`（非流式成功）→ `applySuccess(cand)`；返回 `{ ok:true, result, account:cand, attempts }`。
   - **失败**：`cls = adapter.classifyError(result.status, result.json, result.headers)`；`applyError(cand, cls)`；`lastError = {status, reason}`；若 `cls.retryable` 且还有未试候选 → 继续；否则 break。
3. 循环结束仍失败 → `{ ok:false, attempts, lastError }`。

## 4. 集成改动 — `src/ingress/openai-routes.ts`

把 1A 的"`selectAccountForModel` + 单次 `callUpstream` + 两处错误分支"替换为一次 `routeAndCall`，再按其 `RouteOutcome` 分支：

- `outcome.noCandidates` → 404（无账号服务该 model），落 error 日志。
- `!outcome.ok`（全部尝试失败）→ 用 `lastError.httpStatus`（或 502 若是网络类）返回错误 json，落 error 日志，`attempt_count = outcome.attempts`。
- `outcome.ok`：
  - `result.stream` → 返回 SSE Response（同 1A），落 ok 日志，`attempt_count = outcome.attempts`。
  - 否则 → `parseResponse` + usage + 成本，落 ok 日志（`account_id = outcome.account.id`，`attempt_count`）。
- 保留 1A 的畸形 JSON → 400 守卫。1A 的"上游网络故障→502"整体 catch **下沉进 failover 的每次尝试**（网络错在单号上触发换号；只有所有候选都网络失败才 502）。
- `sessionId` 来自请求头 `x-session-id`（可选）。

`selectAccountForModel`（1A Task 7）在本切片后不再被路由调用；保留文件不删（或标注 deprecated），避免牵连其单测——由 1B-① 的 failover 单测覆盖新路径。

## 5. 数据模型

**不改 schema。** 复用 `account_state`（1A）：`status ∈ {healthy,cooling,exhausted,disabled,unknown}`、`cooldown_until`、`consecutive_errors`、`last_used_at`、`last_error`、`last_checked_at`。`insertAccount`（1A）建号即建 state 行（初始 `unknown`）。

## 6. 测试策略（全程 mock 上游，不打真实平台）

- **health.ts 单测**：各 `ErrorClassification` → 期望 `status`/`cooldown_until`/`consecutive_errors`；`bad_request` 不改状态；`backoff` 随连续错误增长并封顶；`applySuccess` 清零回 healthy。用注入的 `now` 断言冷却时间。
- **pool.ts 单测**：真内存 DB + 多账号/多状态 → 候选过滤（enabled / model / status≠disabled / cooldown 未过）；注入 `now` 验证"冷却到点重新入选"。
- **router.ts 单测**：注入 `rng` 的确定性选号；`exclude` 生效；同 `sessionId` → 同账号（粘性）；加权倾向（多次采样分布）。
- **failover.ts 单测/集成**：注入 `fetchFn` 的 mock 上游——
  - 前 N 个候选 429（无 stream）→ 自动切到健康号成功，`attempts` 反映，被切号进入 cooling。
  - 网络抛错的号 → 换号成功。
  - 非重试（400）→ 不换号，立即返回。
  - 无候选 → `noCandidates`。
  - 流式：首号 429 → 次号返回 stream → 提交透传。
- **chat 路由集成**：≥2 账号服务同一 model，首号 429 → 路由透明返回次号响应，落日志 `attempt_count=2`、`account_id=次号`，首号 `account_state` 变 cooling。

## 7. 验收标准（1B-① DoD）

1. 池中 ≥2 个服务同一 model 的账号；一次请求路由到其一；该号返回可重试错误 → 自动重试另一个健康号，`request_logs.attempt_count` 反映，最终成功且客户端无感。
2. 被限速/报错的号进入 `cooling` 并从候选摘除；`cooldown_until` 到点后重新入选，成功后回 `healthy`。
3. 相同 `x-session-id` 的请求在账号健康时落到同一账号。
4. 非重试错误（400）不触发换号。
5. 池中全部候选失败 → 返回错误（网络类 502 / 否则末次上游状态），落 error 日志；无候选 → 404。
6. 所有场景经 mock 上游的单测 + 集成测试通过；`bun test` 全绿、`bunx tsc --noEmit` 干净。

## 8. 1B-② 预留（下一刀）

Anthropic adapter（接 GLM coding，含 registry.ts 承载多 adapter）、config.yaml 引导（声明多账号入池，使 1B-① 端到端可运维）、admin REST（CRUD + 健康视图）、mock 上游驱动的验收套件。以及从 1A/1B-① 审查累积的 fix-in-1B（credentials.account_id UNIQUE+FK、typecheck 脚本、Retry-After NaN 守卫等），见本地 `.superpowers/sdd/progress.md`。
