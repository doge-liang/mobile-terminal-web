'use strict';
// ls --json 的数据组装:纯函数便于单测(R2 读取与运行态探测由调用方注入结果)
function formatBoxesJson(metas, runningNames) {
  const running = new Set(runningNames);
  return metas.filter(Boolean).map((m) => ({
    name: m.name,
    path: m.path,
    nix: !!m.nix,
    leased_by: m.leased_by || null,
    pin: m.pin || null,
    last_snapshot: m.last_snapshot || null,
    running: running.has(m.name),
  }));
}

module.exports = { formatBoxesJson };
