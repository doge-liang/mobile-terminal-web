# 文件上传 / 下载 — 设计文档

- 日期:2026-07-09
- 状态:已批准,待实现计划
- 涉及组件:term app（`server.js` + `public/`)、`scripts/provision-node.sh`

## 1. 目标

在移动端 Web 终端里实现双向文件传输:

- **上传**:从手机把任意类型文件送到节点。
- **下载**:从节点把任意可读文件取回手机。

两种交互形态都要:

- **终端原生**:贴合现有"上传后把路径打进终端"的体验,改动最小。
- **文件浏览器面板**:可视化浏览目录、点选上传/下载。

## 2. 非目标（YAGNI)

- 不做 WebSocket / SSE 传文件,不发明自定义分块协议。
- 不做分块 / 断点续传上传;单次传输,断了整体重传。
- 下载暂不支持 HTTP Range。
- 不做路径 jail / 沙箱(见 §7 安全)。

## 3. 网络协议

全部走**普通 HTTP(S) 请求 / 响应**,独立于终端的 WS/SSE 数据通道。

| 层 | 用什么 |
|---|---|
| 应用层 | HTTP(浏览器↔CF 边缘为 HTTP/2;cloudflared 隧道到本机 Node 为 HTTP/1.1) |
| 安全 / 传输 | TLS over TCP，经 Cloudflare 隧道 |
| 路径 | 手机 → CF 边缘 → cloudflared 隧道 → 本机 `server.js` |

理由:普通 POST/GET 是标准 HTTPS，不受"家里 MITM 网关掐 WS Upgrade"影响（现有图片上传已验证可穿透);`Content-Length`、整体重试、`Content-Disposition` 触发系统下载 UI 都是浏览器 + Node 原生能力。

认证:所有新路由沿用 `/t/` 前缀，复用现有 `verifyAuth`（Access 邮箱 / JWT）。同源请求自动携带 Access cookie，无需新增认证代码或令牌。

## 4. 服务端（server.js)

### 4.1 上传 — 泛化现有 `POST /t/upload`

现状:仅接受 `IMG_EXT` 白名单内的图片，落 `/root/uploads`，生成随机名，上限 15MB。

改动:

- 去掉 `IMG_EXT` 白名单，接受任意 `Content-Type`。
- 上限 15MB → **100MB**(`UPLOAD_MAX`)。保留 `Content-Length` 预检(超限直接 413，避免中途断流在浏览器里表现为不透明的"网络错误")。
- 新增可选查询参数 `?dir=<绝对路径>&name=<文件名>`:
  - **带 `dir`**:落到 `path.join(dir, safeBasename(name))`。`name` 做 basename 消毒(剥离路径分隔符、拒绝 `..`、去空白);`dir` 按用户所给绝对路径使用，不做 jail。同名不覆盖，追加 ` (1)`、` (2)`……。返回 `{ path: <最终绝对路径> }`。
  - **不带 `dir`**:沿用旧行为(落 `/root/uploads` + 生成名)。**保证现有图片粘贴流向后兼容。**
- `dir` 不存在 / 不可写 → 返回可读的 JSON 错误(4xx)，不 500。

### 4.2 下载 — 新增 `GET /t/dl?path=<绝对路径>`

- `verifyAuth` 门禁。
- `fs.stat` 校验:不存在 → 404;是目录 → 400("不能下载目录");不可读 → 403。以上均返回可读 JSON 错误。
- 命中 → `fs.createReadStream` 流式回传，设:
  - `Content-Length`(来自 stat.size)
  - `Content-Type`:按扩展名猜测，未知用 `application/octet-stream`
  - `Content-Disposition: attachment; filename="<ascii 回退>"; filename*=UTF-8''<pct-encoded>`(RFC 5987，兼容中文/空格文件名)
- 无大小上限。跨站 JS 读不到跨源响应体;下载是顶级导航到用户自己设备，无 CSRF 泄露风险。

### 4.3 目录列举 — 新增 `GET /t/ls?path=<绝对路径>`(面板用)

- `verifyAuth` 门禁。无 `path` 时默认 `HOME`（`~`)。
- 返回 JSON:
  ```json
  {
    "path": "/root/project",
    "parent": "/root",
    "entries": [
      { "name": "sub", "type": "dir", "size": 4096, "mtime": 1720512000000 },
      { "name": "a.csv", "type": "file", "size": 1234, "mtime": 1720512000000 }
    ]
  }
  ```
- `type` ∈ `dir` / `file` / `symlink`(用 `lstat` 判 symlink，符号链接目标类型不深挖）。
- 排序:目录优先，其后按名称。
- 目录不存在 → 404;不可读 → 403;单个条目 `stat` 失败跳过该条目，不整体失败。根目录 `/` 的 `parent` 为 `/` 自身。

## 5. 客户端（public/)

### 5.1 终端原生上传

- 把现有 `uploadImage()` 拆出通用 `uploadFile(file)`：去掉图片再编码那步，`POST /t/upload`（不带 `dir`，走 legacy 落地),成功后把返回的 `path` 打进终端。
- 现有 📷（相册)、📋（剪贴板图片)复用同一个 `uploadFile`（图片入口可保留再编码以省流量，作为可选优化)。
- `index.html` statusbar 新增 📎 按钮 + `<input type="file" accept="*/*" multiple hidden>`;点按调起文件选择，选中文件逐个 `uploadFile`。

