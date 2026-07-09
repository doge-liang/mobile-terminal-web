# 文件上传 / 下载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在移动端 Web 终端里实现双向文件传输——任意类型文件上传（终端原生 + 文件浏览器面板）与任意可读文件下载。

**Architecture:** 全部走普通 HTTP(S) 请求/响应，独立于终端的 WS/SSE 通道，复用现有 `verifyAuth`（Access 邮箱/JWT）门禁。服务端在 `server.js` 的 `/t/` 路由块内新增/泛化端点；客户端在 `public/` 增加按钮与抽屉面板;`dl` 下载助手装到节点 shell。分两期:一期终端原生(上传下载已可用)，二期可视文件浏览面板。

**Tech Stack:** Node 20（CommonJS，`http` + `fs` + `node:test` 内置测试运行器，无新依赖)、原生 DOM（无框架）、xterm.js、systemd（`mobile-terminal` 服务)、shell 助手。

## Global Constraints

- 上传上限 100MB（`UPLOAD_MAX = 100 << 20`);下载无上限，流式。
- 所有新路由挂在 `/t/` 前缀下，位于 `server.js:316` 的 `if (url.pathname.startsWith('/t/'))` 块内，`auth` 已在 `server.js:317` 就绪——**不新增认证代码**。
- 不做路径 jail:用户本就有整机 root shell，认证闸是唯一边界。仅对上传文件名做 basename 消毒。
- 不用 WebSocket/SSE 传文件，不做分块/断点续传，下载不做 HTTP Range。
- 本地无 CF 时，对 `/t/*` 的未认证 `curl` 一律返回应用自身的 `403 {"error":"unauthorized","from":"mobile-terminal-app"}`——用它来验证「路由已挂载、服务存活」;端到端功能须经已认证浏览器验证。
- 服务:`systemctl restart mobile-terminal`（监听 `127.0.0.1:7681`,`WorkingDirectory=/root/mobile-terminal-web`)。改 `server.js` 需重启;仅改 `public/` 静态文件只需刷新页面。
- 提交信息结尾加 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。git 前先 `export HOME=/root`。**不推送**,除非用户明确要求。

---

## 一期 — 终端原生

### Task 1: 纯路径助手（文件名消毒 + 同名避让)

**Files:**
- Create: `lib/upload-paths.js`
- Test: `test/upload-paths.test.js`

**Interfaces:**
- Produces:
  - `safeBasename(name: string) -> string | null` — 取最后一段路径、去控制字符、拒绝 `.`/`..`/空;不可用时返回 `null`。
  - `uniqueName(base: string, taken: (name: string) => boolean) -> string` — `taken(base)` 为真时在扩展名前插入 ` (1)`、` (2)`…返回首个未占用名。

- [ ] **Step 1: 写失败测试**

```js
// test/upload-paths.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { safeBasename, uniqueName } = require('../lib/upload-paths');

test('safeBasename 剥离目录成分', () => {
  assert.strictEqual(safeBasename('/etc/passwd'), 'passwd');
  assert.strictEqual(safeBasename('a/b/c.txt'), 'c.txt');
  assert.strictEqual(safeBasename('report.pdf'), 'report.pdf');
});

test('safeBasename 拒绝穿越与空名', () => {
  assert.strictEqual(safeBasename('..'), null);
  assert.strictEqual(safeBasename('.'), null);
  assert.strictEqual(safeBasename('   '), null);
  assert.strictEqual(safeBasename('../../x'), 'x'); // basename('../../x') === 'x'
});

test('safeBasename 保留中文与空格', () => {
  assert.strictEqual(safeBasename('数据 报告.csv'), '数据 报告.csv');
});

test('uniqueName 未占用时原样返回', () => {
  assert.strictEqual(uniqueName('a.txt', () => false), 'a.txt');
});

test('uniqueName 同名时在扩展名前插入序号', () => {
  const existing = new Set(['a.txt', 'a (1).txt']);
  assert.strictEqual(uniqueName('a.txt', (n) => existing.has(n)), 'a (2).txt');
});

test('uniqueName 处理无扩展名', () => {
  const existing = new Set(['README']);
  assert.strictEqual(uniqueName('README', (n) => existing.has(n)), 'README (1)');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /root/mobile-terminal-web && node --test test/upload-paths.test.js`
