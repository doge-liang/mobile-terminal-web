'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { safeBasename, uniqueName } = require('../lib/upload-paths');

test('safeBasename 剥离目录成分', () => {
  assert.strictEqual(safeBasename('/etc/passwd'), 'passwd');
  assert.strictEqual(safeBasename('a/b/c.txt'), 'c.txt');
  assert.strictEqual(safeBasename('report.pdf'), 'report.pdf');
});

test('safeBasename 拒绝穿越与空名', () => {
  assert.strictEqual(safeBasename('..'), null);
  assert.strictEqual(safeBasename('.'), null);
  assert.strictEqual(safeBasename('   '), null);
  assert.strictEqual(safeBasename('../../x'), 'x'); // basename('../../x') === 'x'
});

test('safeBasename 保留中文与空格', () => {
  assert.strictEqual(safeBasename('数据 报告.csv'), '数据 报告.csv');
});

test('uniqueName 未占用时原样返回', () => {
  assert.strictEqual(uniqueName('a.txt', () => false), 'a.txt');
});

test('uniqueName 同名时在扩展名前插入序号', () => {
  const existing = new Set(['a.txt', 'a (1).txt']);
  assert.strictEqual(uniqueName('a.txt', (n) => existing.has(n)), 'a (2).txt');
});

test('uniqueName 处理无扩展名', () => {
  const existing = new Set(['README']);
  assert.strictEqual(uniqueName('README', (n) => existing.has(n)), 'README (1)');
});
