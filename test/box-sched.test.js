'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { pickNode } = require('../box/lib/sched');

test('pin 优先,无视内存', () => {
  const r = pickNode([{ name: 'term1', memKb: 999 }, { name: 'term2', memKb: 1 }],
    { pin: 'term2', self: 'term1' });
  assert.strictEqual(r.name, 'term2');
});

test('pin 不在清单中报错', () => {
  assert.throws(() => pickNode([{ name: 'term1', memKb: 1 }], { pin: 'ghost', self: 'term1' }));
});

test('选可用内存最大者', () => {
  const r = pickNode([{ name: 'term1', memKb: 1000 }, { name: 'term2', memKb: 7000 }],
    { self: 'term1' });
  assert.strictEqual(r.name, 'term2');
});

test('探测失败(null)的节点被跳过', () => {
  const r = pickNode([{ name: 'term1', memKb: 1000 }, { name: 'term2', memKb: null }],
    { self: 'term1' });
  assert.strictEqual(r.name, 'term1');
});

test('全部失败:回落本机并带 warning', () => {
  const r = pickNode([{ name: 'term1', memKb: null }, { name: 'term2', memKb: null }],
    { self: 'term1' });
  assert.strictEqual(r.name, 'term1');
  assert.ok(r.warning);
});

test('并列偏向本机', () => {
  const r = pickNode([{ name: 'term2', memKb: 5000 }, { name: 'term1', memKb: 5000 }],
    { self: 'term1' });
  assert.strictEqual(r.name, 'term1');
});
