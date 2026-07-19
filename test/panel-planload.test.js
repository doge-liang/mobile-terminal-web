'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const box = (over) => ({
  name: 'demo', path: '/root/demo', nix: false, leased_by: null, pin: null,
  last_snapshot: null, running: false, runningOn: null, mem: null, ...over,
});

test('planLoad 各分支', async () => {
  const { planLoad } = await import('../panel/src/worker.js');
  // parked → 只 up
  assert.deepStrictEqual(planLoad([box()], 'demo', 'term1'), { park: null, up: 'term1' });
  // active 在他机 → park 源 + up 目标
  assert.deepStrictEqual(
    planLoad([box({ leased_by: 'my-second-node', running: true, runningOn: 'my-second-node' })], 'demo', 'term1'),
    { park: 'my-second-node', up: 'term1' });
  // 已 active 且运行在目标 → 全跳过(幂等)
  assert.deepStrictEqual(
    planLoad([box({ leased_by: 'term1', running: true, runningOn: 'term1' })], 'demo', 'term1'),
    { park: null, up: null });
  // 租约在目标但没运行(节点重启过)→ 只 up
  assert.deepStrictEqual(
    planLoad([box({ leased_by: 'term1', running: false })], 'demo', 'term1'),
    { park: null, up: 'term1' });
  // 未知盒 / 目标离线
  assert.ok(planLoad([], 'demo', 'term1').error);
  assert.ok(planLoad([box()], 'demo', null).error);
});

test('mergeBoxLs: 运行态与 mem 按上报节点归属;离线节点标记且不阻断', async () => {
  const { mergeBoxLs } = await import('../panel/src/worker.js');
  const nodeA = { id: 'a1', name: '甲', url: 'https://a.example.com' };
  const nodeB = { id: 'b1', name: '乙', url: 'https://b.example.com' };
  const boxes = [
    { name: 'demo', path: '/root/demo', nix: false, leased_by: 'term1', pin: null, last_snapshot: null, running: false },
  ];
  const out = mergeBoxLs([
    { node: nodeA, ok: true, data: { node: 'term1', boxes: boxes.map(b => ({ ...b, running: true })), mem: { demo: 4096 } } },
    { node: nodeB, ok: false, reason: 'HTTP 502' },
  ]);
  assert.strictEqual(out.boxes.length, 1);
  assert.strictEqual(out.boxes[0].running, true);
  assert.strictEqual(out.boxes[0].runningOn, 'term1');
  assert.strictEqual(out.boxes[0].mem, 4096);
  assert.deepStrictEqual(out.nodes.map(n => [n.boxNode, n.online]), [['term1', true], [null, false]]);
});
