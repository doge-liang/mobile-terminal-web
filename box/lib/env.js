'use strict';
const fs = require('fs');

const ENV_PATH = process.env.BOX_ENV || '/root/.config/box/env';
const NODES_PATH = process.env.BOX_NODES || '/root/.config/box/nodes';
const REQUIRED = ['BOX_NODE', 'BOX_S3_ENDPOINT', 'BOX_BUCKET',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'RESTIC_PASSWORD'];

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

function parseNodesFile(text) {
  const nodes = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [name, host] = t.split(/\s+/);
    if (name && host) nodes.push({ name, host });
  }
  return nodes;
}

function loadConfig() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`缺少配置 ${ENV_PATH},参照 box/env.example 创建(chmod 600)`);
  }
  const raw = parseEnvFile(fs.readFileSync(ENV_PATH, 'utf8'));
  for (const k of REQUIRED) if (!raw[k]) throw new Error(`${ENV_PATH} 缺少 ${k}`);
  const nodes = fs.existsSync(NODES_PATH)
    ? parseNodesFile(fs.readFileSync(NODES_PATH, 'utf8'))
    : [{ name: raw.BOX_NODE, host: 'local' }];
  return {
    node: raw.BOX_NODE,
    globalsRole: raw.BOX_GLOBALS_ROLE || 'pull',
    endpoint: raw.BOX_S3_ENDPOINT,
    bucket: raw.BOX_BUCKET,
    memoryMax: raw.BOX_MEMORY_MAX || '1500M',
    resticEnv: {
      RESTIC_REPOSITORY: `s3:${raw.BOX_S3_ENDPOINT}/${raw.BOX_BUCKET}/restic`,
      RESTIC_PASSWORD: raw.RESTIC_PASSWORD,
      AWS_ACCESS_KEY_ID: raw.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: raw.AWS_SECRET_ACCESS_KEY,
    },
    rcloneEnv: {
      RCLONE_CONFIG_BOXR2_TYPE: 's3',
      RCLONE_CONFIG_BOXR2_PROVIDER: 'Cloudflare',
      RCLONE_CONFIG_BOXR2_ENDPOINT: raw.BOX_S3_ENDPOINT,
      RCLONE_CONFIG_BOXR2_ACCESS_KEY_ID: raw.AWS_ACCESS_KEY_ID,
      RCLONE_CONFIG_BOXR2_SECRET_ACCESS_KEY: raw.AWS_SECRET_ACCESS_KEY,
      RCLONE_CONFIG_BOXR2_NO_CHECK_BUCKET: 'true',
    },
    nodes,
  };
}

function hostFor(cfg, nodeName) {
  const n = cfg.nodes.find((x) => x.name === nodeName);
  if (!n) throw new Error(`节点 ${nodeName} 不在 ${NODES_PATH} 清单中`);
  return n.host;
}

module.exports = { parseEnvFile, parseNodesFile, loadConfig, hostFor };
