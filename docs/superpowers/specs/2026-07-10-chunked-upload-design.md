# 分片上传（绕过代理层 1MB 单请求上限）— 设计文档

- 日期:2026-07-10
- 状态:已批准，待实现计划
- 涉及组件:`server.js`、`public/app.js`、`lib/`（新增拼接/校验纯函数）、`test/`

## 1. 背景与问题

当前上传把整个文件作为**单个** POST 请求体发到 `/t/upload`（`server.js` 上限 `UPLOAD_MAX = 100MB`）。但部署所在网络的代理层（Cloudflare）把**单次请求体**限制在 1MB：

- 27KB / 77KB 等小文件能过。
- 超过 1MB 的请求在浏览器里表现为不透明的“网络错误”，无法完成上传。

图片路径已有 `shrinkImage`（压到 ≤2560px JPEG，通常 <1MB），但文件面板的任意文件（`uploadFile`）原样上传，>1MB 即失败。

## 2. 目标

- 让任意大小文件（仍受 100MB 总上限）在 1MB 单请求代理限制下可上传。
- 现有小文件路径保持不变，零回归风险。
- 失败有清晰提示，而非不透明网络错误。

## 3. 非目标（YAGNI）

- **不做跨页面刷新的断点续传**。失败在本会话内按片重试；整体失败则报错、由用户重传。不持久化进度到 localStorage。
- 不做乱序 / 并发分片上传（对 1MB 限制无收益，且使服务端拼接复杂化）。
- 不改下载路径（`/t/dl` 保持现状；下载是响应体，不受上传请求限制）。
- 不做跨用户隔离（单用户个人终端）。

## 4. 触发与分流

`uploadFile(file, dir)` 按大小分流:

- `file.size <= CHUNK_SIZE` → 走**现有** `/t/upload` 单请求。路径完全不动。
- `file.size > CHUNK_SIZE` → 走新的分片路径 `/t/upload-chunk`。

图片仍先经 `shrinkImage`；压缩后通常一片，走单请求路径。

## 5. 参数

- `CHUNK_SIZE = 512 * 1024`(524288 字节)。远低于 1MB，为 HTTP 头与代理计量留足余量。10MB 文件 = 20 个请求。定义为常量便于日后调整。
- `total`(文件总字节)仍受 `UPLOAD_MAX = 100MB` 限制。
- 单片服务端读取上限设为 `CHUNK_SIZE + 4KB` 余量（`readBodyRaw` 的 `limit` 参数）。

## 6. 网络协议

新端点，走普通 HTTP(S)，独立于终端 WS/SSE 通道:

```
POST /t/upload-chunk?id=<hex>&offset=<n>&total=<n>&name=<n>&dir=<n>&final=1
Content-Type: application/octet-stream
Body: 原始分片字节(<= CHUNK_SIZE)
```

查询参数:

| 参数 | 含义 |
| --- | --- |
| `id` | 客户端生成的随机 hex，标识一次上传会话。服务端严格校验 `^[a-f0-9]{8,64}$` |
| `offset` | 本片在文件中的起始字节偏移。服务端据此校验顺序 |
| `total` | 文件总字节数。用于上限校验与完成判定 |
| `name` | 客户端文件名(可选)，最终定名用。沿用 `safeBasename` |
| `dir` | 目标目录(可选)，缺省 `UPLOAD_DIR` |
| `final` | 末片带 `final=1`(或服务端在累计达到 `total` 时自动收尾) |

响应:

- 中间片:`200 { ok: true, received: <当前累计字节> }`
- 末片(完成):`200 { path: "<落地绝对路径>" }`
- 顺序不符:`409 { error: "chunk out of order", expected: <当前 .part 大小> }`(客户端可据 `expected` 重发)
- 超限 / 非法:`413` / `400`，沿用现有风格的中文错误体

## 7. 服务端拼接（方案 A:顺序 append + offset 校验）

临时目录:`PARTS_DIR = path.join(UPLOAD_DIR, '.parts')`，启动时 `mkdirSync(recursive)`。

单次 `/t/upload-chunk` 处理:

