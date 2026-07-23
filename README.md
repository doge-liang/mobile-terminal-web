# mobile-terminal-web

移动端优先的 Web 终端：手机浏览器打开一个网页即可进入这台机器的 tmux 会话。

- **后端**：Node + [node-pty](https://github.com/microsoft/node-pty)，每个连接执行 `tmux new-session -A -s <name>`（存在则接入，不存在则创建），断线/锁屏后重连不丢现场
- **前端**：[xterm.js](https://xtermjs.org/)，移动端按键工具栏（Esc / Ctrl / Alt / Tab / 方向键 / PgUp…）、粘性 Ctrl/Alt 修饰键、软键盘视口自适应、字体缩放、tmux 会话切换、断线自动重连；支持"添加到主屏幕"以独立 App 形式运行
- **文件传输**：手机可上传任意文件到机器（路径自动打进终端），也可从机器下载；大文件按 64KB 分片顺序上传，绕开受限网络对单请求体的大小限制
- **触摸滚动**：接入时自动开启 tmux 鼠标模式，上下滑动翻译为 SGR 滚轮事件——上滑进入 copy-mode 看历史，滑到底自动回到实时画面
- **安全**：只监听 `127.0.0.1`，经 Cloudflare Tunnel 发布；Cloudflare Access 做认证（邮箱 OTP），应用内二次校验 `Cf-Access-Jwt-Assertion` JWT

> 服务**只应**经 Cloudflare Tunnel 暴露。它默认绑 `127.0.0.1`，任何情况下都不要把端口直接开到公网——它本质是一个可执行任意命令的 root shell 入口。

## 部署

### 前置条件

- Linux + **Node.js 20** + **tmux** + 构建工具（`build-essential python3`，node-pty 需编译）
- 一个 **Cloudflare 账号**（用 Tunnel 发布 + Zero Trust Access 鉴权）与一个托管在该账号下的**域名**

### 方式一：一键起一台节点（推荐）

`scripts/provision-node.sh` 在一台新机器上装依赖、从本控制机推代码、装 systemd 服务、起 token 化 tunnel：

```bash
TUNNEL_TOKEN=<cloudflared-tunnel-token> \
ACCESS_AUD=<该节点 Access 应用的 AUD> \
TEAM_DOMAIN=your-team.cloudflareaccess.com \
  scripts/provision-node.sh <ssh-host-别名> <对外域名，如 term.example.com>
```

- `<ssh-host-别名>`：已在 `~/.ssh/config` 配好免密登录的别名
- Cloudflare 侧的 tunnel / DNS / Access 应用需**先在 Cloudflare 建好**（见下方「Cloudflare 发布」）；脚本只负责主机侧

### 方式二：手动起一台

```bash
npm ci                                        # 编译 node-pty，需要 make/g++/python3/tmux
sudo cp mobile-terminal.service /etc/systemd/system/
sudo editor /etc/default/mobile-terminal      # 写环境变量，见下表
sudo systemctl enable --now mobile-terminal
```

### 环境变量

写入 `/etc/default/mobile-terminal`（systemd 服务从这里读）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `7681` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址，**不要**改成 `0.0.0.0` |
| `TMUX_SESSION` | `mobile` | 默认 tmux 会话名 |
| `MAIN_HOST` | `term.example.com` | 主域名，用于配对页跳转（**请设成你自己的**） |
| `CF_ACCESS_TEAM_DOMAIN` | 空 | 如 `your-team.cloudflareaccess.com`；设置后开启 JWT 校验（留空=本地开发，跳过鉴权） |
| `CF_ACCESS_AUD` | 空 | Access 应用的 Application Audience (AUD) Tag |
| `FAST_HOST` | 空 | 可选，快速通道域名（见下方「快速通道」） |
| `AUTH_SECRET` | 自动生成 | 可选；留空则首启生成到 `.auth-secret`（每节点独立，**绝不可跨节点复制**） |

### Cloudflare 发布（Tunnel + Access）

1. 建 Tunnel，ingress 加 `term.<你的域名>` → `http://127.0.0.1:7681`
2. DNS：`term` CNAME 到 `<tunnel-id>.cfargotunnel.com`（开启代理）
3. Zero Trust → Access → Applications：新建 self-hosted 应用覆盖该域名，策略只允许你自己的邮箱，登录方式 One-time PIN
4. 把该应用的 **AUD** 与**团队域名**填进 `/etc/default/mobile-terminal`（`CF_ACCESS_AUD` / `CF_ACCESS_TEAM_DOMAIN`），重启服务

### 多节点发布

有多台机器时，用 `scripts/deploy.sh` 一条命令发布到所有节点：

```bash
cp scripts/nodes.example scripts/nodes    # 填你的节点清单（不进仓库，已 gitignore）
scripts/deploy.sh                         # rsync 运行时白名单 → 校验 → 重启 → 健康自检
scripts/deploy.sh --dry-run               # 只预演 rsync，不改动任何节点
scripts/deploy.sh --deps                  # 依赖变更时，在每个节点额外跑 npm ci
```

`scripts/nodes` 每行 `<ssh别名|local> <部署路径> <端口>`；运行 `deploy.sh` 的本机写 `local`。脚本：

- 只发布**白名单**（`server.js lib public package*.json`）；机密（`.auth-secret`）、每机独立的 `node_modules`（含原生 node-pty）、服务器上的运行时数据（`uploads/` `metrics/`）一律不碰
- 重启前校验语法与关键 `require`，避免把崩溃的代码上线
- 重启后自检（服务 active、端口有响应、`server.js` 字节与本地一致）
- **任一步失败即自动回滚到上一版**并复检

### 本地开发

不设 `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` 时，鉴权自动放行（身份记为 `local-dev`），便于本地联调：

```bash
npm start
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7681/   # 200/401 皆表示进程正常
```

### 测试

```bash
npm test        # node --test，覆盖 lib/ 下的纯函数
```

`push` 到 `main` 与所有 PR 会自动跑 CI（`.github/workflows/ci.yml`：语法校验 + `npm test`）。`main` 受分支保护，须 PR + CI 绿方可合并。

### 节点面板（可选）

`panel/` 是一个独立的 Cloudflare Worker（内嵌 HTML + KV 节点注册表），把多台节点聚合成一个可视化入口。它与主终端相互独立，部署方式不同：

```bash
cd panel
wrangler kv namespace create NODES        # 建 KV，把返回 id 填进 wrangler.toml
# 编辑 wrangler.toml：换成你的 KV id、自定义域、TEAM_DOMAIN、ZONE_SUFFIX
wrangler secret put PANEL_AUD             # 面板 Access 应用的 AUD（走 secret，不进仓库）
wrangler deploy
```

`wrangler.toml` 与 `worker.js` 里的账号相关值都用占位符，部署前替换成你自己的。

## 双通道与认证模型

- **主通道** `term.<domain>`：经 Cloudflare Tunnel + Access（邮箱 OTP 白名单），任何网络可用
- **快速通道**（可选，`FAST_HOST`，**端到端加密**）：为降低晚高峰经 Cloudflare 的延迟，可另建一条 DNS 直指跳板机、跳板上 nginx stream 做**纯 TCP 转发**（只搬密文、不持私钥）→ WireGuard → 本机终结 TLS 的旁路。浏览器到本机是一条完整 TLS 会话，中继即使被入侵也只见密文。此拓扑是可选优化，非必需
- **白名单唯一准入**：快速通道凭证只能通过配对获得——在主域名打开 `/pair`（先过 Access 邮箱 OTP）→ 签发一次性配对链接（60 秒、单次有效）→ 跳转快速域名种下 HMAC 签名 Cookie（30 天、HttpOnly/Secure）。伪造、过期、重放均被拒绝。吊销全部设备：删除 `.auth-secret` 并重启

## 传输协议

自研三档降级链，客户端按能力从高到低逐个探测（每档 4 秒超时），用第一个可用的：

1. **WebSocket**（`/ws`）——双向长连接，延迟最低。二进制帧 = 终端输出，文本帧 = 控制消息（ping/pong 测 RTT）
2. **SSE + POST**（`/t/sse` + `/t/in`）——下行是单个持续的 HTTP 流（Server-Sent Events），输出连续推送、无轮询空窗；上行按键经串行化+合批的 POST 发送。绝大多数封 WebSocket 的代理都放行 SSE
3. **长轮询 + POST**（`/t/poll` + `/t/in`）——最后兜底，纯普通 HTTPS 请求，能开网页就能用

服务端对 pty 输出做 10ms 合并降低小包数量；HTTP 会话（`POST /t/open` 返回 `sid`）在无下行消费者 45 秒后回收 pty（tmux 会话本身不受影响）。状态栏实时显示当前传输方式与平滑 RTT，如 `已连接 (SSE) 230ms`。

## 延迟遥测

客户端把实测 RTT 每 60 秒上报一次（页面关闭时 sendBeacon 补报）：`POST /t/metrics`，服务端算好 min/p50/p95/max/avg 追加到 `metrics/latency.jsonl`（10MB 轮转，git 忽略），并向 journal 打 `[metric]` 摘要行。聚合查询：`GET /t/metrics/summary?hours=24`，按"入口域名 × 传输方式"分组，对比不同通道/传输的真实延迟与重连次数。

## Android 客户端

`android/` 提供一个零依赖的 WebView 壳应用（DogeTerm），启动即加载面板并可进入各节点终端，Access 登录、文件上传/下载均在应用内完成。APK 由 GitHub Actions 云端构建签名，产物见 [Releases](../../releases)。构建与签名细节见 [android/README.md](android/README.md)。

## 许可

MIT
