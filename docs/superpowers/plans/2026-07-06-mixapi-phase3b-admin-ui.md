# mixapi Phase 3b · Admin 控制台 UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `GET /admin` placeholder shell with a real, self-contained single-page console (login + Pool / Logs / Stats / Keys tabs) that consumes the Phase 3a admin REST endpoints.

**Architecture:** One vanilla-JS HTML page (`src/admin/console.html`) with inline CSS + JS, no build step and no external requests. A tiny TS wrapper (`src/admin/console-page.ts`) reads that file at module load with `readFileSync(new URL('./console.html', import.meta.url))` and exports it as a string; `admin-routes.ts` serves it at `GET /admin`. The page authenticates by posting the admin key to `/admin/login` (which sets the httpOnly HMAC cookie), then all data calls are same-origin `fetch` with `credentials:'same-origin'`.

**Tech Stack:** Bun, Hono, vanilla ES2020 JS (no framework, no bundler), `node:fs` (already available). **Zero new dependencies.**

## Global Constraints

- **Zero new dependencies.** No frontend framework, no bundler, no CDN/external `<script>`/`<link>`/font/image. The page is fully self-contained and makes **no external network requests** — only same-origin `fetch('/admin/…')`.
- **Secrets never in the page.** The served HTML is a static file; it must contain no key material and no server-side interpolation. Account API keys are write-only (never read back by any endpoint). A gateway-key's raw value is shown **once**, only in response to the operator's own "new key" action, and never persisted in the DOM after the modal closes.
- **Auth model is fixed (from 3a):** cookie is httpOnly + `SameSite=Strict` + `Secure`, `Path=/admin`. Because the page lives at `/admin` and all data endpoints are under `/admin/*`, same-origin `fetch` carries the cookie automatically — do **not** attempt to read the cookie from JS (it is httpOnly). A `401` from any data call means "session expired" → show the login view.
- **No browser modal dialogs.** Do **not** use `window.confirm` / `window.alert` / `window.prompt` (they block automation and are ugly). Use in-page confirm/notice elements.
- **Theme:** light/dark via `prefers-color-scheme`, clean typography, desktop-first.
- **Endpoints are frozen (3a).** This plan changes only `GET /admin`'s response and adds the page files + tests. Do not modify any `/admin/*` data route or any `src/data`/`src/admin/queries` function.

### Frozen endpoint contract (consumed by the page — do not change server side)

| Method | Path | Request body | Response |
|---|---|---|---|
| GET | `/admin/session` | — | `200 {authed:true}` if cookie valid, else `401 {error}` |
| POST | `/admin/login` | `{key}` | `200 {authed:true}` + Set-Cookie / `401 {error}` |
| POST | `/admin/logout` | — | `200 {authed:false}` |
| GET | `/admin/accounts` | — | `AccountWithState[]` (see shape below) |
| POST | `/admin/accounts` | `{name,provider?,adapter,baseUrl,models?,weight?,egress?,key}` | `201 {id}` / `400 {error}` |
| PATCH | `/admin/accounts/:id` | `{baseUrl?,models?,weight?,enabled?,key?}` | `200 {ok:true}` |
| DELETE | `/admin/accounts/:id` | — | `200 {ok:true}` |
| POST | `/admin/accounts/:id/reset-cooldown` | — | `200 {ok:true}` |
| GET | `/admin/gateway-keys` | — | `GatewayKeyInfo[]` |
| POST | `/admin/gateway-keys` | `{name}` | `201 {id, key:<raw once>}` |
| DELETE | `/admin/gateway-keys/:id` | — | `200 {ok:true}` |
| GET | `/admin/logs?limit&model&account&status` | — | `request_logs` rows (`SELECT *`, `ts DESC`) |
| GET | `/admin/stats?sinceMs` | — | `Stats` |
| GET | `/admin/models` | — | `string[]` |

Response shapes (verbatim from 3a source):

