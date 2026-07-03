# mobile-terminal-web

移动端优先的 Web 终端：手机浏览器打开一个网页即可进入这台机器的 tmux 会话。

- **后端**：Node + [node-pty](https://github.com/microsoft/node-pty)，每个连接执行 `tmux new-session -A -s <name>`（存在则接入，不存在则创建），断线/锁屏后重连不丢现场
- **前端**：[xterm.js](https://xtermjs.org/)，移动端按键工具栏（Esc / Ctrl / Alt / Tab / 方向键 / PgUp…）、粘性 Ctrl/Alt 修饰键、软键盘视口自适应、字体缩放（手机默认 12px）、tmux 会话切换、断线自动重连；支持"添加到主屏幕"以独立 App 形式运行
- **触摸滚动**：tmux 的历史在它自己的 scrollback 里（终端处于备用屏幕），网页原生滚动无效；因此接入时自动开启该会话的 tmux 鼠标模式（`set-option mouse on`），前端把上下滑动翻译成 SGR 滚轮事件——上滑进入 copy-mode 查看历史（右上角有位置指示），滑到底部自动回到实时画面
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

自研三档降级链，客户端按能力从高到低逐个探测（每档 4 秒超时），用第一个可用的：

1. **WebSocket**（`/ws`）——双向长连接，延迟最低。二进制帧 = 终端输出，文本帧 = 控制消息（ping/pong 测 RTT）
2. **SSE + POST**（`/t/sse` + `/t/in`）——下行是单个持续的 HTTP 流（Server-Sent Events），输出连续推送、无轮询空窗；上行按键经串行化+合批的 POST 发送。绝大多数封 WebSocket 的代理都放行 SSE
3. **长轮询 + POST**（`/t/poll` + `/t/in`）——最后兜底，纯普通 HTTPS 请求，能开网页就能用

服务端对 pty 输出做 10ms 合并降低小包数量；HTTP 会话（`POST /t/open` 返回 `sid`）在无下行消费者 45 秒后回收 pty（tmux 会话本身不受影响）。状态栏实时显示当前传输方式与平滑 RTT，如 `已连接 (SSE) 230ms`。
