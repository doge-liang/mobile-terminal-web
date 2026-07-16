'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateLease, LEASE_TTL_MS } = require('../box/lib/lease');

const NOW = Date.parse('2026-07-16T12:00:00Z');
const meta = (leased_by, minsAgo) => ({
  leased_by, lease_ts: new Date(NOW - minsAgo * 60000).toISOString(),
});

test('无租约或本机持有:直接放行', () => {
  assert.strictEqual(evaluateLease(meta(null, 0), 'term1', NOW).ok, true);
  assert.strictEqual(evaluateLease(meta('term1', 5), 'term1', NOW).ok, true);
});

test('他机活跃租约:拒绝并给出指引', () => {
  const r = evaluateLease(meta('term2', 30), 'term1', NOW);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /term2/);
});

test('他机活跃租约 + force:放行且标记抢占', () => {
  const r = evaluateLease(meta('term2', 30), 'term1', NOW, true);
  assert.deepStrictEqual([r.ok, r.takeover, r.forced], [true, true, true]);
});

test('他机租约过期(>TTL):放行标记接管', () => {
  const r = evaluateLease(meta('term2', LEASE_TTL_MS / 60000 + 1), 'term1', NOW);
  assert.deepStrictEqual([r.ok, r.takeover], [true, true]);
});

test('lease_ts 缺失或非法视为已过期', () => {
  const r = evaluateLease({ leased_by: 'term2', lease_ts: null }, 'term1', NOW);
  assert.deepStrictEqual([r.ok, r.takeover], [true, true]);
});
