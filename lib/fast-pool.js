// 快速通道「池」的纯函数(Phase 2 池化)。server.js 只做接线,可测逻辑都在这里。
//
// 概念:一个节点可有多条快速通道(多台跳板机),彼此共享同一父域(如 t2.example.com)。
//   FAST_HOST          逗号分隔的 host:port 列表;首项为 /pair 的默认签发目标。
//   FAST_POOL          逗号分隔的完整 https origin 列表,供客户端并发测速选路。
//   FAST_COOKIE_DOMAIN 池的共享 Cookie 域;配对 Cookie 带上 Domain= 后全池通用,
//                      切换通道无需重新配对。
// 三者皆可缺省:FAST_HOST 单值 + 其余留空 = Phase 1 的单通道行为,向后兼容。

'use strict';

// FAST_HOST="a.t2.example.com:2096, b.t2.example.com:2096" -> ["a.t2…:2096","b.t2…:2096"]
// 主机名大小写不敏感,统一小写后比对/拼 URL。
function parseFastHosts(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// FAST_POOL 项须是合法 https URL;取其 origin(丢弃路径),非法项静默剔除——
// 配错只是少一个候选,不该让服务起不来。
function parseFastPool(raw) {
  const out = [];
  for (const item of parseFastHosts(raw)) {
    try {
      const u = new URL(item);
      if (u.protocol !== 'https:') continue;
      if (!out.includes(u.origin)) out.push(u.origin);
    } catch { /* 剔除非法项 */ }
  }
  return out;
}

// origin -> host[:port](与 req.headers.host 同形,供白名单比对)
function poolHosts(origins) {
  const out = [];
  for (const o of origins) {
    try {
      const h = new URL(o).host;
      if (h && !out.includes(h)) out.push(h);
    } catch { /* 非法项已在 parseFastPool 剔除,这里兜底 */ }
  }
  return out;
}

// /pair?host= 的目标选择:请求值必须命中白名单(FAST_HOST 列表 ∪ 池成员),
// 否则回落默认(FAST_HOST 首项)。白名单精确匹配,请求值永不原样进入响应。
function pickPairHost(requested, fastHosts, poolHostList) {
  const allowed = new Set([...fastHosts, ...poolHostList]);
  const want = String(requested || '').trim().toLowerCase();
  if (want && allowed.has(want)) return want;
  return fastHosts[0] || poolHostList[0] || '';
}

// 求本次 /pair/claim 应携带的 Cookie Domain:仅当配置域是请求 Host 的后缀
// (即浏览器会接受的合法父域)才返回,否则 null=host-only Cookie(Phase 1 行为)。
// 这使同一份配置同时服务池内(.t2 域名,带 Domain)与遗留单通道域名(不带)。
function cookieDomainFor(reqHost, domainEnv) {
  const domain = String(domainEnv || '').trim().replace(/^\./, '').toLowerCase();
  if (!domain) return null;
  let host = String(reqHost || '').trim().toLowerCase();
  if (!host) return null;
  if (host.startsWith('[')) return null; // 字面 IPv6 不参与域 Cookie
  host = host.split(':')[0];
  if (host === domain || host.endsWith('.' + domain)) return domain;
  return null;
}

// connect-src 指令:池成员是跨源探测目标,须显式列入,否则 CSP 挡掉测速请求。
function connectSrcDirective(poolOrigins) {
  return ["connect-src 'self'", ...poolOrigins].join(' ');
}

// 供把 JSON 嵌进 HTML 属性(如 data-pool='…')的转义。
function attrEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { parseFastHosts, parseFastPool, poolHosts, pickPairHost, cookieDomainFor, connectSrcDirective, attrEscape };