```
AccountWithState = {
  id, name, provider, adapter, baseUrl,
  models: [{ public, target }], weight, egress, enabled: boolean,
  state: { status, cooldownUntil: number|null, consecutiveErrors: number,
           lastUsedAt: number|null, lastError: string|null }
}
// state.status ∈ 'healthy' | 'cooling' | 'exhausted' | 'disabled' | 'unknown'

GatewayKeyInfo = { id, name: string|null, keyHashPrefix: string(8), enabled: boolean, createdAt: number }

request_logs row = { id, ts, gateway_key_id, public_model, account_id, status,
  http_status, latency_ms, prompt_tokens, completion_tokens, total_tokens,
  est_cost, attempt_count, stream, client_ip }
// status is 'ok' | 'error'

Stats = { totalRequests, errorCount, errorRate, totalTokens, totalCost,
  byModel:  [{ key, requests, errors, tokens, cost }],
  byAccount:[{ key, requests, errors, tokens, cost }] }
```

---

## File Structure

- **Create `src/admin/console.html`** — the entire self-contained page (inline `<style>` + `<script>`). Single responsibility: the operator UI. Grows across Tasks 1→3.
- **Create `src/admin/console-page.ts`** — one export: `CONSOLE_HTML` (the file's text, read once at module load). Isolates the file-read so routes stay clean and the string is testable.
- **Modify `src/ingress/admin-routes.ts`** — delete the `SHELL` constant; import `CONSOLE_HTML`; serve it at `GET /admin`. No other change.
- **Create `tests/admin-console.test.ts`** — served-HTML smoke + no-secret + static-independent-of-DB assertions (the only automated gate; interactive behavior is verified by the branch-end live browser walkthrough).

**Note on verification for Tasks 2 & 3:** the tab interactions are vanilla client JS; per the design, heavy browser e2e (Playwright) is deferred. Their automated gate is (a) the existing suite stays green, (b) `bunx tsc --noEmit` clean, and (c) the Task-1 smoke test's structural assertions still hold. Their **behavioral** gate is the controller-run live browser walkthrough at branch end (launch server, log in, click every tab and action). Do not fabricate meaningless unit tests for DOM code.

---

## Task 1: Console page skeleton — login, session, tab shell, serve wiring, smoke tests

**Files:**
- Create: `src/admin/console.html`
- Create: `src/admin/console-page.ts`
- Modify: `src/ingress/admin-routes.ts` (remove `SHELL`, serve `CONSOLE_HTML`)
- Test: `tests/admin-console.test.ts`

**Interfaces:**
- Consumes: `buildApp(deps)` from `src/server.ts` (already registers admin routes when `deps.adminKey` set); `GET/POST /admin/session|login|logout` from 3a.
- Produces: `CONSOLE_HTML: string` (from `console-page.ts`); a page exposing global JS hooks `showLogin()`, `showApp()`, `selectTab(name)`, and `api(path, opts)` that Tasks 2–3 extend with `renderPool/renderLogs/renderStats/renderKeys`.

- [ ] **Step 1: Write the failing smoke test**

`tests/admin-console.test.ts` (follows the existing admin-test conventions: `openDb`/`applySchema`, `KEY='a'.repeat(64)`, `ADMIN='admin-secret'`, flat `test(...)`):

```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { buildApp } from '../src/server';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';

const KEY = 'a'.repeat(64);              // valid 32-byte hex master key
const ADMIN = 'admin-secret';

function appWith(seed = false) {
  const db = openDb(':memory:'); applySchema(db);
  if (seed) {
    insertAccount(db, {
      name: 'glm-1', provider: 'zhipu', adapter: 'anthropic',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      models: [{ public: 'glm-4.6', target: 'glm-4.6' }], weight: 1, egress: null,
      secretEnc: encryptSecret('sk-should-never-appear', KEY),
    });
  }
  return buildApp({ db, masterKeyHex: KEY, adminKey: ADMIN });
}

test('GET /admin serves 200 HTML with the login view, app shell, and all four tab labels', async () => {
  const res = await appWith().request('/admin');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type') ?? '').toContain('text/html');
  const html = await res.text();
  expect(html).toContain('id="login"');           // login view present
  expect(html).toContain('id="app"');             // app view present
  for (const t of ['Pool', 'Logs', 'Stats', 'Keys']) expect(html).toContain(t);
});

test('GET /admin is static — identical regardless of DB contents and leaks no secret', async () => {
  const empty = await (await appWith(false).request('/admin')).text();
  const seeded = await (await appWith(true).request('/admin')).text();
  expect(seeded).toBe(empty);                      // no server-side interpolation
  expect(seeded).not.toContain('sk-should-never-appear');
  expect(seeded).not.toContain(ADMIN);
  expect(seeded).not.toContain(KEY);
});

test('GET /admin wires the auth flow and the four tab buttons', async () => {
  const html = await (await appWith().request('/admin')).text();
  // auth endpoints exist in the skeleton (Task 1); data endpoints are added in Tasks 2–3
  for (const p of ['/admin/login', '/admin/session', '/admin/logout']) expect(html).toContain(p);
  for (const t of ['pool', 'logs', 'stats', 'keys']) expect(html).toContain(`data-tab="${t}"`);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test tests/admin-console.test.ts`
Expected: FAIL — the current `SHELL` has no `id="login"`/`id="app"`, no tab labels, and does not reference the endpoint paths.

- [ ] **Step 3: Create `src/admin/console.html` (skeleton)**

Write a complete self-contained page with this exact structure. Fill the four `render*` functions as **stubs** that set `#view` to a "loading…" line — Tasks 2 and 3 replace the stub bodies. Everything else here is final.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mixapi admin</title>
<style>
  :root{
    --bg:#f6f7f9; --panel:#fff; --ink:#1b1f24; --muted:#6b7280; --line:#e5e7eb;
    --accent:#2563eb; --ok:#16a34a; --warn:#d97706; --err:#dc2626; --grey:#9ca3af; --slate:#64748b;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#0f1216; --panel:#171b21; --ink:#e6e8eb; --muted:#9aa4b2; --line:#252b33;
      --accent:#3b82f6; --ok:#22c55e; --warn:#f59e0b; --err:#ef4444; --grey:#6b7280; --slate:#94a3b8; }
  }
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:var(--bg);color:var(--ink)}
  button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--ink);
    border-radius:6px;padding:5px 10px}
  button.primary{background:var(--accent);color:#fff;border-color:transparent}
  button.danger{color:var(--err);border-color:var(--err)}
  button:disabled{opacity:.5;cursor:default}
  input,select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;
    background:var(--panel);color:var(--ink)}
  a{color:var(--accent)}
  table{border-collapse:collapse;width:100%;background:var(--panel)}
  th,td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top;font-size:13px}
  th{color:var(--muted);font-weight:600;white-space:nowrap}
  .wrap{overflow-x:auto}
  .badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;color:#fff}
  .b-healthy{background:var(--ok)} .b-cooling{background:var(--warn)} .b-exhausted{background:var(--err)}
  .b-disabled{background:var(--grey)} .b-unknown{background:var(--slate)}
  .muted{color:var(--muted)} .err{color:var(--err)} .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  /* login */
  #login{max-width:360px;margin:14vh auto;padding:28px;background:var(--panel);border:1px solid var(--line);
    border-radius:12px}
  #login h1{margin:0 0 4px;font-size:20px} #login p{margin:0 0 18px;color:var(--muted)}
  #login input{width:100%;margin-bottom:12px} #login button{width:100%}
  /* app */
  #app{display:none;min-height:100vh;grid-template-columns:200px 1fr}
  nav{background:var(--panel);border-right:1px solid var(--line);padding:16px 10px;display:flex;flex-direction:column;gap:4px}
  nav .brand{font-weight:700;padding:6px 10px 14px}
  nav button{background:transparent;border:none;text-align:left;padding:8px 10px;border-radius:6px;width:100%}
  nav button.active{background:var(--accent);color:#fff}
  nav .spacer{flex:1}
  main{padding:22px 26px;min-width:0}
  main h2{margin:0 0 14px;font-size:18px}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
  .card{display:inline-block;min-width:150px;padding:14px 16px;margin:0 12px 12px 0;background:var(--panel);
    border:1px solid var(--line);border-radius:10px}
  .card .n{font-size:24px;font-weight:700} .card .l{color:var(--muted);font-size:12px}
  /* modal / toast */
  #modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center}
  #modal .box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px;max-width:460px;width:92%}
  #toast{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:60}
  #toast div{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);
    padding:10px 14px;border-radius:8px;max-width:340px}
  #toast div.err{border-left-color:var(--err)}
