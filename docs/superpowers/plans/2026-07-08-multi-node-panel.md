# 多节点终端 + 启动面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把新 RackNerd 机器纳入终端环境（`term2.doge-liang-space.uk`），并在 Cloudflare 上上线一个启动面板（`panel.doge-liang-space.uk`）用于列出/添加/选择节点。

**Architecture:** 每节点独立跑现有 term 栈 + 各自 cloudflared tunnel + Access app；面板是一个 Cloudflare Worker，静态 UI + KV 注册表 API，前置 Access。

**Tech Stack:** Node.js 20 + node-pty + tmux（节点）；cloudflared token 化 tunnel；Cloudflare Worker + KV（面板）；Cloudflare API（经 MCP `mcp__cloudflare-api__execute`）；`npx wrangler` 部署 Worker。

## Global Constraints

- Account ID：`e1a26cb74d481a82acb1fd2d66f9c547`（MCP 里 `accountId` 已预置）。
- Zone `doge-liang-space.uk` ID：`333be29e7309f822a61b3af33260e47e`。
- Access 团队域：`doge-liang.cloudflareaccess.com`。
- 白名单（owner-only 策略 include，4 条 email）：`liangsycmail@gmail.com`、`1542640147@qq.com`、`moyong06@foxmail.com`、`2224285922@qq.com`。
- 现有 term Access app：id `81c8bdd1-bee6-4d3a-9065-eb295066828e`，AUD `75f7fee95631de296b65a5d45dcb75d1711b7f5ebdb2981630e556c74891fb15`（供参考，勿复用；每 app 有独立 AUD）。
- term server 监听 `127.0.0.1:7681`；所需环境变量：`CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`、`MAIN_HOST`、`HOST`。
- Node 20.x；node-pty 原生编译需 `build-essential python3`。
- tunnel 一律 token 化 / 远程托管 ingress（`config_src=cloudflare`），用 `cloudflared service install <TOKEN>`。
- term systemd 单元 `KillMode=process`（保护已 daemon 化的 tmux server）。
- **秘密处理**：tunnel token、Access AUD、tunnel 凭据只写到目标机 `/etc/` 或本控制机 `$CLAUDE_JOB_DIR/tmp`，绝不入 git、不进 KV、不在共享输出打印完整明文。
- SSH：新节点别名 `racknerd-13d12ee`（已配免密，本任务前置完成）。

---

## Phase 1 — 节点上线（term2）

### Task 1: term2 的 Cloudflare 控制面（tunnel + DNS + ingress + Access app）

**Files:**
- Create: `$CLAUDE_JOB_DIR/tmp/term2-secrets.env`（本地临时，非仓库；存 TUNNEL_TOKEN 与 AUD）

**Interfaces:**
- Produces：`TERM2_TUNNEL_TOKEN`（cloudflared 用）、`TERM2_AUD`（写入节点 env）、`TERM2_TUNNEL_ID`。

- [ ] **Step 1: 创建 tunnel 并取 token**

用 MCP `mcp__cloudflare-api__execute` 运行：

```js
async () => {
  // 生成 tunnel（config_src=cloudflare 即远程托管 ingress）
  const t = await cloudflare.request({ method: "POST",
    path: `/accounts/${accountId}/cfd_tunnel`,
    body: { name: "term2", config_src: "cloudflare" } });
  const id = t.result.id;
  const tok = await cloudflare.request({ method: "GET",
    path: `/accounts/${accountId}/cfd_tunnel/${id}/token` });
  return { id, token: tok.result };
}
```

Expected：`success:true`，返回 `{ id, token }`（token 是长 base64 串）。把 id、token 记到 `$CLAUDE_JOB_DIR/tmp/term2-secrets.env`（`TERM2_TUNNEL_ID=...`、`TERM2_TUNNEL_TOKEN=...`）。

- [ ] **Step 2: 配置 tunnel ingress（term2 → localhost:7681）**

```js
async () => {
  const id = "<TERM2_TUNNEL_ID>";
  return cloudflare.request({ method: "PUT",
    path: `/accounts/${accountId}/cfd_tunnel/${id}/configurations`,
    body: { config: { ingress: [
      { hostname: "term2.doge-liang-space.uk", service: "http://localhost:7681" },
      { service: "http_status:404" }
    ] } } });
}
```

Expected：`success:true`。

- [ ] **Step 3: 建 DNS CNAME term2 → <id>.cfargotunnel.com（proxied）**

