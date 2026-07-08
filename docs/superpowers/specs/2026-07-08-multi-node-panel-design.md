# 多节点终端 + 启动面板 设计

日期：2026-07-08
状态：待实现

## 1. 背景与目标

现状：单台机器（racknerd-7d0b8fb）跑 `server.js`（node-pty + tmux），监听
`127.0.0.1:7681`，经本机 cloudflared tunnel 暴露为 `term.doge-liang-space.uk`，
前置 Cloudflare Access OTP（4 邮箱白名单）。

目标：把新上线的 RackNerd 机器（`racknerd-13d12ee`，192.255.136.151，
Ubuntu 24.04，7 vCPU / 7.8 GiB）纳入同一套移动终端开发环境，并在 Cloudflare
上上线一个**启动面板**，能列出节点、添加节点、选择节点连接。

非目标：
- 不做中心服务 SSH 代理（已决策为「每节点独立部署」）。
- 面板不负责在新机器上自动 provision（provision 由脚本完成，面板只登记条目）。
- 不改动现有 term 的复制粘贴 / 会话 / 铃声等功能。

## 2. 架构总览

三个相互独立的单元：

```
                 Cloudflare Access (同一 4 邮箱白名单 / OTP)
                              │
   ┌──────────────────────────┼───────────────────────────┐
   │                          │                           │
panel.doge-liang-space.uk   term.doge-liang-space.uk    term2.doge-liang-space.uk
(Worker + KV 注册表)         (本机 racknerd-7d0b8fb)       (新 RackNerd racknerd-13d12ee)
   │                          │                           │
 列出/加/删节点              server.js:7681               server.js:7681
 点击 → 打开对应域名          本机 cloudflared tunnel        新机 cloudflared tunnel
```

关键约束：cloudflared tunnel 是**出站**连接，必须在目标机器本地运行才能到达该机
的 `localhost:7681`。因此**每个节点一个 tunnel、一个域名、一个 Access application**。

## 3. 单元一：节点部署（先做）

### 3.1 目标产物
新 RackNerd 机器上线为 `term2.doge-liang-space.uk`，功能与本机 term 完全一致。

### 3.2 provision 脚本 `scripts/provision-node.sh`
在**本控制机**运行，通过已配置的 SSH 免密登录目标机，完成：

1. 远端装依赖：`build-essential python3`（node-pty 原生编译需要）、Node.js 20.x
   （NodeSource）、`tmux`（已有）、`cloudflared`（官方 .deb）。
2. 拉仓库：`git clone https://github.com/doge-liang/mobile-terminal-web` 到
   `/root/mobile-terminal-web`，`npm ci`（触发 node-pty 编译）。
3. 通过 Cloudflare API（MCP `mcp__cloudflare-api__execute`）创建：
   - 一个新的 **named tunnel**（如 `term2`），取回 tunnel ID 与凭据 JSON。
   - **DNS CNAME** `term2 → <tunnelID>.cfargotunnel.com`（proxied）。
   - tunnel **ingress** 配置：`term2.doge-liang-space.uk → http://localhost:7681`，
     兜底 `http_status:404`。
   - 一个 **Access application**（域名 `term2.doge-liang-space.uk`），策略复用
     现有 4 邮箱白名单，取回该 app 的 **AUD**。
4. 远端写 `/etc/cloudflared/config.yml` + 凭据文件，装 `cloudflared.service`。
5. 远端写 `/etc/default/mobile-terminal`：
   - `CF_ACCESS_TEAM_DOMAIN`＝共享团队域（与本机相同）
   - `CF_ACCESS_AUD`＝**该节点 Access app 的 AUD**（每节点不同）
   - `MAIN_HOST=term2.doge-liang-space.uk`
   - `HOST=127.0.0.1`
   - `FAST_HOST` 留空（快速通道是本机优化项，新节点暂不启用）
6. 远端装 `mobile-terminal.service`（复制本机单元，`KillMode=process`），
   `systemctl enable --now` 两个服务。
7. 校验：脚本 `curl -I https://term2.doge-liang-space.uk`（预期 302 → Access 登录）。

脚本要求幂等、可重跑；每步打印结果；失败即停并报错。密钥/凭据不落仓库。

### 3.3 手动收尾
- provision 完成后，人工在浏览器打开 `term2.doge-liang-space.uk`，走一次 OTP，
  确认终端可连、tmux 可用。

## 4. 单元二：启动面板（后做）

