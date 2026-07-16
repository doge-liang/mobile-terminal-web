'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { interpretMetaCat } = require('../box/lib/meta');

test('status 0 + 空 stdout: 判定为不存在(R2 真机回归)', () => {
  assert.strictEqual(interpretMetaCat({ status: 0, stdout: '', stderr: '' }), null);
});

test('status 0 + 空白 stdout(仅换行): 判定为不存在', () => {
  assert.strictEqual(interpretMetaCat({ status: 0, stdout: '\n', stderr: '' }), null);
});

test('status 0 + 合法 JSON: 返回解析后的对象', () => {
  const meta = { name: 'box-smoke', pin: null, leased_by: 'term1' };
  const r = interpretMetaCat({ status: 0, stdout: JSON.stringify(meta), stderr: '' });
  assert.deepStrictEqual(r, meta);
});

test('status 0 + 非法 JSON: 抛出"内容非法"错误', () => {
  assert.throws(
    () => interpretMetaCat({ status: 0, stdout: '{bad', stderr: '' }),
    /内容非法/,
  );
});

test('status 3: 判定为不存在;status 1 + stderr: 抛出"读取 meta 失败"', () => {
  assert.strictEqual(interpretMetaCat({ status: 3, stdout: '', stderr: 'directory not found' }), null);
  assert.throws(
    () => interpretMetaCat({ status: 1, stdout: '', stderr: 'boom' }),
    /读取 meta 失败/,
  );
});
