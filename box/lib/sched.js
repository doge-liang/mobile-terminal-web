'use strict';
// 调度:pin 优先;否则 MemAvailable 最大者,并列偏向本机;全失败回落本机
function pickNode(probes, { pin, self }) {
  if (pin) {
    if (!probes.some((p) => p.name === pin)) throw new Error(`pin 节点 ${pin} 不在 nodes 清单中`);
    return { name: pin };
  }
  const alive = probes.filter((p) => Number.isFinite(p.memKb));
  if (!alive.length) return { name: self, warning: '所有节点内存探测失败,回落本机' };
  let best = alive[0];
  for (const p of alive.slice(1)) {
    if (p.memKb > best.memKb || (p.memKb === best.memKb && p.name === self)) best = p;
  }
  return { name: best.name };
}

module.exports = { pickNode };
