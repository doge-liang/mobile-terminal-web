# 分片上传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让超过代理层 1MB 单请求上限的文件通过 512KB 分片顺序上传,服务端拼接落地。

**Architecture:** 客户端把大文件按 512KB 切片顺序 POST 到新端点 `/t/upload-chunk`,服务端以 `.part` 临时文件顺序 append、靠已落盘大小校验 offset,累计达总长时沿用现有定名逻辑 rename 落地。核心决策逻辑抽为 `lib/chunk-upload.js` 的纯函数以便单测;HTTP 处理器只做 IO 编排。小文件(≤512KB)仍走现有 `/t/upload` 单请求,零回归。

**Tech Stack:** Node.js `http` + `fs`(无新依赖)、浏览器 `fetch` + `Blob.slice` + `crypto.getRandomValues`、`node:test` 单测。

## Global Constraints

- 分片大小常量 `CHUNK_SIZE = 512 * 1024`(字节),客户端与服务端必须一致。
- 文件总大小仍受 `UPLOAD_MAX = 100 << 20`(100MB)限制。
- 不引入新 npm 依赖。
- 上传标识 `id` 必须匹配 `^[a-f0-9]{8,64}$`(防路径穿越)。
- 错误响应沿用现有中文 JSON 风格:`json(res, code, { error })`。
- 无跨页面刷新断点续传;本会话内每片最多重试 2 次,整体失败即报错。
- 提交信息结尾附:`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`;git 操作前 `export HOME=/root`。

---

## File Structure

- `lib/chunk-upload.js`(**新建**):纯函数 `isValidUploadId`、`finalName`、`planChunk`。无 IO,全部可单测。
- `test/chunk-upload.test.js`(**新建**):上述三个纯函数的 `node:test` 用例。
- `package.json`(**修改**):新增 `"test": "node --test"` 脚本。
- `server.js`(**修改**):新增 `PARTS_DIR` 常量与 `mkdirSync`;把 `/t/upload` 的定名逻辑改用 `finalName`;新增 `/t/upload-chunk` 处理器;每小时清扫扩展到 `.parts`。
- `public/app.js`(**修改**):新增 `CHUNK_SIZE`、`randomId`、`uploadChunked`;`uploadFile` 按大小分流。

---

## Task 1: 纯函数与单测(`lib/chunk-upload.js`)

**Files:**
- Create: `lib/chunk-upload.js`
- Create: `test/chunk-upload.test.js`
- Modify: `package.json`(新增 test 脚本)

**Interfaces:**
- Consumes: `./upload-paths` 的 `safeBasename(name) -> string|null`、`uniqueName(base, taken) -> string`。
- Produces:
  - `isValidUploadId(id) -> boolean`
  - `finalName({ name, generatedBase, taken }) -> string` —— `name` 为客户端名(可空/非法),`generatedBase` 为调用方预生成的兜底名,`taken(candidate) -> boolean` 判重谓词。
  - `planChunk({ have, offset, chunkLen, total, final }) -> { action, expected?, received? }`,`action ∈ 'conflict' | 'exceeds' | 'corrupt' | 'finalize' | 'continue'`。

- [ ] **Step 1: 写失败测试 `test/chunk-upload.test.js`**

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isValidUploadId, finalName, planChunk } = require('../lib/chunk-upload');

test('isValidUploadId 接受合法 hex', () => {
  assert.strictEqual(isValidUploadId('a1b2c3d4'), true);          // 8 位下限
  assert.strictEqual(isValidUploadId('f'.repeat(64)), true);      // 64 位上限
});

test('isValidUploadId 拒绝非法输入', () => {
  assert.strictEqual(isValidUploadId(''), false);
  assert.strictEqual(isValidUploadId('abc'), false);             // 不足 8 位
  assert.strictEqual(isValidUploadId('A1B2C3D4'), false);        // 大写不在 [a-f0-9]
  assert.strictEqual(isValidUploadId('../../etc'), false);
  assert.strictEqual(isValidUploadId('a1b2c3d4/x'), false);
  assert.strictEqual(isValidUploadId('f'.repeat(65)), false);    // 超长
  assert.strictEqual(isValidUploadId(null), false);
});