Expected: FAIL — `Cannot find module '../lib/upload-paths'`。

- [ ] **Step 3: 实现最小代码**

```js
// lib/upload-paths.js
'use strict';
const path = require('path');

// 把客户端传来的文件名收敛成安全 basename:剥离任何目录成分、拒绝穿越。
// 无法收敛时返回 null（调用方改用生成名）。
function safeBasename(name) {
  if (typeof name !== 'string') return null;
  let base = path.basename(name.trim());          // 干掉 "../"、"a/b"、绝对路径
  base = base.replace(/[\x00-\x1f\x7f]/g, '');     // 去控制字符
  if (!base || base === '.' || base === '..') return null;
  return base;
}

// 给定基础文件名与谓词 taken(name)->bool,在扩展名前插入 " (1)"、" (2)"…
// 返回首个不冲突的名字。
function uniqueName(base, taken) {
  if (!taken(base)) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

module.exports = { safeBasename, uniqueName };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /root/mobile-terminal-web && node --test test/upload-paths.test.js`
Expected: PASS — 6 tests pass。

- [ ] **Step 5: 提交**

```bash
export HOME=/root
git add lib/upload-paths.js test/upload-paths.test.js
git commit -m "feat: pure filename-sanitize + collision-suffix helpers (tested)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 泛化 `/t/upload`（任意类型 + 100MB + dir/name + 不覆盖)

**Files:**
- Modify: `server.js`（require 区新增一行;`server.js:239` 的 `UPLOAD_MAX`;`server.js:431-456` 的上传 handler)

**Interfaces:**
- Consumes: `safeBasename`, `uniqueName`（Task 1);现有 `readBodyRaw`、`json`、`UPLOAD_DIR`、`IMG_EXT`、`auth`。
- Produces: `POST /t/upload[?dir=<绝对路径>&name=<文件名>]` → `200 { path: <最终绝对路径> }`;超限 413;写入失败 400;空体 400。

- [ ] **Step 1: 提高上限常量**

`server.js:239` 改:

```js
const UPLOAD_MAX = 100 << 20;
```

- [ ] **Step 2: 引入助手模块**

在 `server.js` 顶部 require 区（紧邻其它 `require` 处）加:

```js
const { safeBasename, uniqueName } = require('./lib/upload-paths');
```

- [ ] **Step 3: 重写上传 handler**

把 `server.js:431-456` 整个 `if (req.method === 'POST' && url.pathname === '/t/upload') { … }` 块替换为:

```js
    if (req.method === 'POST' && url.pathname === '/t/upload') {
      const mime = (req.headers['content-type'] || '').split(';')[0].trim();
      // 超限先按 Content-Length 拒,中途断流在浏览器里表现为不透明的“网络错误”
      const declared = parseInt(req.headers['content-length'], 10) || 0;
      if (declared > UPLOAD_MAX) {
        console.log(`[upload] rejected: ${Math.round(declared / 1048576)}MB > 100MB from ${auth.email}`);
        return json(res, 413, { error: `文件太大: ${Math.round(declared / 1048576)}MB (上限 100MB)` });
      }
      let buf;
      try { buf = await readBodyRaw(req, UPLOAD_MAX); } catch {
        console.log(`[upload] rejected: body exceeded 100MB mid-stream from ${auth.email}`);
        return json(res, 413, { error: '文件太大 (上限 100MB)' });
      }
      if (!buf.length) return json(res, 400, { error: 'empty body' });

      const destDir = url.searchParams.get('dir') || UPLOAD_DIR;
      let base = url.searchParams.get('name') ? safeBasename(url.searchParams.get('name')) : null;
      if (!base) {
        // 无可用客户端名:生成一个,识别得出的图片类型给对应扩展名,否则 .bin
        const ext = IMG_EXT[mime] || 'bin';
        base = `paste-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
      }

      let final;
      try {
        final = uniqueName(base, (n) => fs.existsSync(path.join(destDir, n)));
        await fs.promises.writeFile(path.join(destDir, final), buf);
      } catch (e) {
        console.log(`[upload] write failed dir="${destDir}": ${e.message}`);
        return json(res, 400, { error: `无法写入目录: ${destDir}（不存在或无权限）` });
      }
      const dest = path.join(destDir, final);
      console.log(`[${new Date().toISOString()}] ${auth.email} uploaded ${dest} (${buf.length} bytes)`);
      return json(res, 200, { path: dest });
    }
```

（注:原先对非图片类型返回 415 的分支被整体移除——现接受任意类型。)

- [ ] **Step 4: 语法检查**

Run: `cd /root/mobile-terminal-web && node --check server.js`
Expected: 无输出（退出码 0)。

