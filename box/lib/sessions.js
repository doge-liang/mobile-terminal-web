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

function firstLine(file, max = 8192) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    const s = buf.slice(0, n).toString('utf8');
    const i = s.indexOf('\n');
    return i === -1 ? s : s.slice(0, i);
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
          try { cwd = findCwd(JSON.parse(firstLine(f))); } catch { /* 首行非 JSON:跳过 */ }
          if (cwd && matchesBox(cwd, boxPath)) out.push(f); // codex 风格:单文件
        }
      }
    }
  }
  return out;
}

module.exports = { findCwd, matchesBox, collectSessionSlices };