```js
async () => {
  const zone = "333be29e7309f822a61b3af33260e47e";
  const id = "<TERM2_TUNNEL_ID>";
  return cloudflare.request({ method: "POST", path: `/zones/${zone}/dns_records`,
    body: { type: "CNAME", name: "term2", content: `${id}.cfargotunnel.com`, proxied: true } });
}
```

Expected：`success:true`，`result.name = "term2.doge-liang-space.uk"`。

- [ ] **Step 4: 建 term2 的 Access application + owner-only 策略**

```js
async () => {
  const app = await cloudflare.request({ method: "POST",
    path: `/accounts/${accountId}/access/apps`,
    body: { name: "mobile-terminal-2", domain: "term2.doge-liang-space.uk",
      type: "self_hosted", session_duration: "24h" } });
  const appId = app.result.id, aud = app.result.aud;
  const emails = ["liangsycmail@gmail.com","1542640147@qq.com","moyong06@foxmail.com","2224285922@qq.com"];
  const pol = await cloudflare.request({ method: "POST",
    path: `/accounts/${accountId}/access/apps/${appId}/policies`,
    body: { name: "owner-only", decision: "allow",
      include: emails.map(e => ({ email: { email: e } })) } });
  return { appId, aud, policy: pol.result?.id, ok: pol.success };
}
```

Expected：`success/ok:true`。把 `aud` 记到 `term2-secrets.env`（`TERM2_AUD=...`）。

- [ ] **Step 5: 校验控制面就绪**

```bash
curl -sI https://term2.doge-liang-space.uk | head -5
```

Expected：`HTTP/2 302`（跳 Access 登录）—— 此刻源站还没起，302 来自 Access 边缘即证明 DNS/Access 已生效。若 `530/1016` 说明 DNS 未传播，稍等重试。

---

### Task 2: `scripts/provision-node.sh` 远端主机上线脚本

**Files:**
- Create: `scripts/provision-node.sh`

**Interfaces:**
- Consumes：位置参数 `SSH_HOST MAIN_HOST`；环境变量 `TUNNEL_TOKEN ACCESS_AUD`（从 `term2-secrets.env` 注入）。
- Produces：目标机上 `mobile-terminal.service` + cloudflared 服务运行。

- [ ] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
# 在新机器上一键起 mobile-terminal 栈 + token 化 cloudflared tunnel。
# 用法: TUNNEL_TOKEN=... ACCESS_AUD=... ./scripts/provision-node.sh <ssh-host> <main-host>
#   <ssh-host>  已在 ~/.ssh/config 配好免密的别名，如 racknerd-13d12ee
#   <main-host> 对外域名，如 term2.doge-liang-space.uk
set -euo pipefail

SSH_HOST="${1:?need ssh host}"
MAIN_HOST="${2:?need main host}"
: "${TUNNEL_TOKEN:?need TUNNEL_TOKEN}"
: "${ACCESS_AUD:?need ACCESS_AUD}"
TEAM_DOMAIN="doge-liang.cloudflareaccess.com"
REPO="https://github.com/doge-liang/mobile-terminal-web"
DIR="/root/mobile-terminal-web"

echo "[1/6] 装系统依赖 (build-essential python3 tmux git ca-certificates)"
ssh "$SSH_HOST" 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && \
  apt-get install -y -qq build-essential python3 tmux git ca-certificates curl'

echo "[2/6] 装 Node.js 20 (NodeSource)"
ssh "$SSH_HOST" 'command -v node >/dev/null && node -v | grep -q "^v20" || { \
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs; }; node -v'

echo "[3/6] 装 cloudflared (.deb)"
ssh "$SSH_HOST" 'command -v cloudflared >/dev/null || { \
  curl -fsSL -o /tmp/cfd.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && \
  dpkg -i /tmp/cfd.deb; }; cloudflared --version'

echo "[4/6] 拉仓库 + npm ci (编译 node-pty)"
ssh "$SSH_HOST" "test -d $DIR/.git || git clone --depth 1 $REPO $DIR; \
  cd $DIR && git pull --ff-only && npm ci --no-audit --no-fund"

