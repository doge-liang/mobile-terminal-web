'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { formatBoxesJson } = require('../box/lib/lsjson');

const meta = (over) => ({
  name: 'demo', path: '/root/demo', pin: null, leased_by: null, lease_ts: null,
  last_snapshot: '2026-07-17T00:00:00.000Z', memory_max: null, nix: false,
  created_at: '2026-07-01T00:00:00.000Z', ...over,
});

test('parked 盒:running=false,租约空', () => {
  const out = formatBoxesJson([meta()], []);
  assert.deepStrictEqual(out, [{
    name: 'demo', path: '/root/demo', nix: false, leased_by: null, pin: null,
    last_snapshot: '2026-07-17T00:00:00.000Z', running: false,
  }]);
});

test('active+running 盒:running 仅按 runningNames 判定', () => {
  const out = formatBoxesJson(
    [meta({ leased_by: 'term1' }), meta({ name: 'other', leased_by: 'term1' })],
    ['demo']);
  assert.strictEqual(out[0].running, true);
  assert.strictEqual(out[1].running, false);
});

test('pin 与 nix 透传;null meta 被过滤', () => {
  const out = formatBoxesJson([meta({ pin: 'term1', nix: true }), null], []);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].pin, 'term1');
  assert.strictEqual(out[0].nix, true);
});
