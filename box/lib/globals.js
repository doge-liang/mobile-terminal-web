'use strict';
const fs = require('fs');
const { run } = require('./sh');

// spec「全局状态(globals)同步」清单;仅同步存在的路径
const GLOBALS = [
  '/root/.claude/CLAUDE.md', '/root/.claude/settings.json', '/root/.claude/output-styles',
  '/root/.claude/skills', '/root/.claude/plugins', '/root/.claude/.credentials.json',
  '/root/.codex/config.toml', '/root/.codex/AGENTS.md', '/root/.codex/auth.json',
  '/root/.grok/config.toml', '/root/.grok/skills', '/root/.grok/installed-plugins', '/root/.grok/auth.json',
];

function push(cfg) {
  const t = GLOBALS.filter((p) => fs.existsSync(p));
  if (!t.length) throw new Error('无可推送的全局配置');
  run('restic', ['backup', '--tag', 'globals', ...t], { env: cfg.resticEnv, inherit: true });
}

function pull(cfg) {
  run('restic', ['restore', 'latest', '--tag', 'globals', '--target', '/'],
    { env: cfg.resticEnv, inherit: true });
}

function auto(cfg) { (cfg.globalsRole === 'push' ? push : pull)(cfg); }

module.exports = { GLOBALS, push, pull, auto };