- [ ] **Step 5: 重启并做存活验证**

```bash
systemctl restart mobile-terminal
sleep 1
curl -s -o /dev/null -w '%{http_code}\n' -X POST --data-binary @/etc/hostname 'http://127.0.0.1:7681/t/upload'
```
Expected: `403`（认证闸,证明路由已挂载、服务存活)。
补充确认无崩溃:`systemctl is-active mobile-terminal` → `active`。

- [ ] **Step 6: 提交**

```bash
export HOME=/root
git add server.js
git commit -m "feat: /t/upload accepts any type, 100MB cap, dir/name params, no-clobber

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 客户端通用上传 `uploadFile` + 📎 按钮

**Files:**
- Modify: `public/index.html`（statusbar,`index.html:26` 之后)
- Modify: `public/app.js`（新增 `uploadFile`;重构 `uploadImage`（`app.js:634-655`);新增 📎 绑定)

**Interfaces:**
- Consumes: 泛化后的 `POST /t/upload`（Task 2);现有 `fetchT`、`flashNote`、`send`、`term`、`shrinkImage`。
- Produces: `async uploadFile(file, dir) -> string | null`（成功返回服务端落地路径,失败返回 `null` 并已 `flashNote`)。供 Task 7 面板复用（传 `dir`)。

- [ ] **Step 1: index.html 加 📎 按钮与文件输入**

在 `public/index.html:26`（`<input type="file" id="img-input" …>`)之后插入:

```html
      <button class="sbtn" id="btn-file" title="上传任意文件到终端">📎</button>
      <input type="file" id="file-input" multiple hidden>