echo "[5/6] 写 env + 装 mobile-terminal.service"
ssh "$SSH_HOST" "cat > /etc/default/mobile-terminal <<EOF
CF_ACCESS_TEAM_DOMAIN=$TEAM_DOMAIN
CF_ACCESS_AUD=$ACCESS_AUD
MAIN_HOST=$MAIN_HOST
HOST=127.0.0.1
EOF
cat > /etc/systemd/system/mobile-terminal.service <<'UNIT'
[Unit]
Description=mobile-terminal-web (xterm.js + node-pty + tmux)
After=network.target
[Service]
Type=simple
WorkingDirectory=/root/mobile-terminal-web
EnvironmentFile=-/etc/default/mobile-terminal
ExecStart=/usr/bin/node /root/mobile-terminal-web/server.js
Restart=always
RestartSec=3
KillMode=process
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now mobile-terminal.service"

echo "[6/6] 装 token 化 cloudflared 服务"
ssh "$SSH_HOST" "cloudflared service install $TUNNEL_TOKEN"

echo "完成。校验:"
sleep 5
curl -sI "https://$MAIN_HOST" | head -3 || true
echo "→ 期望 302（Access 登录页）。请在浏览器打开 https://$MAIN_HOST 走一次 OTP 确认终端可连。"
```

- [ ] **Step 2: 语法检查**

Run: `bash -n scripts/provision-node.sh && chmod +x scripts/provision-node.sh && echo OK`
Expected：`OK`。

- [ ] **Step 3: Commit**

```bash
export HOME=/root; cd /root/mobile-terminal-web
git add scripts/provision-node.sh
git commit -m "feat: provision-node.sh — one-shot node bring-up (term stack + tunnel)"
```

---

### Task 3: 用脚本把 racknerd-13d12ee 上线为 term2

**Files:** 无（运行时操作）

- [ ] **Step 1: 运行 provision**

```bash
export HOME=/root; cd /root/mobile-terminal-web
set -a; . "$CLAUDE_JOB_DIR/tmp/term2-secrets.env"; set +a
TUNNEL_TOKEN="$TERM2_TUNNEL_TOKEN" ACCESS_AUD="$TERM2_AUD" \
  ./scripts/provision-node.sh racknerd-13d12ee term2.doge-liang-space.uk
```

Expected：6 步全过；末尾 `curl -sI` 打印 `HTTP/2 302`。

- [ ] **Step 2: 校验源站已被 tunnel 接上**

```bash
ssh racknerd-13d12ee 'systemctl is-active mobile-terminal cloudflared; ss -ltnp | grep 7681'
```

Expected：两个服务 `active`；7681 有 node 在听。

- [ ] **Step 3: 人工浏览器验收**

打开 `https://term2.doge-liang-space.uk` → 走 OTP → 终端应可连、能 `tmux` 开会话、复制粘贴/铃声正常（复用现有前端）。把结论回报，未过则回到失败步排查。

---

## Phase 2 — 启动面板（panel）

### Task 4: 面板 KV + Worker 骨架（静态 UI + GET /api/nodes）

**Files:**
- Create: `panel/wrangler.toml`
- Create: `panel/src/worker.js`
- Create: `panel/public/index.html`

**Interfaces:**
- Produces：Worker 路由 `GET /api/nodes` → `{nodes:[...]}`；静态资源经 `[assets]` 提供。KV 绑定名 `NODES`，单键 `nodes`。

- [ ] **Step 1: 建 KV namespace**

MCP 运行：

```js
async () => cloudflare.request({ method: "POST",
  path: `/accounts/${accountId}/storage/kv/namespaces`,
  body: { title: "panel-nodes" } });
```

Expected：`success:true`，记下 `result.id`（KV namespace id）。

- [ ] **Step 2: 写 `panel/wrangler.toml`**

```toml
name = "panel"
main = "src/worker.js"
compatibility_date = "2024-11-01"
workers_dev = false            # 关闭 workers.dev，杜绝绕过 Access 的直连

[assets]
directory = "public"
binding = "ASSETS"

[[kv_namespaces]]
binding = "NODES"
id = "<KV_NAMESPACE_ID>"       # 填 Step 1 的 id

[[routes]]
pattern = "panel.doge-liang-space.uk"
custom_domain = true
```

- [ ] **Step 3: 写 `panel/src/worker.js`（先只做 GET + 种子 + 静态兜底）**