</style>
</head>
<body>
  <!-- LOGIN VIEW -->
  <div id="login" style="display:none">
    <h1>mixapi admin</h1>
    <p>Enter the admin key to continue.</p>
    <input id="loginKey" type="password" placeholder="ADMIN_KEY" autocomplete="off">
    <button id="loginBtn" class="primary">Sign in</button>
    <p id="loginErr" class="err" style="display:none;margin-top:12px"></p>
  </div>

  <!-- APP VIEW -->
  <div id="app">
    <nav>
      <div class="brand">mixapi</div>
      <button data-tab="pool" class="active">Pool</button>
      <button data-tab="logs">Logs</button>
      <button data-tab="stats">Stats</button>
      <button data-tab="keys">Keys</button>
      <div class="spacer"></div>
      <button id="logoutBtn">Sign out</button>
    </nav>
    <main><div id="view"></div></main>
  </div>

  <div id="modal"><div class="box" id="modalBox"></div></div>
  <div id="toast"></div>

<script>
"use strict";
const $ = (s, r=document) => r.querySelector(s);
const el = (tag, props={}, kids=[]) => {           // tiny DOM builder — NO innerHTML for data
  const n = document.createElement(tag);
  for (const k in props){
    if (k === 'class') n.className = props[k];
    else if (k === 'text') n.textContent = props[k];
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), props[k]);
    else if (props[k] != null) n.setAttribute(k, props[k]);
  }
  for (const c of [].concat(kids)) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};