### 5.2 `dl` shell 助手（终端原生下载)

- 一个 shell 函数，打印可点下载链接:
  ```sh
  dl() {
    for f in "$@"; do
      local abs; abs=$(realpath -- "$f") || { echo "dl: 找不到 $f" >&2; continue; }
      # URL-encode 路径后拼主域名
      echo "https://<主域名>/t/dl?path=$(url_encode "$abs")"
    done
  }
  ```
- 安装位置:节点 `~/.bashrc`（或 `/etc/profile.d/`)。由 `scripts/provision-node.sh` 写入，使新节点自带;同时手动装到当前运行节点。
- 主域名从节点已知配置注入(provision 脚本已持有 main-host 参数)。
- 点链接 = 顶级导航 GET，浏览器带 Access cookie，边缘 + 本地双重校验通过后触发下载。

### 5.3 文件浏览器面板

- 复用现有 `#session-panel` 抽屉模式(`.sp-box` + `hidden` 切换、点遮罩关闭)，新增 `#file-panel`:
  - 顶部:当前路径面包屑 / 文本;返回上级按钮(`parent`)。
  - 列表:每个条目一行，目录带 📁 点击进入(`GET /t/ls?path=`);文件带 📄 点击下载(导航到 `/t/dl?path=`)。
  - 底部:"上传到此目录"按钮 → file input → `POST /t/upload?dir=<当前路径>`,成功后刷新列表。
- statusbar 新增 📁 按钮打开面板;首屏 `GET /t/ls`（默认 `HOME`)。

## 6. 分期

### 一期 — 终端原生（上传下载双向可用)

1. server:泛化 `/t/upload`（任意类型 + 100MB + `?dir=&name=`)。
2. server:新增 `GET /t/dl`。
3. client:`uploadImage` → 通用 `uploadFile`;新增 📎 按钮 + file input。
4. `dl` 助手:写入 `provision-node.sh` + 装到当前节点。

一期结束即可双向传文件。

### 二期 — 可视文件浏览面板

5. server:新增 `GET /t/ls`。
6. client:`#file-panel` 抽屉 + 📁 按钮 + 面包屑 / 列表 / 上传到当前目录。

两期共用 `/t/dl`,各自独立可用。

## 7. 安全

- **唯一边界是认证闸**（Access 邮箱 / JWT):每个白名单邮箱本就有整机 root shell，故文件浏览器暴露全盘、下载任意可读文件**不构成新增权限**。刻意不做路径 jail——防不住 root shell，只是心理安慰。
- **上传文件名消毒**:`name` 取 basename、拒绝 `..` 与路径分隔符，防止构造出与预期不同的落地路径(即便无越权后果，也避免意外覆盖)。同名不覆盖。
- **大小**:上传 100MB 封顶 + `Content-Length` 预检;下载无上限(流式，不占内存)。
- **符号链接**:`/t/dl` 的 `createReadStream` 会跟随 symlink——用户是 root，符合预期;`/t/ls` 用 `lstat` 标注 symlink 类型供 UI 提示。
- **CSRF**:下载为 GET 顶级导航到用户自身设备，跨站不可读响应;上传为需要有效 Access cookie 的 POST。均无实际泄露面。

## 8. 测试

仓库无单测框架，采用手动 + curl 验证:

- **上传**:`curl -X POST 'https://<host>/t/upload?dir=/tmp&name=t.bin' --data-binary @file`(带 Access cookie)→ 校验落地路径、同名追加、超 100MB 得 413、无 `dir` 走 legacy。
- **下载**:`curl -OJ 'https://<host>/t/dl?path=/tmp/t.bin'` → 校验字节一致、`Content-Disposition` 文件名(含中文)、目录得 400、越权路径得 403/404。
- **列举**:`GET /t/ls?path=/root` → 校验排序、`parent`、权限降级。
- **浏览器**:📎 上传任意文件路径打进终端;`dl` 打印链接点击下载;面板导航 / 下载 / 上传到当前目录。

## 9. 边界情形

- 上传同名文件 → ` (n)` 追加,不覆盖。
- `dir` 不存在 / 不可写 → 4xx JSON,不 500。
- 下载目录 / 不存在 / 不可读 → 400 / 404 / 403 JSON。
- 中文、空格文件名 → 上传 `name` URL-decode;下载 `Content-Disposition` 用 RFC 5987 `filename*`;`dl` 助手对路径 URL-encode。
- `ls` 单条目 `stat` 失败 → 跳过该条,不整体失败;根 `/` 的 `parent` 为自身。
