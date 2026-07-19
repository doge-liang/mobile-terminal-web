'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { interpretMetaCat, interpretListResult } = require('../box/lib/meta');

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

test('interpretListResult: status0+空输出→[](真空,而非 R2 不可达)', () => {
  assert.deepStrictEqual(interpretListResult({ status: 0, stdout: '', stderr: '' }), []);
});

test('interpretListResult: status0+多行 dirs 输出→去掉尾斜杠的名字数组', () => {
  assert.deepStrictEqual(
    interpretListResult({ status: 0, stdout: 'a/\nb/\n', stderr: '' }),
    ['a', 'b'],
  );
});

test('interpretListResult: status1+stderr → 抛出"列出沙盒失败"(不可吞成空列表)', () => {
  assert.throws(
    () => interpretListResult({ status: 1, stdout: '', stderr: 'boom' }),
    /列出沙盒失败/,
  );
});
