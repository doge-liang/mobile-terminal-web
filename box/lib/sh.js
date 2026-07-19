'use strict';
const { spawnSync } = require('child_process');

// 统一的外部命令封装:box 是纯编排层,一切重活都经这里出去
function run(cmd, args, opts = {}) {
  const { env, input, check = true, timeoutMs, inherit = false } = opts;
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    input,
    timeout: timeoutMs,
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (check && r.status !== 0) {
    const tail = (r.stderr || '').trim().split('\n').slice(-3).join(' ');
    const e = new Error(`${cmd} 退出码 ${r.status}${tail ? `: ${tail}` : ''}`);
    e.status = r.status;
    e.stderr = r.stderr || '';
    throw e;
  }
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function ssh(host, command, opts = {}) {
  const { timeoutMs = 15000, check = true, inherit = false } = opts;
  return run('ssh', ['-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`, host, command],
  { check, timeoutMs, inherit });
}

module.exports = { run, ssh };