1. 校验 `id` 匹配 `^[a-f0-9]{8,64}$`，否则 400。构造 `partPath = PARTS_DIR/<id>.part`。
2. 校验 `total <= UPLOAD_MAX`，否则 413。
3. `readBodyRaw(req, CHUNK_SIZE + 4096)` 读本片；超限则 413。
4. 取 `partPath` 当前大小(不存在记 0)，校验 `=== offset`；不符返回 409 带 `expected`。
5. 以 `flag: 'a'` 追加写入本片。
6. 计算 `newSize = offset + 本片长度`。
   - 若 `final` 为真或 `newSize >= total`:进入收尾。
   - 否则返回 `200 { ok: true, received: newSize }`。
7. **收尾**:校验 `newSize === total`(不符视为损坏，删 `.part` 并返回 400)。沿用 `/t/upload` 的定名逻辑(`safeBasename(name)` → 生成名回退、`uniqueName` 去重)，将 `.part` `rename` 到 `destDir/<final>`，返回 `200 { path }`。

关键性质:

- **无服务端会话表**，每个请求自描述，靠 `.part` 文件大小推断进度。天然幂等:同一片重发时若已写入，`offset` 校验会失配(409, expected=已写大小)，客户端据 `expected` 跳到正确 offset 续发。
- **路径穿越防护**:`id` 白名单校验杜绝 `.part` 路径被操纵;目标定名沿用既有 `safeBasename`。
- **孤儿清理**:现有每小时清扫循环扩展为一并清理 `PARTS_DIR` 下超过 TTL(`UPLOAD_KEEP_MS`)的 `.part`。

## 8. 客户端流程（分片路径）

改造 `uploadFile(file, dir)`:

1. 若 `file.size <= CHUNK_SIZE`，沿用现有单请求逻辑，直接返回。
2. 否则:用 `crypto.getRandomValues` 生成 16 字节 hex `id`。
3. `for (let offset = 0; offset < file.size; offset += CHUNK_SIZE)`:
   - `const chunk = file.slice(offset, offset + CHUNK_SIZE)`
   - `const final = offset + CHUNK_SIZE >= file.size`
   - POST `/t/upload-chunk?id&offset&total&name&dir&final`，body 为 `chunk`。
   - **每片失败重试 2 次**(网络错误 / 5xx / 409)。收到 409 时用响应里的 `expected` 校正 `offset` 再试。重试仍失败则整体中止，`flashNote` 报错，返回 `null`。
   - 进度:`flashNote(\`上传中… ${name} (${i+1}/${N})\`)`。
4. 从末片响应取 `path` 返回。

调用方(`btn-file` / `btn-img` / 面板)无需改动:`uploadFile` 对外契约不变(返回落地 `path` 或 `null`)。

## 9. 代码组织

将可独立测试的纯逻辑抽到 `lib/`(便于 `node:test` 单测，沿用 `lib/upload-paths.js` 风格):

- `lib/chunk-upload.js`:
  - `isValidUploadId(id)` — 白名单校验。
  - `partPathFor(partsDir, id)` — 组装 `.part` 路径。
  - 定名逻辑若与 `/t/upload` 重复，抽成共享函数 `resolveDestName({ name, mime, destDir, taken })` 供两个端点复用，消除重复。

`server.js` 的 `/t/upload-chunk` 处理器负责 IO 编排(读体、append、rename、清理)，调用上述纯函数。

## 10. 测试

`test/chunk-upload.test.js`(`node:test`):

- `isValidUploadId`:接受合法 hex，拒绝含 `/`、`.`、`..`、超长、空串。
- `resolveDestName`:有名 / 无名回退 / 去重(与现有 `uniqueName` 行为一致)。
- 端到端顺序校验的判定逻辑(offset 匹配 / 失配 / 完成判定)若抽为纯函数则一并覆盖。

## 11. 部署

纯静态 + Node 应用改动，按既有多节点增量部署流程(tar 同步改动、不碰 `.auth-secret`、静态免重启;`server.js` 改动需重启服务)。新增 `PARTS_DIR` 由启动时 `mkdirSync` 自动创建，无需手工准备。
