'use strict';
const fs = require('fs');
const path = require('path');
const { run } = require('./sh');
const { slugFor } = require('./mounts');
const { collectSessionSlices } = require('./sessions');

// 安装后固定在 /opt/box;开发期(从仓库直跑)回退到源码旁的 exclude.txt
const EXCLUDE_FILE = fs.existsSync('/opt/box/exclude.txt')
  ? '/opt/box/exclude.txt'
  : path.join(__dirname, '..', 'exclude.txt');

function snapshotTargets(meta) {
  const targets = [meta.path];
  const claudeDir = `/root/.claude/projects/${slugFor(meta.path)}`;
  if (fs.existsSync(claudeDir)) targets.push(claudeDir);
  targets.push(...collectSessionSlices(meta.path));
  return targets;
}

function backupBox(cfg, meta) {
  run('restic', ['backup', '--tag', `box:${meta.name}`, '--exclude-file', EXCLUDE_FILE,
    ...snapshotTargets(meta)], { env: cfg.resticEnv, inherit: true });
}

function restoreBox(cfg, meta) {
  run('restic', ['restore', 'latest', '--tag', `box:${meta.name}`, '--target', '/'],
    { env: cfg.resticEnv, inherit: true });
}

module.exports = { EXCLUDE_FILE, snapshotTargets, backupBox, restoreBox };