```

- [ ] **Step 2: app.js 新增通用 `uploadFile`**

在 `public/app.js` 的 `uploadImage` 定义之前（即 `app.js:634` 上方)插入:

```js
  // 通用上传:任意类型,不再编码。dir 可选(面板传当前浏览目录;终端原生入口省略 → 服务端默认 /root/uploads)。
  // 返回服务端落地路径,失败返回 null(已 flashNote)。
  async function uploadFile(file, dir) {
    if (!file) return null;
    if (file.size > 100 << 20) { flashNote(`文件太大（>100MB）: ${file.name || ''}`); return null; }
    flashNote(`上传中… ${file.name || ''} (${Math.round(file.size / 1024)}KB)`, 120000);
    const qs = new URLSearchParams();
    if (dir) qs.set('dir', dir);
    if (file.name) qs.set('name', file.name);
    const suffix = qs.toString() ? `?${qs}` : '';
    try {
      const r = await fetchT(`/t/upload${suffix}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      }, 120000);
      const m = await r.json().catch(() => ({}));
      if (!r.ok) {
        flashNote(m.error ? `上传失败: ${m.error}` : `上传失败: HTTP ${r.status}（非应用响应，疑似被 Cloudflare 拦截）`, 6000);
        return null;
      }
      return m.path;
    } catch (e) {
      flashNote(e.name === 'AbortError' ? '上传超时，网络太慢' : '上传失败: 网络错误');
      return null;
    }
  }
```

- [ ] **Step 3: 重构 `uploadImage` 复用 `uploadFile`(DRY)**

把 `app.js:634-655` 的 `uploadImage` 函数体替换为（保留图片再编码,发送与插路径委托给 `uploadFile`)：

```js
  async function uploadImage(orig) {
    if (!orig || !orig.type.startsWith('image/')) return;
    flashNote('处理图片中…', 30000);
    const file = await shrinkImage(orig); // 返回 Blob（无 name)→ 服务端按 mime 生成名
    const p = await uploadFile(file, null);
    if (p) { send(p + ' '); flashNote('已插入图片路径'); }
    term.focus();
  }
```

- [ ] **Step 4: app.js 绑定 📎 入口**

在 `app.js:662`（`imgInput.addEventListener('change', …)` 块结束的 `});` )之后插入:

```js
  const fileInput = document.getElementById('file-input');
  document.getElementById('btn-file').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) {
      const p = await uploadFile(f, null);
      if (p) send(p + ' '); // 把落地路径打进终端
    }
    fileInput.value = '';
    term.focus();
  });
```

- [ ] **Step 5: 部署（静态文件,无需重启)+ 浏览器功能验证**

`public/` 是静态文件,服务端每次从磁盘读,直接在已认证的手机浏览器刷新页面即可。验证:
1. 点 📎 → 选一个**非图片**文件(如某个 `.pdf`/`.zip`);
2. 终端提示「上传中…」后光标处出现落地路径,形如 `/root/uploads/<原名>`;
3. 在终端里 `ls -l /root/uploads/` 确认文件存在且大小一致;
4. 回归:📷/📋 图片上传仍照常工作(路径被插入终端)。

- [ ] **Step 6: 提交**

```bash
export HOME=/root
git add public/index.html public/app.js
git commit -m "feat: generic file upload button (📎) reusing uploadFile; images delegate to it

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 下载端点 `GET /t/dl`

**Files:**
- Modify: `server.js`（在 `/t/upload` handler 之后、`/t/open` handler 之前插入)

**Interfaces:**
- Consumes: 现有 `json`、`MIME`、`auth`、`fs`、`path`。
- Produces: `GET /t/dl?path=<绝对路径>` → 流式文件（`Content-Disposition: attachment`);缺 path 400;不存在 404;无权限 403;目录 400。

- [ ] **Step 1: 插入 handler**

在 `server.js` 的 `/t/upload` handler 闭合 `}` 之后（`/t/open` handler 之前)插入:

```js
    if (req.method === 'GET' && url.pathname === '/t/dl') {
      const p = url.searchParams.get('path');
      if (!p) return json(res, 400, { error: 'missing path' });
      let st;
      try { st = await fs.promises.stat(p); }
      catch (e) { return json(res, e.code === 'EACCES' ? 403 : 404, { error: e.code === 'EACCES' ? '无权限读取' : '文件不存在' }); }
      if (st.isDirectory()) return json(res, 400, { error: '不能下载目录' });
      const base = path.basename(p);
      const type = MIME[path.extname(base).toLowerCase()] || 'application/octet-stream';
      // RFC 5987:filename* 兜住中文/空格;ascii filename 作旧浏览器回退
      const asciiName = base.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(base)}`,
        'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(p);
      stream.on('error', () => { if (!res.writableEnded) res.end(); });
      stream.pipe(res);
      console.log(`[${new Date().toISOString()}] ${auth.email} downloaded ${p} (${st.size} bytes)`);
      return;
    }
```