```js
const TEAM_DOMAIN = "doge-liang.cloudflareaccess.com";
const PANEL_AUD = ""; // Task 7 填 panel Access app 的 AUD
const ZONE_SUFFIX = ".doge-liang-space.uk";

const SEED = [
  { id: "self", name: "本机", url: "https://term.doge-liang-space.uk", note: "racknerd-7d0b8fb", addedAt: 0 },
  { id: "term2", name: "RackNerd-8G", url: "https://term2.doge-liang-space.uk", note: "racknerd-13d12ee", addedAt: 0 },
];

async function loadNodes(env) {
  const raw = await env.NODES.get("nodes");
  if (raw) return JSON.parse(raw);
  await env.NODES.put("nodes", JSON.stringify(SEED));
  return SEED;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/nodes" && request.method === "GET") {
      return json({ nodes: await loadNodes(env) });
    }
    return env.ASSETS.fetch(request); // 静态资源（index.html 等）
  },
};
```

- [ ] **Step 4: 写 `panel/public/index.html`（占位骨架，Task 6 补全 UI）**

```html
<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>节点面板</title></head>
<body><h1>节点面板</h1><div id="list">加载中…</div>
<script>
fetch("/api/nodes").then(r=>r.json()).then(d=>{
  document.getElementById("list").textContent = JSON.stringify(d.nodes);
});
</script></body></html>
```

- [ ] **Step 5: 本地干跑校验（不部署）**

Run: `cd panel && npx wrangler deploy --dry-run 2>&1 | tail -5`
Expected：打包成功，无致命错误（可有 workers_dev/route 提示）。

- [ ] **Step 6: Commit**

```bash
export HOME=/root; cd /root/mobile-terminal-web
git add panel/wrangler.toml panel/src/worker.js panel/public/index.html
git commit -m "feat: panel worker skeleton — KV registry GET + static assets"
```

---

### Task 5: 面板 API 写操作（POST / DELETE）+ 校验 + Access JWT 验签

**Files:**
- Modify: `panel/src/worker.js`

**Interfaces:**
- Consumes：`loadNodes(env)`、`json()`、`SEED`（Task 4）。
- Produces：`POST /api/nodes {name,url,note?}`、`DELETE /api/nodes/:id`；`verifyAccess(request)` 守卫。

- [ ] **Step 1: 加 URL 校验 + 写操作 + Access 验签，替换 worker.js**

```js
const TEAM_DOMAIN = "doge-liang.cloudflareaccess.com";
const PANEL_AUD = ""; // Task 7 填
const ZONE_SUFFIX = ".doge-liang-space.uk";

const SEED = [
  { id: "self", name: "本机", url: "https://term.doge-liang-space.uk", note: "racknerd-7d0b8fb", addedAt: 0 },
  { id: "term2", name: "RackNerd-8G", url: "https://term2.doge-liang-space.uk", note: "racknerd-13d12ee", addedAt: 0 },
];

async function loadNodes(env) {
  const raw = await env.NODES.get("nodes");
  if (raw) return JSON.parse(raw);
  await env.NODES.put("nodes", JSON.stringify(SEED));
  return SEED;
}
const saveNodes = (env, nodes) => env.NODES.put("nodes", JSON.stringify(nodes));
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// 只允许 https 且属本 zone 的域名，防乱填
function validUrl(u) {
  try { const x = new URL(u);
    return x.protocol === "https:" && x.hostname.endsWith(ZONE_SUFFIX); }
  catch { return false; }
}

// --- Access JWT 验签（纵深防御；主闸是 workers_dev=false + 自定义域挂 Access） ---
let JWKS = null;
async function getJwks() {
  if (JWKS) return JWKS;
  const r = await fetch(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  JWKS = (await r.json()).keys;
  return JWKS;
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function verifyAccess(request) {
  if (!PANEL_AUD) return true; // Task 7 之前先放行，便于本地调试
  const tok = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!tok) return false;
  const [h, p, s] = tok.split(".");
  if (!h || !p || !s) return false;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))); } catch { return false; }
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(PANEL_AUD)) return false;
  if (payload.exp && Date.now() / 1000 > payload.exp) return false;
  const kid = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))).kid;
  const jwk = (await getJwks()).find(k => k.kid === kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
    b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
}

// id 生成：无 Math.random 依赖时用时间+计数不适用于 Worker，这里用 crypto.randomUUID
const newId = () => crypto.randomUUID().slice(0, 8);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!(await verifyAccess(request))) return json({ error: "forbidden" }, 403);
    }
    if (url.pathname === "/api/nodes" && request.method === "GET") {
      return json({ nodes: await loadNodes(env) });
    }
    if (url.pathname === "/api/nodes" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const name = String(body.name || "").trim().slice(0, 40);
      const nodeUrl = String(body.url || "").trim();
      const note = String(body.note || "").trim().slice(0, 60);
      if (!name) return json({ error: "name required" }, 400);
      if (!validUrl(nodeUrl)) return json({ error: "url must be https and under " + ZONE_SUFFIX }, 400);
      const nodes = await loadNodes(env);
      nodes.push({ id: newId(), name, url: nodeUrl, note, addedAt: Date.now() });
      await saveNodes(env, nodes);
      return json({ nodes });
    }
    const del = url.pathname.match(/^\/api\/nodes\/([\w-]+)$/);
    if (del && request.method === "DELETE") {
      const id = del[1];
      if (id === "self") return json({ error: "cannot delete self" }, 400);
      const nodes = (await loadNodes(env)).filter(n => n.id !== id);
      await saveNodes(env, nodes);
      return json({ nodes });
    }
    return env.ASSETS.fetch(request);
  },
};
```

