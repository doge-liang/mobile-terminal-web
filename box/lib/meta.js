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

function interpretListResult({ status, stdout, stderr }) {
  if (status !== 0) {
    const tail = (stderr || '').trim().split('\n').pop();
    throw new Error(`列出沙盒失败: ${tail || 'unknown'}`);
  }
  // status===0 + 空输出在 R2 上就是"真的没有沙盒",与"R2 不可达"(非零 status)必须区分开——
  // 混为一谈会让定时 snapshot --active 把 R2 故障误当空列表静默跳过(活跃盒漏快照、租约不续)。
  return stdout.split('\n').filter(Boolean).map((s) => s.replace(/\/$/, ''));
}

function listBoxNames(cfg) {
  const r = run('rclone', ['lsf', `BOXR2:${cfg.bucket}/boxes/`, '--dirs-only'],
    { env: cfg.rcloneEnv, check: false });
  return interpretListResult(r);
}

module.exports = {
  newMeta, readMeta, writeMeta, listBoxNames, iso, interpretMetaCat, interpretListResult,
};