async function api(path, opts={}){
  const r = await fetch(path, {
    credentials:'same-origin',
    headers:{'content-type':'application/json'},
    ...opts,
  });
  if (r.status === 401){ showLogin(); throw new Error('unauthorized'); }
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
  return body;
}

function toast(msg, isErr){
  const t = el('div', { class: isErr ? 'err' : '', text: String(msg) });
  $('#toast').append(t);
  setTimeout(() => t.remove(), 4200);
}

// promise-based in-page confirm (NEVER window.confirm)
function confirmModal(message, confirmLabel='Confirm', danger=false){
  return new Promise((resolve) => {
    const box = $('#modalBox'); box.textContent='';
    box.append(el('p', { text: message, style:'margin:0 0 18px' }));
    const bar = el('div', { class:'row', style:'margin:0;justify-content:flex-end' }, [
      el('button', { text:'Cancel', onclick: () => { close(); resolve(false); } }),
      el('button', { text: confirmLabel, class: danger ? 'danger' : 'primary',
        onclick: () => { close(); resolve(true); } }),
    ]);
    box.append(bar);
    $('#modal').style.display='flex';
    function close(){ $('#modal').style.display='none'; }
  });
}
// show an arbitrary node in the modal (used by Keys "show once")
function showModal(node){ const b=$('#modalBox'); b.textContent=''; b.append(node); $('#modal').style.display='flex'; }
function closeModal(){ $('#modal').style.display='none'; }

// ---- formatting helpers ----
const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : '—';
const fmtCost = (n) => '$' + (Number(n)||0).toFixed(4);
const fmtNum  = (n) => (Number(n)||0).toLocaleString();
const cooldownLeft = (until) => {
  if (!until) return '—';
  const s = Math.max(0, Math.round((until - Date.now())/1000));
  return s ? (s>=60 ? Math.floor(s/60)+'m'+(s%60)+'s' : s+'s') : '—';
};

// ---- view switching ----
function showLogin(){ $('#app').style.display='none'; $('#login').style.display='block'; $('#loginKey').focus(); }
function showApp(){ $('#login').style.display='none'; $('#app').style.display='grid'; }

const RENDERERS = { pool: renderPool, logs: renderLogs, stats: renderStats, keys: renderKeys };
function selectTab(name){
  for (const b of document.querySelectorAll('nav [data-tab]')) b.classList.toggle('active', b.dataset.tab===name);
  $('#view').textContent = '';
  RENDERERS[name]().catch(e => toast(e.message, true));
}