test('finalName 用客户端名并去重', () => {
  const taken = new Set(['a.txt']);
  assert.strictEqual(
    finalName({ name: 'a.txt', generatedBase: 'g.bin', taken: (n) => taken.has(n) }),
    'a (1).txt',
  );
});

test('finalName 无名回退到生成名', () => {
  assert.strictEqual(
    finalName({ name: null, generatedBase: 'g.bin', taken: () => false }),
    'g.bin',
  );
});

test('finalName 非法名回退到生成名', () => {
  assert.strictEqual(
    finalName({ name: '..', generatedBase: 'g.bin', taken: () => false }),
    'g.bin',
  );
});

test('finalName 剥离目录成分后再用', () => {
  assert.strictEqual(
    finalName({ name: 'a/b/c.txt', generatedBase: 'g.bin', taken: () => false }),
    'c.txt',
  );
});

test('planChunk offset 不符判 conflict 并带 expected', () => {
  assert.deepStrictEqual(
    planChunk({ have: 1024, offset: 0, chunkLen: 512, total: 4096, final: false }),
    { action: 'conflict', expected: 1024 },
  );
});

test('planChunk 中间片判 continue', () => {
  assert.deepStrictEqual(
    planChunk({ have: 0, offset: 0, chunkLen: 512, total: 4096, final: false }),
    { action: 'continue', received: 512 },
  );
});

test('planChunk 越界判 exceeds', () => {
  assert.deepStrictEqual(
    planChunk({ have: 4000, offset: 4000, chunkLen: 512, total: 4096, final: false }),
    { action: 'exceeds' },
  );
});

test('planChunk 末片补齐总长判 finalize', () => {
  assert.deepStrictEqual(
    planChunk({ have: 3584, offset: 3584, chunkLen: 512, total: 4096, final: true }),
    { action: 'finalize', received: 4096 },
  );
});

test('planChunk 累计达总长即使未标 final 也判 finalize', () => {
  assert.deepStrictEqual(
    planChunk({ have: 3584, offset: 3584, chunkLen: 512, total: 4096, final: false }),
    { action: 'finalize', received: 4096 },
  );
});

