'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { slugFor, buildBwrapArgs } = require('../box/lib/mounts');

test('slugFor 把 / 和 . 换成 -', () => {
  assert.strictEqual(slugFor('/root/mobile-terminal-web'), '-root-mobile-terminal-web');
  assert.strictEqual(slugFor('/root/a.b'), '-root-a-b');
});

const OPTS = {
  name: 'demo', projectPath: '/root/demo',
  boxHome: '/var/lib/box/demo/home', runDir: '/run/box/demo', nix: false,
};
// exists 注入:模拟宿主上存在哪些路径
const existsIn = (set) => (p) => set.has(p);

test('基础挂载:私有 HOME、项目 RW、系统 RO、私有 /tmp、PID 隔离', () => {
  const args = buildBwrapArgs(OPTS, existsIn(new Set(['/usr', '/etc', '/bin'])));
  const s = args.join(' ');
  assert.match(s, /--unshare-pid/);
  assert.match(s, /--tmpfs \/tmp/);
  assert.match(s, /--ro-bind \/usr \/usr/);
  assert.match(s, /--symlink usr\/bin \/bin/);          // merged-usr 重建符号链接
  assert.match(s, /--bind \/var\/lib\/box\/demo\/home \/root/);
  assert.match(s, /--bind \/root\/demo \/root\/demo/);
  assert.ok(!s.includes('--unshare-net'), '一期共享网络');
});

test('agent 状态:claude 项目 slug 精确 RW,全局配置 RO,凭证 RW', () => {
  const host = new Set(['/usr', '/etc', '/root/.claude/CLAUDE.md',
    '/root/.claude/settings.json', '/root/.claude/.credentials.json',
    '/root/.claude.json', '/root/.claude/projects/-root-demo', '/root/.codex']);
  const s = buildBwrapArgs(OPTS, existsIn(host)).join(' ');
  assert.match(s, /--ro-bind \/root\/\.claude\/CLAUDE\.md/);
  assert.match(s, /--bind \/root\/\.claude\/\.credentials\.json/);
  assert.match(s, /--bind \/root\/\.claude\/projects\/-root-demo/);
  assert.match(s, /--bind \/root\/\.codex \/root\/\.codex/);
  assert.ok(!s.includes('/root/.ssh'), '.ssh 不可见');
});

test('宿主缺失的路径不产生 bind(新机器上凭证可能还没有)', () => {
  const s = buildBwrapArgs(OPTS, existsIn(new Set(['/usr', '/etc']))).join(' ');
  assert.ok(!s.includes('.credentials.json'));
});

test('nix 盒:store RO + daemon socket RW + PATH 带 nix profile', () => {
  const host = new Set(['/usr', '/etc', '/nix']);
  const s = buildBwrapArgs({ ...OPTS, nix: true }, existsIn(host)).join(' ');
  assert.match(s, /--ro-bind \/nix \/nix/);
  assert.match(s, /--bind \/nix\/var\/nix\/daemon-socket \/nix\/var\/nix\/daemon-socket/);
  assert.match(s, /\/nix\/var\/nix\/profiles\/default\/bin/);
});
