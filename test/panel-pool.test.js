'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const n1 = { id: 'self', name: '主节点', url: 'https://term.example.com' };
const n2 = { id: 'term2', name: 'RackNerd-8G', url: 'https://term2.example.com' };

test('按跳板机聚合:同首段合一行,行序=首见序,列=节点', async () => {
  const { groupPoolByJump } = await import('../panel/src/worker.js');
  const out = groupPoolByJump([
    { node: n1, ok: true, pool: ['https://dmit-01.t1.example.com:2097', 'https://bw-02.t1.example.com:2097'] },
    { node: n2, ok: true, pool: ['https://dmit-01.t2.example.com:2096', 'https://bw-02.t2.example.com:2096'] },
  ]);
  assert.deepStrictEqual(out.rows.map((r) => r.jump), ['dmit-01', 'bw-02']);
  assert.strictEqual(out.rows[0].cells.self, 'https://dmit-01.t1.example.com:2097');
  assert.strictEqual(out.rows[0].cells.term2, 'https://dmit-01.t2.example.com:2096');
  assert.deepStrictEqual(out.nodes.map((n) => n.count), [2, 2]);
});

test('节点池表不可用:进 nodes 带 reason,不产生行', async () => {
  const { groupPoolByJump } = await import('../panel/src/worker.js');
  const out = groupPoolByJump([
    { node: n1, ok: true, pool: ['https://dmit-01.t1.example.com:2097'] },
    { node: n2, ok: false, reason: 'HTTP 500' },
  ]);
  assert.strictEqual(out.rows.length, 1);
  assert.deepStrictEqual(out.rows[0].cells, { self: 'https://dmit-01.t1.example.com:2097' });
  assert.strictEqual(out.nodes[1].ok, false);
  assert.strictEqual(out.nodes[1].reason, 'HTTP 500');
  assert.strictEqual(out.nodes[1].count, 0);
});

test('单侧成员(仅某节点的池含该跳板机)只出该列', async () => {
  const { groupPoolByJump } = await import('../panel/src/worker.js');
  const out = groupPoolByJump([
    { node: n1, ok: true, pool: ['https://only1.t1.example.com:2097'] },
    { node: n2, ok: true, pool: [] },
  ]);
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.rows[0].cells.term2, undefined);
});

test('origin 进 href 前强制 https:非法与非 https 项剔除,合法项归一为 origin', async () => {
  const { groupPoolByJump } = await import('../panel/src/worker.js');
  const out = groupPoolByJump([
    { node: n1, ok: true, pool: ['javascript:alert(1)', 'not a url', 'http://plain.example.com', 'https://ok.t1.example.com:2097/path?x=1'] },
  ]);
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.rows[0].jump, 'ok');
  assert.strictEqual(out.rows[0].cells.self, 'https://ok.t1.example.com:2097');
});

test('空输入与全离线', async () => {
  const { groupPoolByJump } = await import('../panel/src/worker.js');
  assert.deepStrictEqual(groupPoolByJump([]), { nodes: [], rows: [] });
  const out = groupPoolByJump([{ node: n1, ok: false, reason: 'unreachable' }]);
  assert.strictEqual(out.rows.length, 0);
  assert.strictEqual(out.nodes[0].ok, false);
});