// ---- STUBS (replaced in Tasks 2 & 3) ----
async function renderPool(){  $('#view').append(el('p',{class:'muted',text:'Pool — loading…'})); }
async function renderLogs(){  $('#view').append(el('p',{class:'muted',text:'Logs — loading…'})); }
async function renderStats(){ $('#view').append(el('p',{class:'muted',text:'Stats — loading…'})); }
async function renderKeys(){  $('#view').append(el('p',{class:'muted',text:'Keys — loading…'})); }

// ---- auth wiring ----
async function doLogin(){
  const key = $('#loginKey').value;
  $('#loginErr').style.display='none';
  try{
    await api('/admin/login', { method:'POST', body: JSON.stringify({ key }) });
    $('#loginKey').value=''; showApp(); selectTab('pool');
  }catch(e){ $('#loginErr').textContent='Invalid admin key.'; $('#loginErr').style.display='block'; }
}
$('#loginBtn').addEventListener('click', doLogin);
$('#loginKey').addEventListener('keydown', e => { if (e.key==='Enter') doLogin(); });
$('#logoutBtn').addEventListener('click', async () => { try{ await api('/admin/logout',{method:'POST'}); }catch{} showLogin(); });
for (const b of document.querySelectorAll('nav [data-tab]')) b.addEventListener('click', () => selectTab(b.dataset.tab));
$('#modal').addEventListener('click', e => { if (e.target.id==='modal') closeModal(); });

// ---- boot ----
(async function boot(){
  try{ await api('/admin/session'); showApp(); selectTab('pool'); }
  catch{ showLogin(); }
})();
</script>
</body>
</html>
```

- [ ] **Step 4: Create `src/admin/console-page.ts`**

```ts
import { readFileSync } from 'node:fs';

// Read the self-contained page once at module load. Running Bun directly on the
// TS sources (no build step) means console.html sits beside this file at runtime.
export const CONSOLE_HTML: string = readFileSync(new URL('./console.html', import.meta.url), 'utf8');
```

- [ ] **Step 5: Serve it from `admin-routes.ts`**

Remove the `SHELL` constant (lines 16–17) and its comment on line 29. Add the import near the other imports:

```ts
import { CONSOLE_HTML } from '../admin/console-page';
```

Replace the `GET /admin` handler:

```ts
// self-contained console page (public shell; data endpoints below require the session cookie)
app.get('/admin', (c) => c.html(CONSOLE_HTML));
```

- [ ] **Step 6: Run the smoke test — expect PASS**

Run: `bun test tests/admin-console.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 7: Full gate**

