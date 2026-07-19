'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  isValidBoxName, parseBoxNode, serviceAuthAllowed,
  boxSockPath, nixShellCommand, buildBoxTmuxArgv, readBoxMem,
} = require('../lib/box-api');

test('isValidBoxName: 合法与非法', () => {
  for (const ok of ['demo', 'a.b_c-1', 'X']) assert.ok(isValidBoxName(ok), ok);
  for (const bad of ['', null, undefined, 'a b', 'a/b', '../x', 'a..b', 'a'.repeat(65), 'a;rm']) {
    assert.ok(!isValidBoxName(bad), String(bad));
  }
});

test('parseBoxNode: 只取 BOX_NODE,忽略注释与其他键(不触碰凭证)', () => {
  const text = '# c\nBOX_S3_ENDPOINT=https://x\nBOX_NODE=term1\nRESTIC_PASSWORD=secret\n';
  assert.strictEqual(parseBoxNode(text), 'term1');
  assert.strictEqual(parseBoxNode('FOO=1\n'), null);
});

test('serviceAuthAllowed: 人类身份放行;服务令牌限 /t/box/* 且须命中白名单', () => {
  assert.ok(serviceAuthAllowed(null, '/t/upload', 'panel-ctrl'));
  assert.ok(serviceAuthAllowed(undefined, '/t/dl', ''));
  assert.ok(serviceAuthAllowed('panel-ctrl', '/t/box/ls', 'panel-ctrl'));
  assert.ok(!serviceAuthAllowed('panel-ctrl', '/t/upload', 'panel-ctrl'));
  assert.ok(!serviceAuthAllowed('rogue', '/t/box/ls', 'panel-ctrl'));
  assert.ok(!serviceAuthAllowed('panel-ctrl', '/t/box/ls', ''));  // 未配置白名单=全拒
});

test('buildBoxTmuxArgv: 基础与 nix 变体,mouse/clipboard 链尾', () => {
  assert.deepStrictEqual(buildBoxTmuxArgv('demo', '/root/demo', null), [
    '-S', '/run/box/demo/tmux.sock', 'new-session', '-A', '-s', 'main', '-c', '/root/demo',
    ';', 'set-option', 'mouse', 'on', ';', 'set-option', '-g', 'set-clipboard', 'on',
  ]);
  const nixCmd = nixShellCommand('/root/demo', true);
  assert.strictEqual(nixCmd, `nix develop '/root/demo' -c "$SHELL"`);
  assert.strictEqual(nixShellCommand('/root/demo', false), `nix develop '/etc/box/base-flake' -c "$SHELL"`);
  const argv = buildBoxTmuxArgv('demo', '/root/demo', nixCmd);
  assert.strictEqual(argv[8], nixCmd);   // shell 命令紧跟 -c <path> 之后、set-option 之前
  assert.strictEqual(argv[9], ';');
});

test('readBoxMem: cgroup 路径正确;读失败返回 null', () => {
  const calls = [];
  const v = readBoxMem('demo', (p) => { calls.push(p); return '123456\n'; });
  assert.strictEqual(v, 123456);
  assert.deepStrictEqual(calls, ['/sys/fs/cgroup/system.slice/boxrun-demo.service/memory.current']);
  assert.strictEqual(readBoxMem('demo', () => { throw new Error('ENOENT'); }), null);
  assert.strictEqual(boxSockPath('demo'), '/run/box/demo/tmux.sock');
});