- [ ] **Step 2: 干跑校验**

Run: `cd panel && npx wrangler deploy --dry-run 2>&1 | tail -5`
Expected：打包成功。

- [ ] **Step 3: Commit**

```bash
export HOME=/root; cd /root/mobile-terminal-web
git add panel/src/worker.js
git commit -m "feat: panel API — add/delete nodes, url validation, Access JWT verify"
```

---

### Task 6: 面板 UI（移动优先，复用 term 深色主题）

**Files:**
- Modify: `panel/public/index.html`

- [ ] **Step 1: 写完整 UI**

```html
<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<title>节点面板</title>
<style>
  :root{--bg:#0d1117;--bar:#161b22;--border:#30363d;--fg:#c9d1d9;--accent:#58a6ff}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,"Segoe UI",Roboto,ui-monospace,monospace;
    padding:max(16px,env(safe-area-inset-top)) 16px 24px;max-width:640px;margin:0 auto}
  h1{font-size:18px;margin-bottom:16px}
  .card{display:flex;align-items:center;gap:10px;background:var(--bar);border:1px solid var(--border);
    border-radius:12px;padding:12px 14px;margin-bottom:10px}
  .card .meta{flex:1;min-width:0}
  .card .name{font-weight:600}
  .card .host{color:#8b949e;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .card .note{color:#6e7681;font-size:11px}
  .open{background:var(--accent);color:#0d1117;border:none;border-radius:8px;padding:8px 14px;
    font:inherit;font-weight:600;text-decoration:none}
  .del{background:transparent;border:1px solid var(--border);color:#8b949e;border-radius:8px;
    padding:8px 10px;font:inherit}
  .del:active{color:#f85149;border-color:#f85149}
  form{display:flex;flex-direction:column;gap:8px;background:var(--bar);border:1px solid var(--border);
    border-radius:12px;padding:14px;margin-top:16px}
  input{background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--fg);
    padding:9px 12px;font:inherit}
  input:focus{outline:none;border-color:var(--accent)}
  button.add{background:var(--accent);color:#0d1117;border:none;border-radius:8px;padding:9px;
    font:inherit;font-weight:600}
  .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--bar);
    border:1px solid var(--border);border-radius:8px;padding:8px 16px;font-size:13px;opacity:0;
    transition:opacity .2s;pointer-events:none}
  .toast.show{opacity:1}
</style></head>
<body>
<h1>节点面板</h1>
<div id="list"></div>
<form id="add">
  <input id="f-name" placeholder="名称，如 RackNerd-8G" maxlength="40" autocomplete="off">
  <input id="f-url" placeholder="https://termN.doge-liang-space.uk" inputmode="url" autocomplete="off">
  <input id="f-note" placeholder="备注（可选）" maxlength="60" autocomplete="off">
  <button class="add" type="submit">添加节点</button>
</form>
<div class="toast" id="toast"></div>
<script>
const listEl = document.getElementById("list");
const toastEl = document.getElementById("toast");
function toast(msg){ toastEl.textContent = msg; toastEl.classList.add("show");
  setTimeout(()=>toastEl.classList.remove("show"), 1800); }
function host(u){ try{ return new URL(u).host; }catch{ return u; } }
function render(nodes){
  listEl.innerHTML = "";
  for (const n of nodes){
    const card = document.createElement("div"); card.className = "card";
    const meta = document.createElement("div"); meta.className = "meta";
    meta.innerHTML = `<div class="name"></div><div class="host"></div><div class="note"></div>`;
    meta.querySelector(".name").textContent = n.name;
    meta.querySelector(".host").textContent = host(n.url);
    meta.querySelector(".note").textContent = n.note || "";
    const open = document.createElement("a"); open.className = "open"; open.textContent = "打开";
    open.href = n.url; open.target = "_blank"; open.rel = "noopener";
    card.append(meta, open);
    if (n.id !== "self"){
      const del = document.createElement("button"); del.className = "del"; del.textContent = "✕";
      del.onclick = async () => {
        if (!confirm(`删除节点「${n.name}」？`)) return;
        const r = await fetch(`/api/nodes/${n.id}`, { method: "DELETE" });
        const d = await r.json();
        if (r.ok){ render(d.nodes); toast("已删除"); } else toast(d.error || "删除失败");
      };
      card.append(del);
    }
    listEl.append(card);
  }
}
async function load(){ const r = await fetch("/api/nodes"); render((await r.json()).nodes); }
document.getElementById("add").onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById("f-name").value.trim();
  const url = document.getElementById("f-url").value.trim();
  const note = document.getElementById("f-note").value.trim();
  const r = await fetch("/api/nodes", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ name, url, note }) });
  const d = await r.json();
  if (r.ok){ render(d.nodes); e.target.reset(); toast("已添加"); } else toast(d.error || "添加失败");
};
load();
</script></body></html>
```

