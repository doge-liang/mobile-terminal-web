'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifyPreview, looksBinary, PREVIEW_MAX_BYTES } = require('../lib/preview');

test('classifyPreview 识别 markdown（大小写不敏感）', () => {
  assert.strictEqual(classifyPreview('README.md'), 'markdown');
  assert.strictEqual(classifyPreview('a.markdown'), 'markdown');
  assert.strictEqual(classifyPreview('A.MD'), 'markdown');
});

test('classifyPreview 识别文本白名单', () => {
  assert.strictEqual(classifyPreview('app.js'), 'text');
  assert.strictEqual(classifyPreview('conf.yaml'), 'text');
  assert.strictEqual(classifyPreview('notes.txt'), 'text');
  assert.strictEqual(classifyPreview('server.log'), 'text');
});

test('classifyPreview 未知/二进制扩展名回落 download', () => {
  assert.strictEqual(classifyPreview('a.tar.gz'), 'download');
  assert.strictEqual(classifyPreview('noext'), 'download');
  assert.strictEqual(classifyPreview(null), 'download');
  assert.strictEqual(classifyPreview(42), 'download');
});

test('looksBinary 命中 NUL 字节', () => {
  assert.strictEqual(looksBinary(Buffer.from('hello world')), false);
  assert.strictEqual(looksBinary(Buffer.from([0x68, 0x00, 0x69])), true);
  assert.strictEqual(looksBinary(Buffer.from('')), false);
});

test('PREVIEW_MAX_BYTES 为 2MB', () => {
  assert.strictEqual(PREVIEW_MAX_BYTES, 2 * 1024 * 1024);
});

const { IMAGE_EXT, PREVIEW_IMG_MAX } = require('../lib/preview');

test('classifyPreview 识别图片', () => {
  assert.strictEqual(classifyPreview('a.png'), 'image');
  assert.strictEqual(classifyPreview('b.JPG'), 'image');   // 大小写不敏感
  assert.strictEqual(classifyPreview('c.jpeg'), 'image');
  assert.strictEqual(classifyPreview('d.svg'), 'image');
  assert.strictEqual(classifyPreview('e.webp'), 'image');
});

test('图片不再落入 download,文本/markdown 不受影响', () => {
  assert.strictEqual(classifyPreview('README.md'), 'markdown');
  assert.strictEqual(classifyPreview('app.js'), 'text');
  assert.strictEqual(classifyPreview('x.bin'), 'download');
});

test('PREVIEW_IMG_MAX 为 10MB', () => {
  assert.strictEqual(PREVIEW_IMG_MAX, 10 * 1024 * 1024);
});
