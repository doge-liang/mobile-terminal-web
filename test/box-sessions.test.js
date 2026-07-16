'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findCwd, matchesBox, collectSessionSlices } = require('../box/lib/sessions');

test('findCwd 递归定位 payload.cwd(codex 真实格式)', () => {
  const line = { timestamp: 't', type: 'session_meta', payload: { id: 'x', cwd: '/root/demo' } };
  assert.strictEqual(findCwd(line), '/root/demo');
  assert.strictEqual(findCwd({ a: 1 }), null);
});

test('matchesBox 精确或子目录', () => {
  assert.ok(matchesBox('/root/demo', '/root/demo'));
  assert.ok(matchesBox('/root/demo/sub', '/root/demo'));
  assert.ok(!matchesBox('/root/demo2', '/root/demo'));
});

test('collectSessionSlices: codex 按首行 cwd、grok 按目录名解码', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'box-t-'));
  const cx = path.join(tmp, 'codex/2026/07/16');
  fs.mkdirSync(cx, { recursive: true });
  fs.writeFileSync(path.join(cx, 'hit.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/root/demo' } }) + '\n{"x":1}\n');
  fs.writeFileSync(path.join(cx, 'miss.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/root/other' } }) + '\n');
  fs.writeFileSync(path.join(cx, 'garbage.jsonl'), 'not json\n');
  const gk = path.join(tmp, 'grok');
  fs.mkdirSync(path.join(gk, encodeURIComponent('/root/demo')), { recursive: true });
  fs.mkdirSync(path.join(gk, encodeURIComponent('/root/other')), { recursive: true });
  fs.writeFileSync(path.join(gk, 'session_search.sqlite'), '');
  const out = collectSessionSlices('/root/demo', [path.join(tmp, 'codex'), gk]);
  assert.deepStrictEqual(out.sort(), [
    path.join(cx, 'hit.jsonl'),
    path.join(gk, encodeURIComponent('/root/demo')),
  ].sort());
  fs.rmSync(tmp, { recursive: true, force: true });
});
