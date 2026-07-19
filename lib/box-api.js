'use strict';
// 节点侧 box API 的纯逻辑(与 box/lib 隔一个部署边界,小校验刻意复制而非跨目录 require)

// 与 box/lib/mounts.js 的 isValidBoxName 语义一致,另加 64 字长度上限
function isValidBoxName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(name) && !name.includes('..');
}

// /root/.config/box/env 含 R2/restic 凭证:只允许解析 BOX_NODE 一个键
function parseBoxNode(text) {
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (t.startsWith('BOX_NODE=')) return t.slice('BOX_NODE='.length).trim() || null;
  }
  return null;
}

// 服务令牌身份(JWT 带 common_name)只可访问 /t/box/*,且必须命中 BOX_CTRL_CN 白名单;
// 人类身份(cn 为空)不归本函数管,一律放行
function serviceAuthAllowed(cn, pathname, allowedCn) {
  if (!cn) return true;
  if (!allowedCn || cn !== allowedCn) return false;
  return pathname.startsWith('/t/box/');
}

const boxSockPath = (name) => `/run/box/${name}/tmux.sock`;

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// 与 box/lib/runtime.js shellCommand 语义一致:项目有 flake.nix 用项目的,否则基础 flake
function nixShellCommand(path, hasProjectFlake) {
  const ref = hasProjectFlake ? path : '/etc/box/base-flake';
  return `nix develop ${shQuote(ref)} -c "$SHELL"`;
}

// attach 盒内 tmux 的完整 argv:对齐 box/lib/runtime.js attach(-c 路径 + nix 外壳)
// 并补宿主 spawnTmux 的 mouse/set-clipboard(盒内 tmux-inner.conf 未设,缺则触摸滚动与 OSC52 失效)
function buildBoxTmuxArgv(name, path, nixCmd) {
  const argv = ['-S', boxSockPath(name), 'new-session', '-A', '-s', 'main', '-c', path];
  if (nixCmd) argv.push(nixCmd);
  argv.push(';', 'set-option', 'mouse', 'on', ';', 'set-option', '-g', 'set-clipboard', 'on');
  return argv;
}

// cgroup v2 下 systemd 系统服务的内存读数;读不到(盒刚停/路径不在)返回 null
function readBoxMem(name, readFile) {
  try {
    return parseInt(readFile(`/sys/fs/cgroup/system.slice/boxrun-${name}.service/memory.current`), 10);
  } catch {
    return null;
  }
}

module.exports = {
  isValidBoxName, parseBoxNode, serviceAuthAllowed,
  boxSockPath, nixShellCommand, buildBoxTmuxArgv, readBoxMem,
};