- [ ] **Step 2: Commit**

```bash
export HOME=/root; cd /root/mobile-terminal-web
git add panel/public/index.html
git commit -m "feat: panel UI — node cards, open/delete, add form (term dark theme)"
```

---

### Task 7: 部署面板 + 自定义域 + Access + 端到端验收

**Files:**
- Modify: `panel/src/worker.js`（填 PANEL_AUD）

- [ ] **Step 1: 首次部署 Worker（自定义域会自动建路由）**

```bash
export HOME=/root; cd /root/mobile-terminal-web/panel
npx wrangler deploy 2>&1 | tail -15
```

Expected：部署成功，输出含 `panel.doge-liang-space.uk` 自定义域已配置。若自定义域首次需 DNS，wrangler 会自动建记录。

- [ ] **Step 2: 建 panel 的 Access application + owner-only 策略**

MCP 运行（结构同 Task 1 Step 4，domain 换成 panel）：

```js
async () => {
  const app = await cloudflare.request({ method: "POST",
    path: `/accounts/${accountId}/access/apps`,
    body: { name: "panel", domain: "panel.doge-liang-space.uk",
      type: "self_hosted", session_duration: "24h" } });
  const appId = app.result.id, aud = app.result.aud;
  const emails = ["liangsycmail@gmail.com","1542640147@qq.com","moyong06@foxmail.com","2224285922@qq.com"];
  const pol = await cloudflare.request({ method: "POST",
    path: `/accounts/${accountId}/access/apps/${appId}/policies`,
    body: { name: "owner-only", decision: "allow",
      include: emails.map(e => ({ email: { email: e } })) } });
  return { appId, aud, ok: pol.success };
}
```

Expected：`ok:true`，记下 `aud`。

- [ ] **Step 3: 填 PANEL_AUD 并重部署**

把 Step 2 的 `aud` 填入 `panel/src/worker.js` 的 `const PANEL_AUD = "...";`，然后：

```bash
export HOME=/root; cd /root/mobile-terminal-web/panel
npx wrangler deploy 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
export HOME=/root; cd /root/mobile-terminal-web
git add panel/src/worker.js
git commit -m "feat: panel — bind Access AUD, deploy to panel.doge-liang-space.uk"
```

- [ ] **Step 5: 端到端验收**

- `curl -sI https://panel.doge-liang-space.uk` → 期望 `302`（Access 登录）。
- 浏览器打开 `panel.doge-liang-space.uk` → 走 OTP → 见「本机」「RackNerd-8G」两卡。
- 「打开」跳对应 term 域名；「添加节点」加一条非法 url（http 或外域）应被拒；加一条 `https://…doge-liang-space.uk` 应成功且刷新仍在（KV 持久化）；「删除」移除，本机卡无删除键。
- 直连 workers.dev（若存在）应 404/不可达（`workers_dev=false`）。

---

## 交付顺序
Phase 1（Task 1→3）先行，term2 上线并人工验收；再做 Phase 2（Task 4→7）面板。
