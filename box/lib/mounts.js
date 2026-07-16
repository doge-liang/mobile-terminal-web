'use strict';
const fs = require('fs');

const USR_SYMLINKS = ['bin', 'sbin', 'lib', 'lib64']; // Ubuntu merged-usr:根下是指向 usr/ 的符号链接
const BASE_PATH = '/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const NIX_PATH = '/nix/var/nix/profiles/default/bin:' + BASE_PATH;

function slugFor(projectPath) {
  return projectPath.replace(/[/.]/g, '-');
}

// 生成 bwrap argv(纯函数,exists 可注入以便单测)。策略见 spec「沙盒运行时模型」。
function buildBwrapArgs(opts, exists = fs.existsSync) {
  const { name, projectPath, boxHome, runDir, nix } = opts;
  const args = [
    '--die-with-parent', '--unshare-pid', '--unshare-uts', '--hostname', `box-${name}`,
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
  ];
  for (const p of ['/usr', '/etc']) if (exists(p)) args.push('--ro-bind', p, p);
  for (const l of USR_SYMLINKS) if (exists(`/${l}`)) args.push('--symlink', `usr/${l}`, `/${l}`);
  args.push('--bind', boxHome, '/root');
  args.push('--bind', projectPath, projectPath);
  args.push('--bind', runDir, runDir);
  // 全局 agent 配置 RO;凭证与本盒状态 RW;codex/grok 状态池一期整挂 RW(见 spec 挂载策略)
  const roHome = [
    '/root/.claude/CLAUDE.md', '/root/.claude/settings.json', '/root/.claude/output-styles',
    '/root/.claude/skills', '/root/.claude/plugins',
    '/root/.gitconfig', '/root/.config/gh', '/root/.local',
  ];
  const rwHome = [
    '/root/.claude/.credentials.json', '/root/.claude.json',
    `/root/.claude/projects/${slugFor(projectPath)}`,
    '/root/.codex', '/root/.grok',
  ];
  for (const p of roHome) if (exists(p)) args.push('--ro-bind', p, p);
  for (const p of rwHome) if (exists(p)) args.push('--bind', p, p);
  if (nix && exists('/nix')) {
    args.push('--ro-bind', '/nix', '/nix');
    args.push('--bind', '/nix/var/nix/daemon-socket', '/nix/var/nix/daemon-socket');
  }
  args.push('--setenv', 'HOME', '/root', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'PATH', nix ? NIX_PATH : BASE_PATH, '--chdir', projectPath);
  return args;
}

module.exports = { slugFor, buildBwrapArgs };