Run: `bun test && bunx tsc --noEmit`
Expected: whole suite green, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/admin/console.html src/admin/console-page.ts src/ingress/admin-routes.ts tests/admin-console.test.ts
git commit -m "feat(admin-ui): self-contained console page — login, session, tab shell + smoke tests"
```

---

## Task 2: Pool tab — accounts table, row actions, add-account form

**Files:**
- Modify: `src/admin/console.html` (replace the `renderPool` stub; may add small helper functions above it)

**Interfaces:**
- Consumes: `api()`, `el()`, `confirmModal()`, `toast()`, `fmtTime`, `cooldownLeft` from Task 1; `GET /admin/accounts`, `POST /admin/accounts`, `PATCH /admin/accounts/:id`, `DELETE /admin/accounts/:id`, `POST /admin/accounts/:id/reset-cooldown`, `GET /admin/models`.
- Produces: a working `renderPool()` (Task 3 does not depend on it).

**Behavioral spec — build this exactly:**

`renderPool()`:
1. `const accounts = await api('/admin/accounts')`.
2. Header row: `<h2>Pool</h2>` + a "＋ Add account" button that toggles the add-account form (below).
3. Table with columns, one row per account:
   - **Name** (`name`) with `provider` under it in `.muted`.
   - **Adapter** (`adapter`).
   - **Models** — each `models[]` entry as `public → target` (join with `<br>` via separate text nodes, or a stacked list; use `el`, not innerHTML).
   - **Status** — a `<span class="badge b-<status>">` showing `state.status` (classes already defined: `b-healthy/b-cooling/b-exhausted/b-disabled/b-unknown`).
   - **Cooldown** — `cooldownLeft(state.cooldownUntil)`.
   - **Errors** — `state.consecutiveErrors`; if `state.lastError`, show it under in `.muted.err` (truncate to ~60 chars, full text in `title`).
   - **Last used** — `fmtTime(state.lastUsedAt)`.
   - **Weight** — `weight`.
   - **Actions** — buttons:
     - Enable/Disable (label depends on `enabled`): `PATCH /admin/accounts/:id {enabled:!enabled}` → on success `toast` + re-`renderPool()`.
     - Reset cooldown: `POST /admin/accounts/:id/reset-cooldown` → toast + refresh.
     - Edit: opens an inline edit form (below).
     - Delete (`class="danger"`): `await confirmModal('Delete account "'+name+'"? This removes its credential and health state.', 'Delete', true)`; if confirmed `DELETE /admin/accounts/:id` → toast + refresh.
4. **Add-account form** (hidden until toggled): inputs `name`, `provider` (default `custom`), `adapter`, `baseUrl`, `models` (a textarea/text input accepting `public:target` pairs, one per line or comma-separated — parse to `[{public,target}]`; a single bare token `m` means `{public:m,target:m}`), `weight` (number, default 1), `key` (password). Submit → `POST /admin/accounts` with that body → on `201` clear+hide form, toast, refresh; on `400` toast the `error`.
5. **Edit form** (per row, opens inline or in the modal): pre-filled `baseUrl`, `models`, `weight`, and an **optional** `key` (blank = leave unchanged; placeholder "leave blank to keep current key"). Submit → `PATCH /admin/accounts/:id` including `key` only when non-empty → toast + refresh.

Model parsing helper (put above `renderPool`):

```js
function parseModels(text){
  return String(text||'').split(/[\n,]/).map(s=>s.trim()).filter(Boolean).map(tok=>{
    const [pub, tgt] = tok.split(':').map(x=>x.trim());
    return { public: pub, target: tgt || pub };
  });
}
function modelsToText(models){ return (models||[]).map(m => m.public===m.target ? m.public : m.public+':'+m.target).join('\n'); }
```

**Steps:**

- [ ] **Step 1: Replace the `renderPool` stub** in `src/admin/console.html` with the full implementation per the spec above (and add `parseModels`/`modelsToText` above it). Use `el()` for all DOM construction; never assign `innerHTML` from account data (only from static strings, if at all — prefer `el`). Re-render by calling `renderPool()` (clear `#view` first: `$('#view').textContent=''`).

- [ ] **Step 2: Regression + type gate**

Run: `bun test && bunx tsc --noEmit`
Expected: existing suite still green (Task-1 structural test still passes since the page still contains all tab labels and endpoint paths), tsc clean.
> No new unit test — interactive Pool behavior is verified in the branch-end live browser walkthrough. Do not add a fake DOM test.

- [ ] **Step 3: Commit**

```bash
git add src/admin/console.html
git commit -m "feat(admin-ui): Pool tab — accounts table, status badges, row actions, add/edit forms"
```

---

## Task 3: Logs, Stats, and Keys tabs

**Files:**
- Modify: `src/admin/console.html` (replace `renderLogs`, `renderStats`, `renderKeys` stubs)

**Interfaces:**
- Consumes: `api()`, `el()`, `confirmModal()`, `showModal()`, `closeModal()`, `toast()`, `fmtTime`, `fmtCost`, `fmtNum` from Task 1; `GET /admin/logs`, `GET /admin/stats`, `GET /admin/gateway-keys`, `POST /admin/gateway-keys`, `DELETE /admin/gateway-keys/:id`.
- Produces: working `renderLogs/renderStats/renderKeys`.

**Behavioral spec:**