test('planChunk 标了 final 但长度不足判 corrupt', () => {
  assert.deepStrictEqual(
    planChunk({ have: 0, offset: 0, chunkLen: 512, total: 4096, final: true }),
    { action: 'corrupt', received: 512 },
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/chunk-upload.test.js`
Expected: FAIL(`Cannot find module '../lib/chunk-upload'`)。

- [ ] **Step 3: 写 `lib/chunk-upload.js`**

```javascript
'use strict';
const { safeBasename, uniqueName } = require('./upload-paths');

const UPLOAD_ID_RE = /^[a-f0-9]{8,64}$/;

// 上传标识白名单校验:仅小写 hex,8-64 位。杜绝 .part 路径被穿越操纵。
function isValidUploadId(id) {
  return typeof id === 'string' && UPLOAD_ID_RE.test(id);
}

// 从客户端名(可空/含目录/非法)与兜底生成名里,定出不冲突的最终落地名。
// safeBasename 会剥离目录成分并在无法收敛时返回 null,此时用 generatedBase。
function finalName({ name, generatedBase, taken }) {
  const safe = name ? safeBasename(name) : null;
  const base = safe || generatedBase;
  return uniqueName(base, taken);
}

// 顺序拼接的核心决策:仅凭已落盘大小 have 判断本片该怎么处理,不做任何 IO。
// have !== offset  → 乱序/重发,让客户端据 expected 校正
// received > total → 越界,视为损坏
// 收尾(标了 final 或累计达 total)时长度必须正好等于 total,否则 corrupt
function planChunk({ have, offset, chunkLen, total, final }) {
  if (have !== offset) return { action: 'conflict', expected: have };
  const received = offset + chunkLen;
  if (received > total) return { action: 'exceeds' };
  const done = final || received >= total;
  if (done && received !== total) return { action: 'corrupt', received };
  return { action: done ? 'finalize' : 'continue', received };
}

module.exports = { isValidUploadId, finalName, planChunk };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/chunk-upload.test.js`
Expected: PASS,全部用例绿。

- [ ] **Step 5: 加 `package.json` test 脚本**

把 `scripts` 段改为:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
```

- [ ] **Step 6: 跑全量测试确认不回归**

Run: `npm test`
Expected: PASS,`test/upload-paths.test.js` 与 `test/chunk-upload.test.js` 全绿。

- [ ] **Step 7: 提交**

```bash
export HOME=/root
git add lib/chunk-upload.js test/chunk-upload.test.js package.json
git commit -m "feat: 分片上传纯函数(id 校验/定名/顺序决策)与单测

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 服务端端点(`server.js`)

**Files:**
- Modify: `server.js`(顶部常量与 `mkdirSync` 约 239-243 行;`/t/upload` 定名逻辑约 448-453 行;每小时清扫约 244-256 行;新增 `/t/upload-chunk` 处理器,插在 `/t/upload` 处理器之后约 466 行)

**Interfaces:**
- Consumes: Task 1 的 `isValidUploadId`、`finalName`、`planChunk`;现有 `readBodyRaw(req, limit)`、`json(res, code, obj)`、`IMG_EXT`、`UPLOAD_DIR`、`UPLOAD_MAX`、`UPLOAD_KEEP_MS`、`crypto`、`verifyAuth`(处理器入口已有 `auth`)。
- Produces: HTTP 端点 `POST /t/upload-chunk`,响应 `{ ok, received }` / `{ path }` / `{ error, expected? }`。

- [ ] **Step 1: 引入 Task 1 的纯函数与常量**

在 `server.js` 顶部,把第 8 行的 require 改为同时引入两个模块并加分片常量。第 8 行现为:

```javascript
const { safeBasename, uniqueName } = require('./lib/upload-paths');
```

改为:

```javascript
const { safeBasename, uniqueName } = require('./lib/upload-paths');
const { isValidUploadId, finalName, planChunk } = require('./lib/chunk-upload');
```

并在 `UPLOAD_MAX` 定义行(约 240 行 `const UPLOAD_MAX = 100 << 20;`)之后新增:

```javascript
const CHUNK_SIZE = 512 * 1024;                 // 必须与 public/app.js 一致
const PARTS_DIR = path.join(UPLOAD_DIR, '.parts');
```

- [ ] **Step 2: 创建 `.parts` 目录**

第 243 行现为:

```javascript
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
```

改为:

```javascript
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PARTS_DIR, { recursive: true });
```

- [ ] **Step 3: `/t/upload` 定名逻辑改用 `finalName`(去重复,零行为变化)**

`/t/upload` 处理器里现有(约 448-457 行):

```javascript
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
```

改为(用 `finalName` 统一定名):

```javascript
      const ext = IMG_EXT[mime] || 'bin';
      const generatedBase = `paste-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.${ext}`;

      let final;
      try {
        final = finalName({
          name: url.searchParams.get('name'),
          generatedBase,
          taken: (n) => fs.existsSync(path.join(destDir, n)),
        });
        await fs.promises.writeFile(path.join(destDir, final), buf);
```

- [ ] **Step 4: 新增 `/t/upload-chunk` 处理器**

紧接 `/t/upload` 处理器闭合的 `}` 之后(约 466 行,`/t/dl` 处理器之前)插入:

```javascript
    if (req.method === 'POST' && url.pathname === '/t/upload-chunk') {
      const id = url.searchParams.get('id') || '';
      if (!isValidUploadId(id)) return json(res, 400, { error: 'bad upload id' });
      const total = parseInt(url.searchParams.get('total'), 10) || 0;
      const offset = parseInt(url.searchParams.get('offset'), 10);
      if (total <= 0 || !(offset >= 0)) return json(res, 400, { error: 'bad total/offset' });
      if (total > UPLOAD_MAX) {
        console.log(`[upload-chunk] rejected: ${Math.round(total / 1048576)}MB > 100MB from ${auth.email}`);
        return json(res, 413, { error: `文件太大: ${Math.round(total / 1048576)}MB (上限 100MB)` });
      }

      const partPath = path.join(PARTS_DIR, `${id}.part`);
      let have = 0;
      try { have = (await fs.promises.stat(partPath)).size; } catch { have = 0; }

      // 先读本片(限 CHUNK_SIZE + 余量;中途超限即 413)
      let buf;
      try { buf = await readBodyRaw(req, CHUNK_SIZE + 4096); } catch {
        return json(res, 413, { error: '分片过大' });
      }
      if (!buf.length) return json(res, 400, { error: 'empty chunk' });

      const final = url.searchParams.get('final') === '1';
      const plan = planChunk({ have, offset, chunkLen: buf.length, total, final });
      if (plan.action === 'conflict') return json(res, 409, { error: 'chunk out of order', expected: plan.expected });
      if (plan.action === 'exceeds' || plan.action === 'corrupt') {
        fs.promises.unlink(partPath).catch(() => {});
        return json(res, 400, { error: '分片数据损坏(长度不符)' });
      }

      try {
        await fs.promises.appendFile(partPath, buf);
      } catch (e) {
        console.log(`[upload-chunk] append failed: ${e.message}`);
        return json(res, 500, { error: '写入分片失败' });
      }

      if (plan.action === 'continue') return json(res, 200, { ok: true, received: plan.received });

      // finalize:定名并把 .part 挪到目标目录(跨盘时回退 copy+unlink)
      const mime = (req.headers['content-type'] || '').split(';')[0].trim();
      const destDir = url.searchParams.get('dir') || UPLOAD_DIR;
      const ext = IMG_EXT[mime] || 'bin';
      const generatedBase = `paste-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
      let name;
      try {
        name = finalName({
          name: url.searchParams.get('name'),
          generatedBase,
          taken: (n) => fs.existsSync(path.join(destDir, n)),
        });
        const destPath = path.join(destDir, name);
        try {
          await fs.promises.rename(partPath, destPath);
        } catch (e) {
          if (e.code === 'EXDEV') {                        // 临时文件与目标不同挂载点
            await fs.promises.copyFile(partPath, destPath);
            await fs.promises.unlink(partPath);
          } else { throw e; }
        }
      } catch (e) {
        fs.promises.unlink(partPath).catch(() => {});
        console.log(`[upload-chunk] finalize failed dir="${destDir}": ${e.message}`);
        return json(res, 400, { error: `无法写入目录: ${destDir}（不存在或无权限）` });
      }
      const dest = path.join(destDir, name);
      console.log(`[${new Date().toISOString()}] ${auth.email} uploaded ${dest} (${total} bytes, chunked)`);
      return json(res, 200, { path: dest });
    }
```

- [ ] **Step 5: 每小时清扫扩展到 `.parts`**

清扫定时器里(约 244-251 行)现为:

```javascript
setInterval(() => {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return;
    for (const f of files) {
      const p = path.join(UPLOAD_DIR, f);
      fs.stat(p, (e, st) => { if (!e && Date.now() - st.mtimeMs > UPLOAD_KEEP_MS) fs.unlink(p, () => {}); });
    }
  });
```

在内层 `fs.readdir(UPLOAD_DIR, ...)` 回调之后、`// rotate the metrics log` 之前,新增对 `.parts` 的清扫:

```javascript
  fs.readdir(PARTS_DIR, (err, files) => {
    if (err) return;
    for (const f of files) {
      const p = path.join(PARTS_DIR, f);
      fs.stat(p, (e, st) => { if (!e && Date.now() - st.mtimeMs > UPLOAD_KEEP_MS) fs.unlink(p, () => {}); });
    }
  });
```

- [ ] **Step 6: 语法自检**

Run: `node --check server.js`
Expected: 无输出(语法通过)。

- [ ] **Step 7: 本地起服务并用 curl 端到端验证**

本地无 `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` 时鉴权自动放行(`email: 'local-dev'`),无需 cookie。

后台起服务(需已装 tmux):

```bash
cd /root/mobile-terminal-web && node server.js &
sleep 1
```

造一个 1MB 的测试文件(> CHUNK_SIZE,需两片),分两片上传到临时目录:

```bash
mkdir -p /root/.claude/jobs/75132a7a/tmp/chunkdst
head -c 1048576 /dev/urandom > /root/.claude/jobs/75132a7a/tmp/src.bin
ID=$(head -c 8 /dev/urandom | xxd -p)          # 16 位 hex
DST=/root/.claude/jobs/75132a7a/tmp/chunkdst
head -c 524288 /root/.claude/jobs/75132a7a/tmp/src.bin > /root/.claude/jobs/75132a7a/tmp/c0.bin
tail -c 524288 /root/.claude/jobs/75132a7a/tmp/src.bin > /root/.claude/jobs/75132a7a/tmp/c1.bin
# 片 0(offset 0,continue)
curl -s "http://127.0.0.1:7681/t/upload-chunk?id=$ID&total=1048576&offset=0&name=src.bin&dir=$DST" \
  -H 'Content-Type: application/octet-stream' --data-binary @/root/.claude/jobs/75132a7a/tmp/c0.bin
echo
# 片 1(offset 524288,final)
curl -s "http://127.0.0.1:7681/t/upload-chunk?id=$ID&total=1048576&offset=524288&final=1&name=src.bin&dir=$DST" \
  -H 'Content-Type: application/octet-stream' --data-binary @/root/.claude/jobs/75132a7a/tmp/c1.bin
echo
```

Expected:
- 第一条响应 `{"ok":true,"received":524288}`。
- 第二条响应 `{"path":"/root/.claude/jobs/75132a7a/tmp/chunkdst/src.bin"}`。

校验落地文件与源一致,并确认 `.part` 已清走:

```bash
cmp /root/.claude/jobs/75132a7a/tmp/src.bin "$DST/src.bin" && echo "SAME"
ls /root/uploads/.parts/    # 应为空
```

Expected: 打印 `SAME`;`.parts` 目录为空。

顺带验证乱序保护(错误 offset 应得 409 带 expected):

```bash
ID2=$(head -c 8 /dev/urandom | xxd -p)
curl -s "http://127.0.0.1:7681/t/upload-chunk?id=$ID2&total=1048576&offset=999&name=x.bin&dir=$DST" \
  -H 'Content-Type: application/octet-stream' --data-binary @/root/.claude/jobs/75132a7a/tmp/c0.bin
echo
```

Expected: `{"error":"chunk out of order","expected":0}`。

关掉后台服务:

```bash
kill %1 2>/dev/null
```

- [ ] **Step 8: 提交**

```bash
export HOME=/root
git add server.js
git commit -m "feat: 服务端 /t/upload-chunk 分片端点(顺序 append + 落地)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 客户端分片上传(`public/app.js`)

**Files:**
- Modify: `public/app.js`(在 `uploadFile` 之前新增 `CHUNK_SIZE`/`randomId`/`uploadChunked`;改 `uploadFile` 约 655-679 行加分流)

**Interfaces:**
- Consumes: Task 2 的 `POST /t/upload-chunk`;现有 `fetchT(url, opts, ms)`、`flashNote(text, ms)`。
- Produces: `uploadFile(file, dir)` 对外契约不变(返回落地 `path` 字符串或 `null`),调用方(`btn-file`/`btn-img`/面板)无需改动。

- [ ] **Step 1: 在 `uploadFile` 之前新增分片常量与函数**

在 `// 通用上传:任意类型...` 注释(约 653 行)之前插入:

```javascript
  // 部署所在网络的代理层把单次请求体卡在 1MB,超过就在浏览器里表现为不透明的
  // "网络错误"。大文件按 512KB 切片顺序上传,服务端拼接。CHUNK_SIZE 必须与
  // server.js 保持一致。
  const CHUNK_SIZE = 512 * 1024;

  function randomId() {
    const a = new Uint8Array(8);                 // 16 位 hex,落在服务端 [a-f0-9]{8,64}
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // 顺序分片上传。成功返回服务端落地 path,失败 flashNote 并返回 null。
  // offset 由客户端推进;若服务端回 409(乱序/重发),据 expected 校正后继续。
  async function uploadChunked(file, dir) {
    const id = randomId();
    const total = file.size;
    const N = Math.max(1, Math.ceil(total / CHUNK_SIZE));
    const base = new URLSearchParams({ id, total: String(total) });
    if (dir) base.set('dir', dir);
    if (file.name) base.set('name', file.name);

    let offset = 0;
    let fails = 0;
    while (offset < total) {
      const end = Math.min(offset + CHUNK_SIZE, total);
      const isFinal = end >= total;
      const idx = Math.floor(offset / CHUNK_SIZE) + 1;
      flashNote(`上传中… ${file.name || ''} (${idx}/${N})`, 120000);
      const qs = new URLSearchParams(base);
      qs.set('offset', String(offset));
      if (isFinal) qs.set('final', '1');
      try {
        const r = await fetchT(`/t/upload-chunk?${qs}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file.slice(offset, end),
        }, 60000);
        const m = await r.json().catch(() => ({}));
        if (r.status === 409 && typeof m.expected === 'number') {
          offset = m.expected; fails = 0; continue;      // 据服务端已有大小校正
        }
        if (!r.ok) {
          if (++fails <= 2) continue;                    // 同片最多重试 2 次
          flashNote(m.error ? `上传失败: ${m.error}` : `上传失败: HTTP ${r.status}`, 6000);
          return null;
        }
        if (isFinal) return m.path || null;
        offset = end; fails = 0;
      } catch (e) {
        if (++fails <= 2) continue;
        flashNote(e.name === 'AbortError' ? '上传超时，网络太慢' : '上传失败: 网络错误');
        return null;
      }
    }
    return null;                                          // 正常不会到这(末片已 return)
  }
