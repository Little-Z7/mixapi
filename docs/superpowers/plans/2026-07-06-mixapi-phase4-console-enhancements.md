# Phase 4 · 控制台增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** 在现有自包含单页控制台 + Hono admin 后端上,补齐可读性/按key用量、Stats 图表、Logs 增强、Playground、Pool 优化、UI 合理化。

**Architecture:** 后端先行(采集 gateway_key_id、查询增强、playground 端点),前端消费。前端保持零构建自包含 `console.html`,内联 SVG 画图。设计细节见 spec `docs/superpowers/specs/2026-07-06-mixapi-phase4-console-enhancements-design.md`。

**Tech Stack:** Bun · Hono · bun:sqlite · vanilla JS · 内联 SVG。

## Global Constraints
- **零新依赖**;`console.html` 保持自包含单页、无外部请求、无 `innerHTML`-from-data(全 `el()`)。
- **不改 schema**;`request_logs.gateway_key_id` 列已存在,`RequestLogEntry.gatewayKeyId` 与 `logRequest` 已支持,仅需路由透传。
- 账号 API key / gateway-key 明文**任何端点/日志/响应都不回读**;`gateway_key_id` 仅存/传 id。
- 参数化 SQL;新增 limit/offset 数值夹紧(≥0,limit ≤1000)。
- 名称显示走**前端映射**(不改 join)。Playground **不落 request_logs**。

---

## Task 1 — 后端:采集 gateway_key_id(端到端)
**Files:** Modify `src/ingress/auth.ts`, `src/server.ts`, `src/ingress/openai-routes.ts`, `src/ingress/anthropic-routes.ts`; Test `tests/gateway-key-logging.test.ts`.
**Interfaces produced:** `resolveGatewayKeyId(db, authHeader): string | null`; Hono context var `gatewayKeyId?: string`.

- `auth.ts`: 加 `resolveGatewayKeyId(db, authHeader?)` —— 同 `verifyGatewayKey` 校验(Bearer 前缀、trim、`enabled=1`),命中返回该行 `id`,否则 `null`。
- `server.ts`: `declare module 'hono' { interface ContextVariableMap { gatewayKeyId?: string } }`;`/v1/*` 中间件改用 `resolveGatewayKeyId`:`const id = resolveGatewayKeyId(deps.db, c.req.header('authorization')); if (!id) return 401; c.set('gatewayKeyId', id);`
- 两个 routes:每处 `logRequest(db, {...})` 增 `gatewayKeyId: c.get('gatewayKeyId') ?? null`。
- **Test:** 播种 gateway key(拿到其 id)→ `buildApp` + trackingFetch → POST 一次 `/v1/chat/completions`(200)→ 查 `SELECT gateway_key_id FROM request_logs` == 该 key id。错误 key → 401 且不写日志。
- **Done:** `bun test tests/gateway-key-logging.test.ts` 绿;`bun test && bunx tsc --noEmit` 全绿。Commit `feat(usage): attribute request_logs to the gateway key that authorized them`。

## Task 2 — 后端:查询增强(listLogs 过滤/分页 + aggregateStats byKey/series + AccountPatch egress)
**Files:** Modify `src/admin/queries.ts`, `src/ingress/admin-routes.ts`, `src/data/accounts.ts`; Test `tests/admin-queries.test.ts`(扩展)。
**Interfaces produced:** `listLogs(db, f) → { rows: Record<string,unknown>[]; total: number }`;`LogFilter` 增 `sinceMs?,untilMs?,offset?,q?`;`Stats` 增 `byKey: StatGroup[]` 与 `series: { bucket:number; requests:number; errors:number }[]`;`AccountPatch` 增 `egress?: string | null`。