- [ ] **Step 2: 语法检查**

Run: `cd /root/mobile-terminal-web && node --check server.js`
Expected: 无输出（退出码 0)。

- [ ] **Step 3: 重启并做存活验证**

```bash
systemctl restart mobile-terminal
sleep 1
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:7681/t/dl?path=/etc/hostname'
```
Expected: `403`（认证闸,证明路由已挂载)。

- [ ] **Step 4: 浏览器端到端验证**

在已认证浏览器地址栏访问:
1. `https://<主域名>/t/dl?path=/etc/hostname` → 触发下载,文件内容为主机名;
2. `https://<主域名>/t/dl?path=/root`（目录)→ 页面显示 `{"error":"不能下载目录"}`;
3. `https://<主域名>/t/dl?path=/nope` → `{"error":"文件不存在"}`;
4. 上传一个中文名文件后用 `/t/dl?path=…` 下载,确认下载文件名保留中文。

- [ ] **Step 5: 提交**

```bash
export HOME=/root
git add server.js
git commit -m "feat: GET /t/dl streams any readable file as attachment (RFC 5987 filename)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `dl` shell 助手（provision + 当前节点)

**Files:**
- Modify: `scripts/provision-node.sh`（`REMOTE` heredoc 内,`scripts/provision-node.sh:66-…` 之间)
- Create（运行时,在当前节点):`/etc/profile.d/term-dl.sh`

**Interfaces:**
- Produces: 节点 shell 里的 `dl <文件> [更多…]` 函数,对每个文件打印 `https://<主域名>/t/dl?path=<url-encoded 绝对路径>`。主域名从 `/etc/default/mobile-terminal` 的 `MAIN_HOST` 读取(无需模板替换,故可放进被单引号 `'REMOTE'` 包住的 heredoc)。

- [ ] **Step 1: 在当前节点安装助手**

```bash
cat > /etc/profile.d/term-dl.sh <<'DLEOF'
# dl <文件>…：为移动端终端打印可点下载链接
dl() {
  local host
  host=$(sed -n 's/^MAIN_HOST=//p' /etc/default/mobile-terminal 2>/dev/null)
  host=${host:-term.doge-liang-space.uk}
  if [ "$#" -eq 0 ]; then echo "用法: dl <文件> [更多文件…]" >&2; return 2; fi
  local f abs enc
  for f in "$@"; do
    abs=$(realpath -- "$f" 2>/dev/null) || { echo "dl: 找不到 $f" >&2; continue; }
    if [ ! -f "$abs" ]; then echo "dl: 不是普通文件 $abs" >&2; continue; fi
    enc=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$abs")
    echo "https://${host}/t/dl?path=${enc}"
  done
}
DLEOF
chmod 0644 /etc/profile.d/term-dl.sh
```

- [ ] **Step 2: 验证助手（当前 shell 先 source)**

```bash
source /etc/profile.d/term-dl.sh
dl /etc/hostname
```
Expected: 输出一行 `https://term.doge-liang-space.uk/t/dl?path=%2Fetc%2Fhostname`（主域名取自 `/etc/default/mobile-terminal`)。再测 `dl /nope` → stderr `dl: 找不到 /nope`;`dl /root` → stderr `dl: 不是普通文件 /root`。

- [ ] **Step 3: 把同一助手写进 provision 脚本(新节点自带)**

在 `scripts/provision-node.sh` 的 `ssh "$SSH_HOST" "bash -s" <<'REMOTE'`（`scripts/provision-node.sh:66`)块内、`REMOTE` 结束行之前，加入:

