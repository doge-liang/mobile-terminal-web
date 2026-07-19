'use strict';
const LEASE_TTL_MS = 2 * 60 * 60 * 1000; // 两个快照周期

function evaluateLease(meta, selfNode, nowMs, force = false) {
  if (!meta.leased_by || meta.leased_by === selfNode) return { ok: true, takeover: false };
  const ts = Date.parse(meta.lease_ts || '');
  const ageMs = Number.isFinite(ts) ? nowMs - ts : Infinity;
  const ageMin = Math.round(ageMs / 60000);
  if (ageMs > LEASE_TTL_MS) {
    return { ok: true, takeover: true, reason: `${meta.leased_by} 的租约已过期(${ageMin} 分钟未续),接管` };
  }
  if (force) {
    return { ok: true, takeover: true, forced: true, reason: `--force 抢占 ${meta.leased_by} 的活跃租约;对方未归档改动将在快照分叉,以后到者为准` };
  }
  return { ok: false, reason: `沙盒活跃于 ${meta.leased_by}(${ageMin} 分钟前续租);去该节点 box park,或 --force 抢占` };
}

module.exports = { evaluateLease, LEASE_TTL_MS };
