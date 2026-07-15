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

// 图片:预览层内用 <img> 显示(不读正文)
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const PREVIEW_IMG_MAX = 10 * 1024 * 1024; // 图片预览体积上限 10MB

// 按文件名判定预览类型:'markdown' | 'image' | 'text' | 'download'。
// 未知扩展名一律 'download'（交给系统下载,不猜内容)。
function classifyPreview(name) {
  if (typeof name !== 'string') return 'download';
  const ext = path.extname(name).toLowerCase();
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (IMAGE_EXT.has(ext)) return 'image';
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

module.exports = { PREVIEW_MAX_BYTES, PREVIEW_IMG_MAX, MARKDOWN_EXT, TEXT_EXT, IMAGE_EXT, classifyPreview, looksBinary };
