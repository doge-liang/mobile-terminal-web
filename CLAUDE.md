# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                              # 起服务(默认 127.0.0.1:7681);不设 CF_ACCESS_* 时鉴权放行,身份记为 local-dev
npm test                               # node --test test/
node --test test/preview.test.js       # 跑单个测试文件
node --check server.js                 # CI 的语法闸(另含 public/app.js lib/chunk-upload.js lib/upload-paths.js)
npm run build:hljs                     # 改 highlight.js 后重新生成 public/vendor/highlight.min.js
scripts/deploy.sh [--dry-run|--deps]   # 发布到 scripts/nodes 列出的全部节点
```

git/gh 在本环境须先 `export HOME=/root`,否则读不到凭证。`main` 受分支保护:改动走 PR,CI(`.github/workflows/ci.yml`)绿方可合并。提交信息用中文 + conventional-commit 前缀。

搜索时排除 `.claude/worktrees/`(整仓副本)与 `.superpowers/`、`docs/superpowers/`(gitignore 的规划文档),否则每个命中会重复四份。

部署、Cloudflare Tunnel/Access 配置、环境变量表见 `README.md`,不在此重复。

## 仓库装了四件独立部署的东西

| 目录 | 是什么 | 怎么上线 |
|---|---|---|
| `server.js` + `lib/` + `public/` | 节点上的终端服务(Node,systemd) | `scripts/deploy.sh` |
| `panel/` | 聚合多节点的 Cloudflare Worker | `cd panel && wrangler deploy` |
| `android/` | DogeTerm WebView 壳 | 推 `android-v*` tag,或 `gh workflow run android-apk.yml -f release_tag=android-v1.0.x` |
| `box/` | agent 沙盒 CLI 的**快照**(见下) | 不从这里上线 |

`scripts/deploy.sh` 只同步白名单 `server.js lib public package.json package-lock.json`——`box/`、`panel/`、`android/`、`test/` 都不随它走;`.auth-secret`、`metrics/`、每机独立编译的 `node_modules/` 一律不碰。同步前打 `.deploy-prev.tgz` 快照,校验/重启/健康检查任一步失败自动回滚。

`release_tag` 留空的手动派发只出 artifact,不建 Release;版本号在 `android/app/build.gradle` 手动 +1。

`box/` 与节点上实际安装的 `/opt/box`(命令 `ag-box`)已经分叉——已核实 `mounts.js`、`runtime.js` 不同,且 `/opt/box/lib` 多出 `lsjson.js`。本目录的用途是给 `test/box-*.test.js` 提供被测纯函数、并记录节点侧 box API 的契约;**改这里不会影响装好的 `ag-box`**,后者的规范源在独立仓 agent-box。

`panel/src/worker.js` 可能落后于生产 Worker(历史上有未提交回仓的改动)。在 `panel/` 下 `wrangler deploy` 前,先把生产版本拉下来与仓库版对比,否则会覆盖线上改动。

## 架构要点

### 传输三档降级链

客户端按能力从高到低探测(每档 4 秒超时),用第一个可用的:WebSocket(`/ws`)→ SSE + POST(`/t/sse` + `/t/in`)→ 长轮询 + POST(`/t/poll` + `/t/in`)。客户端实现在 `public/app.js` 的 `tryWebSocket` / `tryHttp`,服务端在 `server.js` 的 `httpSessions` Map。

两侧是一对协议,改一边必须同时改另一边。关键常量都在服务端:`COALESCE_MS=10`(pty 输出合批)、`POLL_HOLD_MS=25000`(长轮询驻留,Cloudflare 约 100s 掐空闲)、`GC_IDLE_MS=45000`(无下行消费者超时后回收 pty——**tmux 会话本身不受影响**,重连即回到原现场)。

### 双通道、单一准入闸

`verifyAuth()` 接受两种凭证:主域名的 Cloudflare Access JWT,或快速通道域名(`FAST_HOST`)的 HMAC 签名 Cookie。Cookie **只能**经 `/pair` 签发,而 `/pair` 本身只认 JWT——所以 Cloudflare Access 的邮箱白名单始终是两条通道唯一的准入闸。配对链接 60 秒、单次有效(`usedPairIds`)。

`.auth-secret` 是每节点独立的 HMAC 密钥,**绝不可跨节点复制**;删掉它并重启即吊销全部快速通道设备。

服务令牌身份(JWT 带 `common_name`,面板 Worker 用)由 `serviceAuthAllowed` 限死在 `/t/box/*`,且须命中 `BOX_CTRL_CN` 白名单;人类身份不归它管。

### CSP 与 vendoring

强制 `script-src 'self'`,第三方资源全部同源提供:前端加依赖 = 往 `server.js` 的 `VENDOR`(单文件)或 `VENDOR_DIRS`(目录前缀,如 KaTeX 字体、hljs ESM 子模块)加一条映射,**不是**加 CDN 标签。`style-src` 放开 `'unsafe-inline'` 是因为 KaTeX 写内联 style、xterm 注入 `<style>`。前端不得有内联 `script` 或 `on*` 处理器。

### lib/ 是纯函数,server.js 管 I/O

测试只覆盖 `lib/*` 与 `box/lib/*`。CI **不跑 `npm ci`**,所以测试可达的代码不能碰 node-pty 等原生依赖——新逻辑要可测,就把纯判断抽进 `lib/`。

`lib/box-api.js` 刻意重新实现了 `box/lib/` 里的一些小校验(如 `isValidBoxName`)而没有跨目录 require:两者隔着一条部署边界,`box/` 不随 `deploy.sh` 上线。不要为了 DRY 把它们合并,那会让节点侧在部署后少文件。

### tmux 与触摸滚动

每个连接执行 `tmux new-session -A -s <name>`(存在则接入)。attach 后追加 `set-option mouse on`(滑动翻译成 SGR 滚轮事件后进 tmux copy-mode 看历史)与 `set-option -g set-clipboard on`(注意是 `on` 不是默认的 `external`——实测只有 `on` 会把盒内应用的 OSC 52 透传给 xterm.js)。`?box=<名>` 走 `resolveBoxAttach`,改为 attach 该沙盒自己的 tmux socket。