```

- [ ] **Step 2: `uploadFile` 加大小分流**

`uploadFile` 开头(约 655-658 行)现为:

```javascript
  async function uploadFile(file, dir) {
    if (!file) return null;
    if (file.size > 100 << 20) { flashNote(`文件太大（>100MB）: ${file.name || ''}`); return null; }
    flashNote(`上传中… ${file.name || ''} (${Math.round(file.size / 1024)}KB)`, 120000);
```

在 100MB 上限判断之后、`flashNote` 之前插入分流:

```javascript
  async function uploadFile(file, dir) {
    if (!file) return null;
    if (file.size > 100 << 20) { flashNote(`文件太大（>100MB）: ${file.name || ''}`); return null; }
    if (file.size > CHUNK_SIZE) return uploadChunked(file, dir);   // 超单请求上限走分片
    flashNote(`上传中… ${file.name || ''} (${Math.round(file.size / 1024)}KB)`, 120000);
```

- [ ] **Step 3: 语法自检**

Run: `node --check public/app.js`
Expected: 无输出。

> 说明:`app.js` 在浏览器里运行,但 `node --check` 只做语法解析,不需要浏览器全局对象,足以捕获括号/语法错误。

- [ ] **Step 4: 本地起服务,浏览器端到端验证**

```bash
cd /root/mobile-terminal-web && node server.js &
sleep 1
```

用无头方式验证:打开 `http://127.0.0.1:7681/`,通过"文件"按钮选一个 >512KB 的文件上传,预期终端里插入落地路径、`flashNote` 依次显示 `(1/N)…(N/N)`。若无法交互式操作浏览器,退而用 Step 7(Task 2)的 curl 两片流程再跑一遍确认服务端未因客户端改动而回归(客户端改动不影响服务端,主要确认协议参数一致)。

比对上传前后文件字节一致:

```bash
# 选一个已知源文件上传后,cmp 源与落地文件
cmp <源文件> <落地路径> && echo "SAME"
kill %1 2>/dev/null
```

Expected: `SAME`。

- [ ] **Step 5: 提交**

```bash
export HOME=/root
git add public/app.js
git commit -m "feat: 客户端大文件分片上传(>512KB 走 /t/upload-chunk)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review 结论

- **Spec 覆盖**:分流(§4)→ Task 3 Step 2;分片大小(§5)→ Global Constraints + 各 Task 常量;协议(§6)→ Task 2 Step 4;服务端拼接方案 A(§7)→ Task 2 Step 4 + `planChunk`;客户端流程(§8)→ Task 3 Step 1;代码组织(§9)→ Task 1;测试(§10)→ Task 1;部署(§11)→ `PARTS_DIR` 自建(Task 2 Step 2)。EXDEV 跨盘回退为计划期新增的实现细节(§7 rename 的健壮化),已在 Task 2 Step 4 落实。
- **占位符**:无 TBD/TODO,所有代码步骤含完整代码。
- **类型一致**:`isValidUploadId`/`finalName`/`planChunk` 的签名在 Task 1 定义、Task 2 消费,参数名与返回结构一致;`CHUNK_SIZE = 512*1024` 在服务端与客户端两处字面量相同。