```sh
cat > /etc/profile.d/term-dl.sh <<'DLEOF'
# dl <文件>…：为移动端终端打印可点下载链接
dl() {
  local host
  host=$(sed -n 's/^MAIN_HOST=//p' /etc/default/mobile-terminal 2>/dev/null)
  host=${host:-term.doge-liang-space.uk}
  if [ "$#" -eq 0 ]; then echo "用法: dl <文件> [更多文件…]" >&2; return 2; fi
  local f abs enc
  for f in "$@"; do
    abs=$(realpath -- "$f" 2>/dev/null) || { echo "dl: 找不到 $f" >&2; continue; }
    if [ ! -f "$abs" ]; then echo "dl: 不是普通文件 $abs" >&2; continue; fi
    enc=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$abs")
    echo "https://${host}/t/dl?path=${enc}"
  done
}
DLEOF
chmod 0644 /etc/profile.d/term-dl.sh
```

- [ ] **Step 4: 校验脚本语法**

Run: `cd /root/mobile-terminal-web && bash -n scripts/provision-node.sh`
Expected: 无输出（退出码 0)。

- [ ] **Step 5: 提交**

```bash
export HOME=/root
git add scripts/provision-node.sh
git commit -m "feat: dl shell helper prints tap-able download links; provisioned on every node

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

一期完成:上传（📎/📷/📋)与下载（`dl` 打印链接 → 浏览器下载)双向可用。

---

## 二期 — 可视文件浏览面板

### Task 6: 目录列举端点 `GET /t/ls`

**Files:**
- Modify: `server.js`（在 `/t/dl` handler 之后插入)

**Interfaces:**
- Consumes: 现有 `json`、`auth`、`fs`、`path`。
- Produces: `GET /t/ls[?path=<绝对路径>]` → `200 { path, parent, entries: [{ name, type, size, mtime }] }`;`type` ∈ `dir`/`file`/`symlink`;目录优先排序;不存在 404;无权限 403。

- [ ] **Step 1: 插入 handler**

在 `server.js` 的 `/t/dl` handler 闭合之后插入:

```js
    if (req.method === 'GET' && url.pathname === '/t/ls') {
      const p = url.searchParams.get('path') || process.env.HOME || '/root';
      let dirents;
      try { dirents = await fs.promises.readdir(p, { withFileTypes: true }); }
      catch (e) { return json(res, e.code === 'EACCES' ? 403 : 404, { error: e.code === 'EACCES' ? '无权限' : '目录不存在' }); }
      const entries = [];
      for (const d of dirents) {
        const type = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file';
        let size = 0, mtime = 0;
        try { const s = await fs.promises.lstat(path.join(p, d.name)); size = s.size; mtime = s.mtimeMs; }
        catch { /* 单条 stat 失败:保留条目,不整体失败 */ }
        entries.push({ name: d.name, type, size, mtime });
      }
      // 目录优先,其后按名称
      entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir')
        ? (a.name < b.name ? -1 : 1)
        : (a.type === 'dir' ? -1 : 1));
      const parent = path.dirname(p) === p ? p : path.dirname(p); // 根 / 的 parent 为自身
      return json(res, 200, { path: p, parent, entries });
    }
```

- [ ] **Step 2: 语法检查**

Run: `cd /root/mobile-terminal-web && node --check server.js`
Expected: 无输出。

- [ ] **Step 3: 重启并存活验证**

```bash
systemctl restart mobile-terminal
sleep 1
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:7681/t/ls?path=/root'
```
Expected: `403`（认证闸)。

- [ ] **Step 4: 浏览器验证 JSON**

已认证浏览器访问 `https://<主域名>/t/ls?path=/root` → 返回 JSON,确认:目录排在文件前;含 `parent`;访问 `/t/ls?path=/nope` → 404 JSON;`/t/ls?path=/etc/shadow` 的父目录等无权限项返回 403 JSON。

- [ ] **Step 5: 提交**

```bash
export HOME=/root
git add server.js
git commit -m "feat: GET /t/ls lists a directory (dirs-first, graceful perm errors)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: 文件浏览器面板 UI

**Files:**
- Modify: `public/index.html`（statusbar 加 📁 按钮;`#session-panel` 之后加 `#file-panel` 抽屉)
- Modify: `public/app.js`（面板逻辑)
- Modify: `public/style.css`（少量 `.fp-*` 补充,复用 `.sp-*`)

