// 选路引导页脚本(/fast):并发测速池成员,选最快跳转。
// 页面数据经 #fastsel 的 data-pool / data-mode 传入(CSP 禁内联 script)。
//   mode=pair   页面在 Access 主域上:跳 /pair?host=<赢家> 走签发-认领链,落地赢家 origin。
//   mode=direct 页面在池内快速域名上(已持共享 Cookie):直接跳赢家 origin。
(() => {
  const root = document.getElementById('fastsel');
  if (!root) return;
  let pool = [];
  try { pool = JSON.parse(root.dataset.pool || '[]'); } catch { /* 数据坏了按空池处理 */ }
  const mode = root.dataset.mode === 'direct' ? 'direct' : 'pair';
  const list = document.getElementById('list');
  const msg = document.getElementById('msg');

  const hostOf = (o) => { try { return new URL(o).host; } catch { return o; } };
  const destFor = (o) => (mode === 'direct'
    ? (o === location.origin ? '/' : o + '/')
    : '/pair?host=' + encodeURIComponent(hostOf(o)));

  if (!pool.length) {
    msg.textContent = '本节点未配置通道池。';
    const a = document.createElement('a');
    a.style.color = '#58a6ff';
    if (mode === 'direct') { a.href = '/'; a.textContent = '返回终端 →'; }
    else { a.href = '/pair'; a.textContent = '用默认通道配对 →'; }
    msg.append(document.createElement('br'), a);
    return;
  }

  // 单次探测:no-cors GET /net/probe——任何应答都证明"跳板机+隧道+源站"整条链存活,
  // 这里只取耗时。cache:no-store 防缓存假快;credentials:omit 不动 Cookie。
  function probeOnce(origin, timeoutMs) {
    return new Promise((resolve) => {
      const c = new AbortController();
      const t0 = performance.now();
      const timer = setTimeout(() => { c.abort(); resolve(null); }, timeoutMs);
      fetch(origin + '/net/probe', { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: c.signal })
        .then(() => resolve(performance.now() - t0))
        .catch(() => resolve(null))
        .finally(() => clearTimeout(timer));
    });
  }

  // 两轮取最小:首轮含 TLS 建连(冷),次轮是稳态;任一轮成功即算存活。
  async function probe(origin) {
    const a = await probeOnce(origin, 2500);
    const b = await probeOnce(origin, 2500);
    const ok = [a, b].filter((v) => v != null);
    return ok.length ? Math.min(...ok) : null;
  }

  // 先摆出全部候选(可手动点选,不必等测速),测速结果就地回填。
  const rows = new Map();
  for (const o of pool) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.style.color = '#58a6ff';
    a.href = destFor(o);
    a.textContent = hostOf(o);
    const span = document.createElement('span');
    span.style.color = '#8b949e';
    span.textContent = ' 测速中…';
    li.append(a, span);
    list.append(li);
    rows.set(o, span);
  }

  Promise.all(pool.map(async (o) => {
    const ms = await probe(o);
    const span = rows.get(o);
    span.textContent = ms == null ? ' 不可达' : ' ' + Math.round(ms) + ' ms';
    span.style.color = ms == null ? '#f85149' : '#3fb950';
    return { o, ms };
  })).then((results) => {
    const alive = results.filter((r) => r.ms != null).sort((x, y) => x.ms - y.ms);
    if (!alive.length) {
      msg.textContent = '所有通道均不可达。可稍后重试,或继续用主域名(经 Cloudflare)访问。';
      return;
    }
    const best = alive[0];
    msg.textContent = '已选择 ' + hostOf(best.o) + '(' + Math.round(best.ms) + ' ms),正在跳转…';
    // 留 600ms 让测速结果可见,也留出手动点其它通道的窗口。
    setTimeout(() => { location.href = destFor(best.o); }, 600);
  });
})();
