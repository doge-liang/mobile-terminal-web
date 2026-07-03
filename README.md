# mobile-terminal-web

移动端优先的 Web 终端：手机浏览器打开一个网页即可进入这台机器的 tmux 会话。

- **后端**：Node + [node-pty](https://github.com/microsoft/node-pty)，每个连接执行 `tmux new-session -A -s <name>`（存在则接入，不存在则创建），断线/锁屏后重连不丢现场
- **前端**：[xterm.js](https://xtermjs.org/)，移动端按键工具栏（Esc / Ctrl / Alt / Tab / 方向键 / PgUp…）、粘性 Ctrl/Alt 修饰键、软键盘视口自适应、字体缩放、tmux 会话切换、断线自动重连；支持"添加到主屏幕"以独立 App 形式运行
- **安全**：只监听 `127.0.0.1`，经 Cloudflare Tunnel 发布；Cloudflare Access 做认证（邮箱 OTP），应用内二次校验 `Cf-Access-Jwt-Assertion` JWT

## 部署

```bash
npm install                     # 编译 node-pty，需要 make/g++/python3
cp mobile-terminal.service /etc/systemd/system/
systemctl enable --now mobile-terminal
```

环境变量（写入 `/etc/default/mobile-terminal`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `7681` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址，不要改成 0.0.0.0 |
| `TMUX_SESSION` | `mobile` | 默认 tmux 会话名 |
| `CF_ACCESS_TEAM_DOMAIN` | 空 | 如 `xxx.cloudflareaccess.com`，设置后开启 JWT 校验 |
| `CF_ACCESS_AUD` | 空 | Access 应用的 Application Audience (AUD) Tag |

## Cloudflare 发布

1. Tunnel ingress 添加 `term.<domain>` → `http://127.0.0.1:7681`
2. DNS：`term` CNAME 到 `<tunnel-id>.cfargotunnel.com`（开启代理）
3. Zero Trust → Access → Applications：新建 self-hosted 应用覆盖该域名，策略只允许自己的邮箱，登录方式 One-time PIN
4. 把应用的 AUD 和团队域名填入 `/etc/default/mobile-terminal`，重启服务

## 传输协议

使用 socket.io（engine.io）：**先以 HTTP 长轮询建立连接**（纯普通 HTTPS 请求，任何能打开网页的网络都可用），后台探测 WebSocket，探测成功才无缝升级；在封锁 WebSocket 的受限网络（企业代理、酒店/校园网等）中自动停留在轮询模式。状态栏会显示当前传输方式（`WS` / `轮询`）。

事件：客户端 → 服务端 `i`（输入字符串）、`r`（`{cols, rows}` 调整尺寸）；服务端 → 客户端 `o`（终端原始输出）。tmux 会话名、初始尺寸经握手 `auth` 传递。