**Interfaces:**
- Consumes: `GET /t/ls`（Task 6)、`GET /t/dl`（Task 4)、`uploadFile(file, dir)`（Task 3);现有 `.sp-*` 样式、`fetchT`、抽屉 `hidden` 切换模式。

- [ ] **Step 1: index.html 加 📁 按钮**

在 `public/index.html` 的 `<button class="sbtn" id="btn-session" …>`（`index.html:30`)之前插入:

```html
      <button class="sbtn" id="btn-files" title="文件浏览器">📁</button>
```

- [ ] **Step 2: index.html 加 `#file-panel` 抽屉**

在 `#session-panel` 抽屉整块（`index.html:54` 起的 `<div id="session-panel" hidden>…</div>`)之后插入:

```html
  <div id="file-panel" hidden>
    <div class="sp-box">
      <div class="sp-head">
        <span id="fp-path" class="fp-path">~</span>
        <button id="fp-close" class="sp-x" title="关闭">✕</button>
      </div>
      <div class="sp-section sp-newrow">
        <button id="fp-up">⬆ 上级</button>
        <button id="fp-upload">⬆ 上传到此目录</button>
        <input type="file" id="fp-input" multiple hidden>
      </div>
      <div class="sp-section">
        <div id="fp-list"></div>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: style.css 补充**

在 `public/style.css` 末尾追加:

```css
#file-panel {
  position: fixed; inset: 0; z-index: 20;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: flex-end; justify-content: center;
}
#file-panel[hidden] { display: none; }
.fp-path { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; }
.fp-row { display: flex; align-items: center; }
```

（`.sp-box`/`.sp-head`/`.sp-section`/`.sp-newrow`/`.sp-x` 直接复用会话面板样式。)

- [ ] **Step 4: app.js 面板逻辑**

在 `public/app.js` 会话面板逻辑之后（文件末尾的 IIFE 闭合之前)插入:

```js
  // --- 文件浏览器面板 ---
  const filePanel = document.getElementById('file-panel');
  const fpPath = document.getElementById('fp-path');
  const fpList = document.getElementById('fp-list');
  const fpInput = document.getElementById('fp-input');
  let fpCwd = null; // 当前浏览目录（绝对路径)

  function fmtSize(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1048576) return `${Math.round(n / 1024)}K`;
    return `${(n / 1048576).toFixed(1)}M`;
  }

  async function fpLoad(dir) {
    fpList.innerHTML = '<div class="sp-empty">加载中…</div>';
    const url = dir ? `/t/ls?path=${encodeURIComponent(dir)}` : '/t/ls';
    let data;
    try {
      const r = await fetchT(url, {}, 8000);
      data = await r.json().catch(() => ({}));
      if (!r.ok) { fpList.innerHTML = `<div class="sp-empty">${data.error || `HTTP ${r.status}`}</div>`; return; }
    } catch { fpList.innerHTML = '<div class="sp-empty">网络错误</div>'; return; }

    fpCwd = data.path;
    fpPath.textContent = data.path;
    fpPath.dataset.parent = data.parent;
    fpList.innerHTML = '';
    if (!data.entries.length) { fpList.innerHTML = '<div class="sp-empty">（空目录）</div>'; }
    for (const e of data.entries) {
      const row = document.createElement('div');
      row.className = 'sp-row fp-row';
      const pick = document.createElement('button');
      pick.className = 'sp-pick';
      const icon = e.type === 'dir' ? '📁' : e.type === 'symlink' ? '🔗' : '📄';
      const meta = e.type === 'dir' ? '' : `<span class="sp-meta">${fmtSize(e.size)}</span>`;
      pick.innerHTML = `<span class="sp-name">${icon} ${e.name}</span>${meta}`;
      const abs = (fpCwd.endsWith('/') ? fpCwd : fpCwd + '/') + e.name;
      if (e.type === 'dir') {
        pick.addEventListener('click', () => fpLoad(abs));
      } else {
        // 文件:导航到 /t/dl 触发系统下载
        pick.addEventListener('click', () => { window.location.href = `/t/dl?path=${encodeURIComponent(abs)}`; });
      }
      row.appendChild(pick);
      fpList.appendChild(row);
    }
  }

  document.getElementById('btn-files').addEventListener('click', () => { filePanel.hidden = false; fpLoad(null); });
  document.getElementById('fp-close').addEventListener('click', () => { filePanel.hidden = true; });
  filePanel.addEventListener('click', (e) => { if (e.target === filePanel) filePanel.hidden = true; });
  document.getElementById('fp-up').addEventListener('click', () => { const par = fpPath.dataset.parent; if (par) fpLoad(par); });
  document.getElementById('fp-upload').addEventListener('click', () => fpInput.click());
  fpInput.addEventListener('change', async () => {
    for (const f of fpInput.files) await uploadFile(f, fpCwd); // 落到当前浏览目录
    fpInput.value = '';
    fpLoad(fpCwd); // 刷新
  });
