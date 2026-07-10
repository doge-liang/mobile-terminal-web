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
