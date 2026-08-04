'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const SUFFIX = '.example.com';
const FAST = 'https://term-fast.example.com:2096';
const nodes = () => ([
  { id: 'self', name: '本机', url: 'https://term.example.com' },
  { id: 'term2', name: '二号机', url: 'https://term2.example.com' },
]);

test('self 无 fastUrl 时按 env 回填,其余节点不动', async () => {
  const { applyFastUrl } = await import('../panel/src/worker.js');
  const out = applyFastUrl(nodes(), FAST, SUFFIX);
  assert.strictEqual(out[0].fastUrl, FAST);
  assert.strictEqual(out[1].fastUrl, undefined);
});

test('env 未配则不渲染按钮(不产生 fastUrl 字段)', async () => {
  const { applyFastUrl } = await import('../panel/src/worker.js');
  assert.strictEqual(applyFastUrl(nodes(), '', SUFFIX)[0].fastUrl, undefined);
});

test('KV 里已有的 fastUrl 优先于 env,不被覆盖', async () => {
  const { applyFastUrl } = await import('../panel/src/worker.js');
  const kv = nodes();
  kv[0].fastUrl = 'https://other-fast.example.com:2096';
  assert.strictEqual(applyFastUrl(kv, FAST, SUFFIX)[0].fastUrl, 'https://other-fast.example.com:2096');
});

// fastUrl 会进 <a href>:非 https / 越 zone / javascript: 一律剔除而非渲染
test('非法 fastUrl 被剔除', async () => {
  const { applyFastUrl } = await import('../panel/src/worker.js');
  for (const bad of ['javascript:alert(1)', 'http://term-fast.example.com:2096', 'https://evil.test', '不是URL']) {
    const kv = nodes();
    kv[0].fastUrl = bad;
    assert.strictEqual(applyFastUrl(kv, '', SUFFIX)[0].fastUrl, undefined, `应剔除: ${bad}`);
  }
});

test('env 值非法时同样不回填', async () => {
  const { applyFastUrl } = await import('../panel/src/worker.js');
  assert.strictEqual(applyFastUrl(nodes(), 'javascript:alert(1)', SUFFIX)[0].fastUrl, undefined);
  assert.strictEqual(applyFastUrl(nodes(), 'https://evil.test', SUFFIX)[0].fastUrl, undefined);
});

test('未配 zoneSuffix 时只校验 https', async () => {
  const { applyFastUrl } = await import('../panel/src/worker.js');
  assert.strictEqual(applyFastUrl(nodes(), FAST, '')[0].fastUrl, FAST);
  assert.strictEqual(applyFastUrl(nodes(), 'http://term-fast.example.com', '')[0].fastUrl, undefined);
});

test('节点表无 self 时不报错', async () => {
  const { applyFastUrl } = await import('../panel/src/worker.js');
  const only = [{ id: 'term2', name: '二号机', url: 'https://term2.example.com' }];
  assert.deepStrictEqual(applyFastUrl(only, FAST, SUFFIX), only);
});