### 4.1 形态
Cloudflare **Worker**（用 `npx wrangler` 部署），单 Worker 同时：
- 提供静态 UI（HTML/CSS/JS，内嵌或用 Workers 静态资源）。
- 提供注册表 API，数据存 **KV**。

绑定自定义域 `panel.doge-liang-space.uk`；**关闭 workers.dev 路由**避免直连绕过。
前置 Cloudflare Access（同一白名单）。

### 4.2 数据模型（KV）
KV namespace（如 `NODES`），单键 `nodes` 存 JSON 数组：

```json
[
  { "id": "self", "name": "本机", "url": "https://term.doge-liang-space.uk",
    "note": "racknerd-7d0b8fb", "addedAt": 0 },
  { "id": "<rand>", "name": "RackNerd-8G", "url": "https://term2.doge-liang-space.uk",
    "note": "racknerd-13d12ee", "addedAt": <ts> }
]
```

首次读取若 KV 为空，写入种子（本机 + term2 两条）。

### 4.3 API
- `GET  /api/nodes` → `{ nodes: [...] }`
- `POST /api/nodes` body `{ name, url, note? }` → 校验 url 为 https 且属
  `*.doge-liang-space.uk`（防乱填），生成 id，追加，返回全表。
- `DELETE /api/nodes/:id` → 删除该条。`self`（本机种子）禁删，请求返回 400。

写操作对 KV 单键做读-改-写；节点数量小（个位数），无并发压力。

### 4.4 鉴权（纵深防御）
- 边缘：Access 保护 `panel.doge-liang-space.uk` 自定义域；关 workers.dev。
- Worker 内：校验 `Cf-Access-Jwt-Assertion` 头的 **AUD** 与**签名**（拉团队
  `/cdn-cgi/access/certs` 公钥验签），失败返回 403。与 server.js 现有 jose
  校验思路一致，防止有人绕过 Access 直击 Worker 后端。

### 4.5 UI（移动优先，复用 term 深色主题）
- 主题令牌与 term 一致：`--bg #0d1117 / --bar #161b22 / --border #30363d /
  --fg #c9d1d9 / --accent #58a6ff`；字体沿用系统等宽即可（面板不必打包 woff2）。
- 布局：顶部标题「节点」；节点卡片列表，每卡显示名称、域名 host、
  「打开」按钮（`target=_blank` 打开该节点域名）、删除 ✕（二次确认）；
  底部「+ 添加节点」表单（名称 + url + 可选备注 →「添加」）。
- 加/删后就地刷新列表；操作反馈用轻量 toast。

## 5. 单元三：命名与扩展约定
- 域名：本机 `term`，新节点顺延 `term2 / term3 / …`（或 `term-<label>`）。
- 每新增节点＝跑一次 `provision-node.sh <ssh-host> <hostname>`，然后在面板
  「添加节点」登记一条。两步。
- SSH：新节点先加入 `~/.ssh/config`（本任务已为 racknerd-13d12ee 完成）。

## 6. 安全考量
- **攻击面放大**：每个 `termN` 域名都是一台机器的完整 root shell，由同一套
  4 邮箱白名单守卫。每加一个节点，每个白名单邮箱可达的机器就多一台。
- **家庭 TLS-MITM 网关**：用户家网有第三方根 CA 的解密网关，可解密所有终端
  流量——此风险与单节点时相同，不因多节点改变，但节点越多暴露面越大。
- **KV 内容**：只存域名/名称/备注，无任何密钥或凭据。
- **凭据处理**：tunnel 凭据 JSON、Access AUD 只写到目标机 `/etc/`，不入仓库、
  不进 KV、不打印明文到共享日志。

## 7. 测试与验收
- 节点：浏览器打开 `term2.doge-liang-space.uk` → 走 OTP → 终端可连、能开 tmux
  会话、复制粘贴/铃声正常（复用现有前端）。
- 面板：打开 `panel.doge-liang-space.uk` → 走 OTP → 见本机 + term2 两卡；
  「打开」跳对应域名；「添加节点」新增一条并在 KV 持久化，换设备/刷新仍在；
  「删除」移除条目（本机种子禁删）；未过 Access 的直连 Worker 返回 403。

## 8. 交付顺序
1. `scripts/provision-node.sh` + 在 racknerd-13d12ee 上跑通 `term2`。
2. Worker 面板（UI + KV API + Access + 自定义域）部署到 `panel`。
3. 面板登记本机 + term2，端到端验收。