- `listLogs`:`WHERE` 追加 `ts>=?`(sinceMs)、`ts<=?`(untilMs)、`q` 时 `(public_model LIKE ? OR account_id LIKE ? OR status LIKE ?)`(`%q%`)。分页 `LIMIT ? OFFSET ?`(limit 夹紧 1..1000,offset 夹紧 ≥0)。**返回 `{ rows, total }`**,`total = SELECT COUNT(*) ... <同 where>`。
- `aggregateStats`:增 `byKey = groupBy(db,'gateway_key_id',sinceMs)`;增 `series`:`SELECT (ts/?)*? AS bucket, COUNT(*) requests, SUM(status='error') errors FROM request_logs WHERE ts>=? GROUP BY bucket ORDER BY bucket`,桶宽 `bucketMs` 由跨度推导——`now-sinceMs<=2h→5min`、`<=2d→1h`、`else→1d`(sinceMs=0 视作大跨度→1d)。
- `admin-routes.ts` GET `/admin/logs`:读 `q.sinceMs,q.untilMs,q.offset`(Number,NaN 守卫);回 `listLogs(...)` 的 `{rows,total}`(**注意返回结构变了**)。
- `accounts.ts`:`AccountPatch` 加 `egress?`;`updateAccount` 动态 SET 支持 `egress`(`egress=?`)。
- **Test:** 造多条 log(不同 ts/model/account/status/gateway_key_id)→ since/until 过滤条数、offset 翻页、q 命中、`total` 正确;`aggregateStats` `byKey` 数值 + `series` 桶数随 sinceMs 跨度变;`updateAccount({egress})` 写入生效。
- **Done:** 相关 test 绿 + 全绿。Commit `feat(admin): log filters/pagination + stats byKey/series + editable egress`。

## Task 3 — 后端:Playground 端点 `POST /admin/test`
**Files:** Modify `src/ingress/admin-routes.ts`; Test `tests/admin-playground.test.ts`.
**Interfaces produced:** `POST /admin/test {model, protocol:'openai'|'anthropic', message, sessionId?}` → `{ok, accountId?, httpStatus?, status, latencyMs, attempts, usage?, sample?, error?}`。

- 走 admin 会话中间件(在 `/admin/*` 门内)。构造最小请求:openai `{model,messages:[{role:'user',content:message}],stream:false}`;anthropic 同加 `max_tokens:1024`。`routeAndCall(db, req, masterKeyHex, {fetchFn, sessionId, adapter:protocol})`。
- 返回:`noCandidates`→`{ok:false,status:'no_candidates'}` 404;失败→`{ok:false,status:'error',httpStatus,attempts,error}`;成功→解析 usage,`sample` = 响应正文截断 ~500 字,`{ok:true,accountId,httpStatus,status:'ok',latencyMs,attempts,usage,sample}`。**不调 logRequest。**
- **Test:** 注入 fetchFn 返回成功体 → 命中账号 + ok;无账号服务该模型 → 404;fetchFn 500 → ok:false + error;调用前后 `countLogs` 不变(不落库);无 admin cookie → 401。
- **Done:** test 绿 + 全绿。Commit `feat(admin): /admin/test playground endpoint (routes through the pool, does not log)`。

## Task 4 — 前端:共享名称映射 + Pool 优化
**Files:** Modify `src/admin/console.html`.
**Consumes:** `/admin/accounts`(id/name/egress)、`/admin/gateway-keys`(id/name/keyHashPrefix);`PATCH /admin/accounts/:id {egress?}`(T2)。
- 加共享:启动/刷新时缓存账号与 key 列表,`nameForAccount(id)`、`nameForKey(id)`(回退短 id/`(none)`);`autoRefresh` 管理器(单一 `setInterval`,`selectTab`/登出时清)。
- Pool:编辑表单补 `egress` 输入(空→不发/发 null);顶部「自动刷新」开关(默认关,开则每 10s `renderPool`);`lastError`/状态照旧。
- **Done(前端无 bun 测试)**:`bun test && bunx tsc --noEmit` 仍绿(冒烟不破);行为留分支末实机走查。Commit `feat(admin-ui): shared name maps + Pool egress field + auto-refresh`。

