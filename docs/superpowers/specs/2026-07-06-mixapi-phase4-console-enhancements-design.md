# mixapi Phase 4 · 控制台增强 — 设计文档

- **日期**：2026-07-06
- **状态**：设计已评审通过（用户选「全部做」），待落实施计划
- **基线**：`main` @ `a0a98dd`（Phase 1A/1B/3 + 缓存粘性 + 中文化 + 权重感知路由 已合入）

---

## 1. 背景与范围

到目前，admin 控制台有 Pool / Logs / Stats / Keys 四 tab（自包含单页、零构建），但:日志/统计里账号是 UUID 不好认、无按 gateway-key 用量(后端从不记 `gateway_key_id`)、Stats 只有数字无图表、Pool 不自动刷新、无测试入口、UI 朴素。本阶段在**同一自包含页 + Hono admin 后端**上迭代增强,**不重写、不引第三方前端依赖**。

### 目标（用户批准的全 6 项）
1. **可读性 + 按 key 用量**：日志/统计显示账号与 gateway-key **名称**；后端补 `request_logs.gateway_key_id` 采集,解锁按 key 用量聚合。
2. **Stats 图表化**：内联 SVG(零依赖)—— 请求/错误时间趋势 + 按模型/账号/key 分布。
3. **Logs 增强**：时间范围 + 关键词搜索 + 分页 + 导出 CSV。
4. **Playground(新 tab)**：admin 专用测试端点,后台发一条请求穿过账号池,看命中账号/状态/延迟/token/响应。
5. **Pool 优化**：自动刷新开关 + 名称显示 + 编辑表单补 `egress`。
6. **UI 合理化**：暗色切换按钮 + 排版/间距/宽表处理 + 观感打磨。

### 非目标（YAGNI / deferred）
RBAC/多管理员/审计、配置文件在线编辑、告警/通知、第三方图表库、流式 playground、Phase 2(session/OAuth 池化)。

## 2. 关键决策（ADR）

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| D1 | 前端栈 | **保持零构建自包含单页,vanilla JS,内联 SVG 画图** | 延续项目"单文件、零依赖、`bun run` 即跑" |
| D2 | 名称显示 | **前端映射**(account_id→name 取自 `/admin/accounts`,gateway_key→name/prefix 取自 `/admin/gateway-keys`),不改查询 join | 页面已拉这两份列表,客户端映射最省 |
| D3 | 按 key 用量 | **后端补采集** `gateway_key_id` + `aggregateStats` 加 `byKey` | 现在恒 NULL,不采集就永远做不了 |
| D4 | Playground | **admin 专用 `POST /admin/test`,内部直呼 `routeAndCall`,不落 request_logs** | 复用现成池化/失败切换;不污染统计;admin 已鉴权 |
| D5 | 图表数据 | `aggregateStats` 增 **时间序列 `series`**(按桶计数)供趋势图 | 现有 stats 无时序;桶在后端算,前端只画 |
| D6 | schema | **不改表**;`gateway_keys`/`request_logs` 列已存在(`gateway_key_id` 一直有,只是没写) | 零迁移 |

## 3. 后端设计

### 3.1 采集 `gateway_key_id`（解锁按 key 用量）
- `src/ingress/auth.ts`：新增 `resolveGatewayKeyId(db, authHeader): string | null` —— 与 `verifyGatewayKey` 同逻辑(Bearer + enabled),但返回命中 key 的 `id`(未命中/禁用返回 null)。`verifyGatewayKey` 保留(或以其为基础)。
- `src/server.ts` `/v1/*` 鉴权中间件：改用 `resolveGatewayKeyId`;命中则 `c.set('gatewayKeyId', id)`,未命中 401。
- `openai-routes.ts` / `anthropic-routes.ts`：每处 `logRequest(...)` 传入 `gatewayKeyId: c.get('gatewayKeyId') ?? null`。
- `src/usage/logger.ts`：`RequestLogEntry` 增 `gatewayKeyId?: string | null`;INSERT 写 `gateway_key_id`。

### 3.2 查询增强（`src/admin/queries.ts`）
- `listLogs(db, f)`:`LogFilter` 增 `sinceMs?`, `untilMs?`, `offset?`, `q?`(在 `public_model`/`account_id`/`status` 上做 `LIKE` 或分别匹配)。`WHERE ts >= ? AND ts <= ?`(有值时)、`LIMIT ? OFFSET ?`(offset 夹紧 ≥0)。返回额外附一个 `total`(满足过滤的总数,供分页):改签名为返回 `{ rows, total }`。**参数化,offset/limit 数值夹紧。**
- `aggregateStats(db, sinceMs)`:增 `byKey: StatGroup[]`(`GROUP BY gateway_key_id`,`COALESCE(...,'(none)')`)；增 `series: { bucket: number; requests: number; errors: number }[]`(按固定桶宽分桶——桶宽由 sinceMs 跨度推导:≤2h→5min、≤2d→1h、否则→1d;用 `ts/bucketMs` 取整分组)。

