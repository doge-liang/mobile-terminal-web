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

function interpretMetaCat({ status, stdout, stderr }) {
  if (status !== 0) {
    if (status === 3 || status === 4 || /not found/i.test(stderr)) return null;
    throw new Error(`读取 meta 失败: ${stderr.trim().split('\n').pop()}`);
  }
  // Cloudflare R2 上 `rclone cat` 对不存在的对象返回 exit=0 且 stdout 为空
  // (不是 rclone 对本地/多数后端假设的 status 3/4),需在此单独判定为"不存在"。
  if (!stdout || !stdout.trim()) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`meta.json 内容非法: ${stdout.slice(0, 80)}`);
  }
}

function readMeta(cfg, name) {
  const r = run('rclone', ['cat', metaPath(cfg, name)], { env: cfg.rcloneEnv, check: false });
  return interpretMetaCat(r);
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

module.exports = { newMeta, readMeta, writeMeta, listBoxNames, iso, interpretMetaCat };