## Task 5 — 前端:Stats 图表(内联 SVG)
**Files:** Modify `src/admin/console.html`.
**Consumes:** `GET /admin/stats?sinceMs`(含新 `byKey`/`series`)。
- 四卡不变。加内联 SVG:① 趋势——`series` 的 requests(与 errors)按 bucket 画折线/堆叠柱,x 轴时间、y 轴计数;② 分布——`byModel`/`byAccount`/`byKey` 各一组横向柱(账号/key 显示名称),值标注。SVG 用 `document.createElementNS`,主题色用 CSS 变量;空数据显「暂无数据」。
- **Done:** 全绿(冒烟不破)。行为留实机走查。Commit `feat(admin-ui): Stats inline-SVG trend + model/account/key distribution`。

## Task 6 — 前端:Logs 增强
**Files:** Modify `src/admin/console.html`.
**Consumes:** `GET /admin/logs?limit&offset&model&account&status&sinceMs&untilMs&q`(返回 `{rows,total}`,T2)。
- 过滤区增:时间快捷(近1h/24h/7d/全部→算 sinceMs)+ 关键词搜索(q)+ 现有 model/account/status。分页:`offset`+`total`,上一页/下一页 + 「第 X–Y / 共 N」。「导出 CSV」:把**当前结果行**拼 CSV(表头 + 转义),`Blob`+`a[download]` 触发下载。账号列显示名称。
- **Done:** 全绿。行为留实机走查。Commit `feat(admin-ui): Logs time-range + search + pagination + CSV export`。

## Task 7 — 前端:Playground tab
**Files:** Modify `src/admin/console.html`(nav 加第五 tab)。
**Consumes:** `POST /admin/test`(T3)、`GET /admin/models`。
- nav 增「Playground」按钮 + `renderPlayground`。表单:模型下拉(`/admin/models`)、协议(openai/anthropic 单选)、可选 session id、消息 textarea、「发送」。结果卡:命中账号**名称** + 状态徽章 + HTTP + 延迟 + 尝试 + token + 响应片段(`<pre>` 截断);错误显示 error。发送中禁用按钮。
- 冒烟测试 `tests/admin-console.test.ts`:tab 标签数组加 `'Playground'` 断言(与其他四中文标签一起)。
- **Done:** 冒烟(更新后)+ 全绿。行为留实机走查。Commit `feat(admin-ui): Playground tab — send a test request through the pool`。

## Task 8 — 前端:UI 合理化
**Files:** Modify `src/admin/console.html`.
- nav 底部加「暗色/亮色」切换按钮:切 `:root[data-theme='dark'|'light']`,`localStorage` 记忆,默认跟随系统(不设 data-theme 时 `prefers-color-scheme` 生效);CSS 需支持 `:root[data-theme=dark]` 覆盖变量。
- 排版/间距/标题层级统一;宽表(Logs/Stats)确保 `.wrap` 横向滚动;卡片/表格/按钮观感微调;顺带收历史小项(Add 表单 Cancel 清空、异步重渲染代际令牌——`selectTab` 加自增 token,渲染前后校验再 append)。
- **Done:** 全绿(冒烟不破)。**分支末:控制器实机走查(Playwright)全 tab + 暗色 + 分页 + 导出 + playground**,再最终全分支审查 → 合并。Commit `feat(admin-ui): dark-mode toggle + layout polish + render-generation guard`。

---

## Self-review
- Spec 覆盖:§3.1→T1、§3.2→T2、§3.3→T3、§4 Pool→T4、Stats→T5、Logs→T6、Playground→T7、UI→T8。全覆盖。
- 类型一致:`listLogs`→`{rows,total}`(T2 改,T6 消费一致);`resolveGatewayKeyId`(T1 产,server 用);`byKey/series`(T2 产,T5 消费);`egress`(T2 后端 + T4 前端)。
- 破坏性变更:`listLogs` 返回结构变 → T2 同步改 `admin-routes` GET /admin/logs 与冒烟无关(冒烟只测 GET /admin)。
