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
    // 默认 OOMPolicy=stop 会在盒内单进程被 OOM killer 杀掉后判定整个 unit failed 并停掉
    // 全部残余进程(含 tmux server),盒需重启才能恢复;continue 让盒在内部 OOM 后继续存活自愈。
    '-p', 'OOMPolicy=continue',
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
  return `nix develop ${shQuote(ref)} -c "$SHELL"`;
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

// 盒 unit 的 cgroup.procs 绝对路径(宿主视角);用于把 exec 出的进程纳入盒的内存 cgroup
function boxCgroupProcsPath(name) {
  const rel = run('systemctl', ['show', '-p', 'ControlGroup', '--value', unitName(name)]).stdout.trim();
  if (!rel) throw new Error(`${name}: 取不到 cgroup 路径(unit 未运行?)`);
  return `/sys/fs/cgroup${rel}/cgroup.procs`;
}

// POSIX sh 单引号转义:仅用于拼接 shell 脚本体中的固定值(路径/pid),不用于用户 argv
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// 盒内一次性命令。两处修复:
// 1) exec 出的进程需纳入盒 unit 的内存 cgroup,否则 MemoryMax 对其不生效(nsenter -m -p -u
//    只切命名空间,不迁移 cgroup 成员)——做法:在宿主 namespace 里把外层 sh 自己的 pid 写入
//    盒 cgroup.procs,再 exec 进 nsenter;exec 不改变 cgroup 成员关系,故 nsenter 及其整条
//    exec 链(含最终 argv)都保持在盒 cgroup 内。写入失败即 fail-closed(不静默跑到盒外)。
// 2) 去掉 nsenter --wd=projectPath:该选项与盒内 `--bind projectPath projectPath` 自绑定挂载
//    交互会破坏 getcwd() 路径重建(裸 process.cwd() 调用如 `claude --version` 会踩),改为进入
//    命名空间后先显式 `cd` 再 exec 目标命令,规避裸 getcwd() 依赖。
function execIn(name, meta, argv) {
  const pid = innerPid(name);
  const procsPath = boxCgroupProcsPath(name);
  const innerScript = `cd ${shQuote(meta.path)} && exec env HOME=/root TMPDIR=/tmp "$@"`;
  const outerScript = `echo $$ > ${shQuote(procsPath)} || exit 97; ` +
    `exec nsenter -t ${pid} -m -p -u -- sh -c ${shQuote(innerScript)} sh "$@"`;
  return run('sh', ['-c', outerScript, 'sh', ...argv], { inherit: true, check: false }).status;
}

module.exports = { unitName, sockPath, boxHome, isRunning, startSandbox, stopSandbox, attach, execIn, shellCommand };
