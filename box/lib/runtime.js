'use strict';
const fs = require('fs');
const { run } = require('./sh');
const { buildBwrapArgs, slugFor } = require('./mounts');

const RUN_ROOT = '/run/box';
const HOME_ROOT = '/var/lib/box';
const INNER_TMUX_CONF = '/etc/box/tmux-inner.conf';

const unitName = (name) => `boxrun-${name}`;
const sockPath = (name) => `${RUN_ROOT}/${name}/tmux.sock`;
const boxHome = (name) => `${HOME_ROOT}/${name}/home`;

function isRunning(name) {
  return run('systemctl', ['is-active', '--quiet', unitName(name)], { check: false }).status === 0;
}

function startSandbox(cfg, meta) {
  if (isRunning(meta.name)) return false;
  const runDir = `${RUN_ROOT}/${meta.name}`;
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(boxHome(meta.name), { recursive: true, mode: 0o700 });
  // claude 的本盒状态目录必须先存在才能 bind
  fs.mkdirSync(`/root/.claude/projects/${slugFor(meta.path)}`, { recursive: true });
  fs.rmSync(sockPath(meta.name), { force: true }); // 上次异常退出的残留 socket
  const bargs = buildBwrapArgs({
    name: meta.name, projectPath: meta.path, boxHome: boxHome(meta.name),
    runDir, nix: !!meta.nix,
  });
  run('systemd-run', ['--quiet', '--collect', `--unit=${unitName(meta.name)}`,
    '-p', `MemoryMax=${meta.memory_max || cfg.memoryMax}`,
    '-p', 'MemorySwapMax=0', '-p', 'TasksMax=512',
    '--', 'bwrap', ...bargs,
    // 盒内 tmux server 前台运行(-D),exit-empty off 使零会话时也不退出
    // 注:tmux manpage 明确「With -D, command may not be specified」,-D 与显式 start-server 命令冲突
    // (实测 `tmux -D start-server` 直接以 usage 错误退出);-D 单独已隐含前台启动 server,故不再传 start-server。
    'tmux', '-S', sockPath(meta.name), '-f', INNER_TMUX_CONF, '-D']);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(sockPath(meta.name))) {
    if (Date.now() > deadline) {
      throw new Error(`沙盒 ${meta.name} 启动失败(socket 未出现);查 journalctl -u ${unitName(meta.name)}`);
    }
    run('sleep', ['0.1'], { check: false });
  }
  return true;
}

function stopSandbox(name) {
  run('systemctl', ['stop', unitName(name)], { check: false });
  fs.rmSync(sockPath(name), { force: true });
}

// nix 盒的会话 shell:项目有 flake 用项目的,否则用基础 flake
function shellCommand(meta) {
  if (!meta.nix) return null;
  const ref = fs.existsSync(`${meta.path}/flake.nix`) ? meta.path : '/etc/box/base-flake';
  return `nix develop ${ref} -c $SHELL`;
}

function attach(name, meta) {
  const argv = ['-S', sockPath(name), 'new-session', '-A', '-s', 'main', '-c', meta.path];
  const inner = shellCommand(meta);
  if (inner) argv.push(inner);
  return run('tmux', argv, { inherit: true, check: false }).status;
}

// 盒内一次性命令:nsenter 进 bwrap init(宿主视角 MainPID 的首个子进程)的 mnt/pid/uts ns
function innerPid(name) {
  const main = run('systemctl', ['show', '-p', 'MainPID', '--value', unitName(name)]).stdout.trim();
  if (!main || main === '0') throw new Error(`${name} 未在运行`);
  const kids = fs.readFileSync(`/proc/${main}/task/${main}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
  if (!kids.length) throw new Error(`${name}: 未找到沙盒 init 进程`);
  return kids[0];
}

function execIn(name, meta, argv) {
  return run('nsenter', ['-t', innerPid(name), '-m', '-p', '-u', `--wd=${meta.path}`,
    '--', 'env', 'HOME=/root', 'TMPDIR=/tmp', ...argv], { inherit: true, check: false }).status;
}

module.exports = { unitName, sockPath, boxHome, isRunning, startSandbox, stopSandbox, attach, execIn, shellCommand };
