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