`renderLogs()`:
1. Filter row: text inputs `model`, `account`, `status` (a `<select>` with options `''`/`ok`/`error`), `limit` (number, default 100), and an "Apply" button + "Refresh".
2. Build query string from non-empty filters → `GET /admin/logs?…` → table, one row per log:
   `fmtTime(ts)` · `public_model` · `account_id` · `status` (badge: `ok`→`b-healthy`, `error`→`b-exhausted`) · `http_status` · `latency_ms`+'ms' · `attempt_count` · `total_tokens` · `fmtCost(est_cost)`. Null cells render `—`.
3. Wrap the table in `<div class="wrap">` for horizontal scroll.

`renderStats()`:
1. A window `<select>`: options "Last hour" (3600e3), "Last 24h" (86400e3), "Last 7d" (7*86400e3), "All time" (→ `sinceMs=0`). On change, recompute `sinceMs = value===0 ? 0 : Date.now()-value` and re-fetch.
2. `GET /admin/stats?sinceMs=…` → four `.card`s: Total requests (`totalRequests`), Error rate (`(errorRate*100).toFixed(1)+'%'`), Tokens (`fmtNum(totalTokens)`), Est. cost (`fmtCost(totalCost)`).
3. Two tables: **By model** (`byModel`) and **By account** (`byAccount`), columns: key · requests · errors · tokens · `fmtCost(cost)`.

`renderKeys()`:
1. `GET /admin/gateway-keys` → table: `name` (or `—`) · `keyHashPrefix`+'…' (`.mono`) · enabled (badge) · `fmtTime(createdAt)` · Actions: Revoke (`class="danger"`, `confirmModal('Revoke key "'+(name||prefix)+'"? Clients using it stop working immediately.','Revoke',true)` → `DELETE /admin/gateway-keys/:id` → toast + refresh).
2. "＋ New key" button → prompt for a name via a small modal form (name input + Create) → `POST /admin/gateway-keys {name}` → **show the raw `key` once** in the modal: a read-only `.mono` field with the value, a "Copy" button (`navigator.clipboard.writeText`), and a warning "This is shown once — store it now." A "Done" button closes the modal and refreshes the list. The raw key must never be written anywhere else in the DOM and must not survive `closeModal()`.

**Steps:**

- [ ] **Step 1: Replace the three stubs** (`renderLogs`, `renderStats`, `renderKeys`) in `src/admin/console.html` per the spec above. `el()` for all DOM; `<div class="wrap">` around wide tables. For the "new key" flow, build the modal node with `el()` and pass to `showModal()`.

- [ ] **Step 2: Regression + type gate**

Run: `bun test && bunx tsc --noEmit`
Expected: suite green, tsc clean. The Task-1 structural test still passes.
> Interactive behavior verified in the branch-end live browser walkthrough.

- [ ] **Step 3: Commit**

```bash
git add src/admin/console.html
git commit -m "feat(admin-ui): Logs, Stats, and Keys tabs (show-key-once modal)"
```

---

## Branch-end verification (controller-run, after Task 3 review is clean)

Not a subagent task — the controller performs this before the final whole-branch review:

1. `bun test && bunx tsc --noEmit` — full gate.
2. **Live browser walkthrough** with claude-in-chrome: launch the server with a known `ADMIN_KEY`/`GATEWAY_KEY`/`MASTER_KEY` and a seeded/temp DB, open `http://127.0.0.1:<port>/admin` (set `ADMIN_INSECURE_COOKIE=1` so the cookie works over http), then: sign in with the key; confirm the Pool tab lists accounts with status badges; add an account and see it appear; toggle enable/disable and reset-cooldown; open Logs and Stats (empty is fine — verify they render, not error); create a gateway key and confirm the raw value shows once, then revoke it; sign out and confirm the login view returns. Capture a short GIF.
3. Dispatch the final whole-branch review (superpowers:requesting-code-review) over the whole Phase 3b range, then finish via superpowers:finishing-a-development-branch (merge to `main`, delete branch).

---

## Deferred (unchanged from spec §10)

Playwright/browser e2e in CI; test playground; per-key usage attribution; prefix-derived stickiness; RBAC/multi-admin/audit; CSRF header token. Carried minor items from earlier slices remain fix-in-next-slice.
