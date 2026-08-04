'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveDeletable } = require('../lib/delete-guard');

const ENV = { home: '/root', cwd: '/root/mobile-terminal-web', protect: ['/root/mobile-terminal-web/.auth-secret'] };

test('普通路径放行并归一化', () => {
  assert.deepStrictEqual(resolveDeletable('/root/tmp/a.txt', ENV), { path: '/root/tmp/a.txt' });
  assert.deepStrictEqual(resolveDeletable('/root/./tmp/../tmp/a.txt', ENV), { path: '/root/tmp/a.txt' });
});

test('拒绝根目录、主目录', () => {
  assert.ok(resolveDeletable('/', ENV).error);
  assert.ok(resolveDeletable('/root', ENV).error);
  assert.ok(resolveDeletable('/root/', ENV).error);
});

test('拒绝服务目录及其祖先,但目录内文件可删', () => {
  assert.ok(resolveDeletable('/root/mobile-terminal-web', ENV).error);
  assert.strictEqual(resolveDeletable('/root/mobile-terminal-web/public/app.js', ENV).error, undefined);
});

test('保护名单命中(含穿越写法)', () => {
  assert.ok(resolveDeletable('/root/mobile-terminal-web/.auth-secret', ENV).error);
  assert.ok(resolveDeletable('/root/../root/mobile-terminal-web/.auth-secret', ENV).error);
});

test('拒绝相对路径、空值与 NUL', () => {
  assert.ok(resolveDeletable('tmp/a.txt', ENV).error);
  assert.ok(resolveDeletable('', ENV).error);
  assert.ok(resolveDeletable(null, ENV).error);
  assert.ok(resolveDeletable('/root/a\0.txt', ENV).error);
});