```

- [ ] **Step 5: 浏览器功能验证（静态文件,刷新即可)**

1. 点 📁 → 面板打开,列出 `HOME` 内容,目录在前;
2. 点目录进入,点「⬆ 上级」返回;路径栏显示当前绝对路径;
3. 点某文件 → 浏览器下载该文件;
4. 点「⬆ 上传到此目录」选文件 → 上传后列表出现新文件,且落在当前目录(在终端 `ls` 佐证);
5. 进入无权限目录(如 `/root/../etc` 下某受限项)→ 列表区显示错误文案,不白屏。

- [ ] **Step 6: 提交**

```bash
export HOME=/root
git add public/index.html public/app.js public/style.css
git commit -m "feat: file browser panel (📁) — navigate, download, upload to current dir

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

二期完成:可视文件浏览、下载、上传到指定目录。

---

## Self-Review

**Spec coverage（逐节对照 spec):**
- §4.1 泛化上传（任意类型/100MB/dir·name/不覆盖/legacy 兼容)→ Task 2 ✓（legacy 由「无 dir → UPLOAD_DIR」+「无 name → 生成名」覆盖)。
- §4.2 `/t/dl`（404/400/403 分支、RFC 5987、流式)→ Task 4 ✓。
- §4.3 `/t/ls`（type、目录优先、默认 HOME、graceful、根 parent)→ Task 6 ✓。
- §5.1 终端原生上传（uploadFile、📎、图片复用)→ Task 3 ✓。
- §5.2 `dl` 助手（provision + 当前节点、URL-encode、主域名)→ Task 5 ✓。
- §5.3 面板（面包屑/列表/上级/上传到当前)→ Task 7 ✓。
- §6 分期 → 一期 Task 1-5,二期 Task 6-7 ✓。
- §7 安全（basename 消毒、不 jail、100MB、symlink 用 lstat)→ Task 1/2/4/6 ✓。
- §8/§9 测试与边界（同名追加、dir 不可写 4xx、下载目录 400、中文名、ls 单条失败跳过)→ 各任务验证步骤 ✓。

**Placeholder scan:** 无 TBD/TODO;每个代码步骤含完整代码;验证步骤含具体命令与期望输出。

**Type consistency:** `safeBasename`/`uniqueName` 在 Task 1 定义、Task 2 消费,签名一致;`uploadFile(file, dir)` Task 3 定义、Task 7 消费,签名一致;`/t/ls` 返回的 `{path,parent,entries[{name,type,size,mtime}]}` 与 Task 7 渲染字段一致;`/t/dl?path=` 查询参数在 Task 4/5/7 一致。
