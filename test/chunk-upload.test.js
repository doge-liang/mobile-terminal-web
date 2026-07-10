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
