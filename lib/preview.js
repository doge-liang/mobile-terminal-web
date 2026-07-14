'use strict';
const path = require('path');

// 预览体积上限:超过则前端回落为下载,避免把大文件灌进手机内存。
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024; // 2MB

// Markdown 扩展名 → 渲染
const MARKDOWN_EXT = new Set(['.md', '.markdown']);

// 视为纯文本、可在页面内只读展示的扩展名白名单（不做语法高亮）。
const TEXT_EXT = new Set([
  '.txt', '.log', '.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg',
  '.sh', '.bash', '.zsh', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.py', '.rb', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.java',
  '.css', '.scss', '.less', '.html', '.xml', '.sql', '.csv',
]);

// 按文件名判定预览类型:'markdown' | 'text' | 'download'。
// 未知扩展名一律 'download'（交给系统下载,不猜内容)。
function classifyPreview(name) {
  if (typeof name !== 'string') return 'download';
  const ext = path.extname(name).toLowerCase();
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'download';
}

// 二进制探测:在给定 buffer（通常是文件前若干 KB)里找 NUL 字节。
// 含 NUL 视为二进制 → 不在页面内当文本展示。
function looksBinary(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

module.exports = { PREVIEW_MAX_BYTES, MARKDOWN_EXT, TEXT_EXT, classifyPreview, looksBinary };