### 3.3 Playground 端点（`src/ingress/admin-routes.ts`）
- `POST /admin/test`(走 admin 会话中间件)：body `{ model, protocol: 'openai'|'anthropic', message: string, sessionId? }`。
- 构造最小请求体(openai:`{model,messages:[{role:'user',content:message}],stream:false}`;anthropic:`{model,messages:[...],max_tokens?,stream:false}`),`routeAndCall(db, req, masterKeyHex, { fetchFn, sessionId, adapter: protocol })`。
- 返回 `{ ok, accountId, accountName?(前端映射), httpStatus, status, latencyMs, attempts, usage?, sample?(响应正文截断~500 字), error? }`;`noCandidates`→404。**不落 request_logs。**

## 4. 前端设计（`src/admin/console.html`）

- **共享**：拉一次 `/admin/accounts`+`/admin/gateway-keys` 建 `id→名称` 映射(`nameForAccount(id)`/`nameForKey(id)`),各 tab 复用;`—`/回退到短 id。自动刷新用一个 `setInterval` 管理器(切 tab/离开即清)。
- **Pool**：账号列名称即现状;新增顶部「自动刷新」开关(默认关,开则每 10s `renderPool`);编辑表单补 `egress` 输入(PATCH 已支持?——**注**:`updateAccount` 目前不含 egress,若要可写需后端 `AccountPatch` 加 `egress`;本期把 egress 加入 PATCH 支持)。
- **Stats**：顶部时窗选择(复用);四卡不变;新增内联 SVG——① 请求/错误趋势(折线或堆叠柱,数据来自 `series`);② 按模型/账号/**key** 的横向柱状(数据来自 `byModel/byAccount/byKey`,账号/key 显示名称)。SVG 自绘,主题色用 CSS 变量。
- **Logs**：过滤区增 时间范围(开始/结束,或快捷"近1h/24h/7d/全部")+ 关键词搜索框 + 分页(上一页/下一页,用 `offset`+`total`)+「导出 CSV」(把当前结果拼 CSV 触发下载)。表格账号显示名称。
- **Playground(新 tab,加入 nav)**：表单——模型(下拉,取自 `/admin/models`)、协议(openai/anthropic)、可选 session id、消息文本框、「发送」。结果卡:命中账号名 + 状态徽章 + HTTP + 延迟 + 尝试次数 + token + 响应片段;出错显示错误。
- **UI 合理化**：nav 底部加「暗色/亮色」切换按钮(写 `:root[data-theme]`,localStorage 记忆,默认跟随系统);统一间距/标题层级;宽表 `.wrap` 横向滚动已在,复核 Logs/Stats 宽表;卡片/表格观感微调。**全程 `el()` 构建,无 `innerHTML` 注入数据;无外部请求;无新依赖。**

## 5. 安全

- Playground 用真实账号凭证打真实上游,仅 admin 会话可达;响应片段截断,不回显任何密钥。
- `gateway_key_id` 只存 id(非明文 key);日志/响应永不含密钥。
- 参数化 SQL(listLogs 新增过滤全部占位符,offset/limit 数值夹紧)。
- CSV 导出在客户端生成,数据即用户已可见的日志行,无新暴露面。

## 6. 测试策略

- **后端(bun test,注入 db/fetchFn)**：
  - `resolveGatewayKeyId`:命中返回 id、禁用/未知/非 Bearer 返回 null;`/v1` 调用后 `request_logs.gateway_key_id` 落值(端到端一条)。
  - `listLogs`:since/until/offset/q 过滤正确、`total` 正确、offset/limit 夹紧。
  - `aggregateStats`:`byKey` 数值、`series` 分桶数与桶宽随跨度变化。
  - `POST /admin/test`:命中账号并回 routing 信息;无候选→404;错误上游→带 error;**不写 request_logs**(计数不变);无鉴权→401。
- **前端**：`GET /admin` 冒烟(200 HTML、五个 tab 标签含新「Playground」、无密钥)——更新现有 smoke 断言;交互行为(图表渲染、分页、导出、playground、暗色切换、自动刷新)由**分支末真实浏览器走查(Playwright)**验证,不造假 DOM 测试。

## 7. 切法（Phase 4 内部，先后端后前端以减往返）
- **T1 后端·日志+查询**:采集 `gateway_key_id`;`listLogs` 加 since/until/offset/q + 返回 `total`;`aggregateStats` 加 `byKey`+`series`;`AccountPatch` 加 `egress`。
- **T2 后端·Playground 端点** `POST /admin/test`。
- **T3 前端·共享映射 + Pool**(名称映射器、自动刷新管理器、Pool 名称/egress/自动刷新)。
- **T4 前端·Stats 图表**(内联 SVG 趋势 + 分布 + byKey)。
- **T5 前端·Logs**(时间范围/搜索/分页/CSV/名称)。
- **T6 前端·Playground tab**(消费 T2)。
- **T7 前端·UI 合理化**(暗色切换 + 排版/宽表/观感 + 冒烟测试更新)。
先 T1/T2(有 bun 测试)→ T3–T7(冒烟 + 分支末实机走查)。

## 8. Deferred
见非目标。历史 fix-in-next-slice 小项(异步重渲染代际令牌、confirmModal 背景点击 Promise、Add 表单 Cancel 不清空等)可在 UI 合理化(T7)顺带收。
