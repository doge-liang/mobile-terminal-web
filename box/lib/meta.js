'use strict';
const { run } = require('./sh');

const metaPath = (cfg, name) => `BOXR2:${cfg.bucket}/boxes/${name}/meta.json`;
const iso = () => new Date().toISOString();

function newMeta({ name, path, node }) {
  return {
    name, path, pin: null, leased_by: node, lease_ts: iso(),
    last_snapshot: null, memory_max: null, nix: false, created_at: iso(),
  };
}

function readMeta(cfg, name) {
  const r = run('rclone', ['cat', metaPath(cfg, name)], { env: cfg.rcloneEnv, check: false });
  if (r.status !== 0) {
    if (r.status === 3 || r.status === 4 || /not found/i.test(r.stderr)) return null;
    throw new Error(`读取 meta 失败: ${r.stderr.trim().split('\n').pop()}`);
  }
  return JSON.parse(r.stdout);
}

function writeMeta(cfg, name, meta) {
  run('rclone', ['rcat', metaPath(cfg, name)],
    { env: cfg.rcloneEnv, input: JSON.stringify(meta, null, 2) });
}

function listBoxNames(cfg) {
  const r = run('rclone', ['lsf', `BOXR2:${cfg.bucket}/boxes/`, '--dirs-only'],
    { env: cfg.rcloneEnv, check: false });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((s) => s.replace(/\/$/, ''));
}

module.exports = { newMeta, readMeta, writeMeta, listBoxNames, iso };
