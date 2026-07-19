'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOTS = ['/root/.codex/sessions', '/root/.grok/sessions'];

// 会话文件头部元数据里递归找 cwd(codex 在 payload.cwd;容错其它嵌套,宁缺勿错)
function findCwd(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (typeof value.cwd === 'string') return value.cwd;
  for (const k of Object.keys(value)) {
    const f = findCwd(value[k], depth + 1);
    if (f) return f;
  }
  return null;
}

function matchesBox(cwd, boxPath) {
  return cwd === boxPath || cwd.startsWith(boxPath + '/');
}

// 读完整首行(codex 首行含 base_instructions,常超 8KB);超过 maxBytes 视为无法判定,宁缺勿错
function firstLine(file, maxBytes = 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(65536);
    const parts = [];
    let pos = 0;
    while (pos < maxBytes) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      const nl = chunk.subarray(0, n).indexOf(0x0a);
      if (nl !== -1) {
        parts.push(Buffer.from(chunk.subarray(0, nl)));
        return Buffer.concat(parts).toString('utf8');
      }
      parts.push(Buffer.from(chunk.subarray(0, n)));
      pos += n;
    }
    if (pos >= maxBytes) return null; // 超限:放弃该文件(宁缺勿错)
    return Buffer.concat(parts).toString('utf8'); // 无换行的单行文件
  } finally { fs.closeSync(fd); }
}

function* walkFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else if (e.isFile()) yield p;
  }
}

// grok 会话按 URL 编码的 cwd 分目录;codex 按日期分目录、首行 JSON 带 cwd
function collectSessionSlices(boxPath, roots = DEFAULT_ROOTS) {
  const out = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) {
        let decoded = null;
        try { decoded = decodeURIComponent(e.name); } catch { /* 非编码目录名 */ }
        if (decoded && decoded.startsWith('/') && matchesBox(decoded, boxPath)) {
          out.push(path.join(root, e.name)); // grok 风格:整目录
          continue;
        }
        for (const f of walkFiles(path.join(root, e.name))) {
          if (!f.endsWith('.jsonl')) continue;
          let cwd = null;
          const line = firstLine(f);
          if (line) {
            try { cwd = findCwd(JSON.parse(line)); } catch { /* 非 JSON 首行:跳过 */ }
          }
          if (cwd && matchesBox(cwd, boxPath)) out.push(f); // codex 风格:单文件
        }
      }
    }
  }
  return out;
}

module.exports = { findCwd, matchesBox, collectSessionSlices };
