/* mobile-terminal-web frontend
   Transport chain, most to least capable — the client walks down until one works:
     1. WebSocket          (bidirectional, lowest latency)
     2. SSE + POST         (downstream is one continuous HTTP stream: no polling gaps)
     3. long-poll + POST   (last resort, works anywhere HTTPS works)
*/
(() => {
  const params = new URLSearchParams(location.search);
  let sessionName = (params.get('session') || localStorage.getItem('session') || 'mobile').replace(/[^\w-]/g, '');
  const isPhone = Math.min(window.screen.width, window.screen.height) < 500;
  let fontSize = parseInt(localStorage.getItem('fontSize'), 10) || (isPhone ? 12 : 15);

  const statusEl = document.getElementById('status');
  const sessionEl = document.getElementById('session-name');

  const term = new Terminal({
    fontSize,
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    macOptionIsMeta: true, // Mac browsers: Option+key sends ESC-key (Alt) instead of typing special chars
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      selectionBackground: '#264f78',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  // xterm.js defaults to Unicode 6 width tables — emoji and modern symbols get
  // measured width-1 while tmux/apps lay them out width-2, garbling the UI
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(document.getElementById('term'));

  // Maple Mono NF CN is a ~6MB webfont: start with the system font, switch once
  // loaded — xterm.js measures cell size from the font, so switching before the
  // font is ready would garble the grid
  document.fonts.load('1em "Maple Mono NF CN"').then((faces) => {
    if (!faces.length) return; // font unavailable: stay on fallback
    term.options.fontFamily = "'Maple Mono NF CN', ui-monospace, Menlo, Consolas, monospace";
    fit.fit();
    sendResize();
  }).catch(() => {});

  let ctrlActive = false;
  let altActive = false;
  const ctrlBtn = document.getElementById('key-ctrl');
  const altBtn = document.getElementById('key-alt');

  let rttMs = null;
  let rttSamples = [];
  let reconnects = 0;
  let transportLabel = '?';
  function noteRtt(ms) {
    rttMs = rttMs === null ? ms : Math.round(rttMs * 0.7 + ms * 0.3); // smoothed
    rttSamples.push(Math.round(ms));
    if (rttSamples.length > 120) rttSamples.shift();
  }

  // report measured RTTs to the server every 60s (and on page close) so latency
  // per entry-domain / transport can be analyzed server-side: /t/metrics/summary
  function reportMetrics(useBeacon) {
    if (!rttSamples.length) return;
    const payload = JSON.stringify({
      samples: rttSamples,
      transport: transportLabel,
      reconnects,
      ua: navigator.userAgent.slice(0, 120),
    });
    rttSamples = [];
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon('/t/metrics', new Blob([payload], { type: 'application/json' }));
    } else {
      fetchT('/t/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }, 10000).catch(() => {});
    }
  }
  setInterval(() => reportMetrics(false), 60000);
  function setStatus(on, text) {
    statusEl.className = on ? 'on' : 'off';
    statusEl.textContent = on && rttMs !== null ? `${text} ${rttMs}ms` : text;
    sessionEl.textContent = `tmux: ${sessionName}`;
  }

  // ------------------------------------------------------------------
  // transports — each returns a handle {send(str), resize(c,r), close(), ping?()}
  // and calls hooks: onUp(label), onDown(), onData(strOrBytes)
  //
  // The direct (non-CDN) path can be silently blackholed by middleboxes: the
  // connection looks open but nothing flows. Every transport therefore has a
  // liveness watchdog and every fetch a timeout, so a dead link tears itself
  // down within seconds and reconnection (or transport downgrade) kicks in.
  // ------------------------------------------------------------------
  const WS_PROBE_MS = 4000;
  const SSE_PROBE_MS = 4000;
  const WS_STALE_MS = 25000;   // no pong/data for this long => link is dead
  const SSE_STALE_MS = 45000;  // server sends a real "ka" event every 20s

  function fetchT(url, opts = {}, ms = 10000) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
  }

  function tryWebSocket(hooks) {
    return new Promise((resolve) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?session=${sessionName}&cols=${term.cols}&rows=${term.rows}`);
      ws.binaryType = 'arraybuffer';
      let opened = false;
      const probe = setTimeout(() => { if (!opened) { ws.close(); resolve(null); } }, WS_PROBE_MS);

      let lastAlive = Date.now();
      ws.onopen = () => {
        opened = true;
        lastAlive = Date.now();
        clearTimeout(probe);
        const pinger = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
          if (Date.now() - lastAlive > WS_STALE_MS) ws.close(); // blackholed: force reconnect
        }, 10000);
        hooks.onUp('WS');
        resolve({
          send: (d) => ws.send(JSON.stringify({ t: 'i', d })),
          resize: (cols, rows) => ws.send(JSON.stringify({ t: 'r', cols, rows })),
          close: () => { clearInterval(pinger); ws.onclose = null; ws.close(); },
          ping: () => { // foreground-return probe: dead within 3s => reconnect
            if (ws.readyState !== WebSocket.OPEN) return ws.close();
            ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
            setTimeout(() => { if (Date.now() - lastAlive > 3000) ws.close(); }, 3000);
          },
          _pinger: pinger,
        });
      };
      ws.onmessage = (ev) => {
        lastAlive = Date.now();
        if (ev.data instanceof ArrayBuffer) return hooks.onData(new Uint8Array(ev.data));
        try {
          const m = JSON.parse(ev.data);
          if (m.t === 'pong') { noteRtt(Date.now() - m.ts); setStatus(true, '已连接 (WS)'); }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        clearTimeout(probe);
        if (!opened) resolve(null);
        else hooks.onDown();
      };
      ws.onerror = () => {};
    });
  }

  async function tryHttp(hooks, allowSse) {
    let sid;
    try {
      const t0 = Date.now();
      const r = await fetchT('/t/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionName, cols: term.cols, rows: term.rows }),
      }, 8000);
      if (!r.ok) return null;
      noteRtt(Date.now() - t0);
      sid = (await r.json()).sid;
    } catch {
      return null;
    }

    let alive = true;
    function teardown() {
      if (!alive) return;
      alive = false;
      clearInterval(sseWatch);
      if (es) es.close();
      hooks.onDown();
    }

    // serialized input queue: keystrokes arriving while a POST is in flight
    // get coalesced into the next POST, preserving order
    let inQueue = [];
    let inFlight = false;
    let inFailures = 0;
    async function pump() {
      if (inFlight || !inQueue.length || !alive) return;
      inFlight = true;
      const batch = inQueue;
      inQueue = [];
      const body = {};
      let data = '';
      for (const item of batch) {
        if (item.d !== undefined) data += item.d;
        if (item.r) body.r = item.r; // latest resize wins
      }
      if (data) body.d = data;
      try {
        const t0 = Date.now();
        await fetchT(`/t/in?sid=${sid}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }, 10000);
        noteRtt(Date.now() - t0);
        inFailures = 0;
      } catch {
        // put the batch back (front, order preserved) and retry; a persistently
        // dead link tears the transport down so reconnection can take over
        inQueue = batch.concat(inQueue);
        if (++inFailures >= 3) { inFlight = false; return teardown(); }
      }
      inFlight = false;
      pump();
    }

    let sseWatch = null;
    const handle = {
      send: (d) => { inQueue.push({ d }); pump(); },
      resize: (cols, rows) => { inQueue.push({ r: { cols, rows } }); pump(); },
      close: () => {
        alive = false;
        clearInterval(sseWatch);
        if (es) es.close();
        navigator.sendBeacon && navigator.sendBeacon(`/t/close?sid=${sid}`);
      },
      ping: () => { // foreground-return probe: unreachable => reconnect
        fetchT(`/t/in?sid=${sid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 5000)
          .then((r) => { if (r.status === 404) teardown(); })
          .catch(() => teardown());
      },
    };

    // --- downstream: try SSE first ---
    let es = null;
    if (allowSse && typeof EventSource !== 'undefined') {
      const sseOk = await new Promise((resolve) => {
        es = new EventSource(`/t/sse?sid=${sid}`);
        const probe = setTimeout(() => { es.close(); es = null; resolve(false); }, SSE_PROBE_MS);
        es.addEventListener('hello', () => { clearTimeout(probe); resolve(true); });
        es.onerror = () => {
          // before hello: transport unusable; after: connection dropped
          if (es && es.readyState === EventSource.CLOSED) { clearTimeout(probe); es = null; resolve(false); }
        };
      });
      if (sseOk && es) {
        let lastSse = Date.now();
        es.onmessage = (ev) => { lastSse = Date.now(); hooks.onData(JSON.parse(ev.data)); };
        es.addEventListener('ka', () => { lastSse = Date.now(); }); // server liveness beacon (20s cadence)
        es.addEventListener('exit', teardown);
        es.onerror = () => teardown();
        sseWatch = setInterval(() => { if (Date.now() - lastSse > SSE_STALE_MS) teardown(); }, 10000);
        hooks.onUp('SSE');
        return handle;
      }
    }

    // --- downstream: long-poll fallback ---
    (async () => {
      let failures = 0;
      while (alive) {
        try {
          const r = await fetchT(`/t/poll?sid=${sid}`, {}, 35000); // server holds 25s
          if (r.status === 404) break; // session GC'd
          const m = await r.json();
          failures = 0;
          for (const chunk of m.o) hooks.onData(chunk);
          if (m.exit) break;
        } catch {
          if (++failures > 3) break;
          await new Promise((ok) => setTimeout(ok, 1000 * failures));
        }
      }
      teardown();
    })();
    hooks.onUp('轮询');
    return handle;
  }

  // ------------------------------------------------------------------
  // connection manager
  // ------------------------------------------------------------------
  let transport = null;
  let retryMs = 500;
  let connecting = false;

  async function connect() {
    if (connecting) return;
    connecting = true;
    setStatus(false, '连接中…');
    fit.fit();

    const hooks = {
      onUp: (label) => { transportLabel = label; retryMs = 500; setStatus(true, `已连接 (${label})`); term.focus(); },
      onData: (d) => term.write(d),
      onDown: () => {
        transport = null;
        reconnects++;
        setStatus(false, '已断开，重连中…');
        setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 8000);
      },
    };

    transport = await tryWebSocket(hooks);
    if (!transport) transport = await tryHttp(hooks, true);
    connecting = false;

    if (!transport) {
      setStatus(false, '连接失败，重试中…');
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 8000);
    } else {
      transport.resize(term.cols, term.rows);
    }
  }

  function send(data) { if (transport) transport.send(data); }
  function sendResize() { if (transport) transport.resize(term.cols, term.rows); }

  // Apply sticky Ctrl/Alt modifiers to outgoing data
  function transformInput(data) {
    let out = data;
    if (ctrlActive && data.length === 1) {
      const c = data.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) out = String.fromCharCode(c & 0x1f);
      ctrlActive = false;
      ctrlBtn.classList.remove('active');
    }
    if (altActive) {
      out = '\x1b' + out;
      altActive = false;
      altBtn.classList.remove('active');
    }
    return out;
  }

  term.onData((data) => send(transformInput(data)));

  // --- touch scrolling ---
  // tmux keeps history in its own scrollback (the terminal runs in the
  // alternate buffer, so the browser-side viewport has nothing to scroll).
  // Translate vertical swipes into mouse-wheel reports; tmux (mouse mode is
  // enabled server-side on attach) then enters copy-mode and scrolls history.
  const termContainer = document.getElementById('term');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let touchPos = null;

  function swipeScroll(lines, t, rect) {
    if (term.modes.mouseTrackingMode !== 'none') {
      const col = clamp(Math.ceil((t.clientX - rect.left) / (rect.width / term.cols)), 1, term.cols);
      const row = clamp(Math.ceil((t.clientY - rect.top) / (rect.height / term.rows)), 1, term.rows);
      const btn = lines < 0 ? 64 : 65; // SGR wheel-up / wheel-down
      send(`\x1b[<${btn};${col};${row}M`.repeat(Math.abs(lines)));
    } else if (term.buffer.active.type === 'normal') {
      term.scrollLines(lines); // plain program without mouse: scroll xterm's buffer
    }
  }

  termContainer.addEventListener('touchstart', (e) => {
    touchPos = e.touches.length === 1 ? { y: e.touches[0].clientY } : null;
  }, { capture: true, passive: true });

  termContainer.addEventListener('touchmove', (e) => {
    if (!touchPos || e.touches.length !== 1) return;
    const t = e.touches[0];
    const screenEl = termContainer.querySelector('.xterm-screen');
    if (!screenEl) return;
    const rect = screenEl.getBoundingClientRect();
    const cellH = rect.height / term.rows;
    const lines = Math.trunc((t.clientY - touchPos.y) / cellH);
    if (lines !== 0) {
      touchPos.y += lines * cellH;
      swipeScroll(-lines, t, rect); // finger moves down => reveal earlier output
    }
    e.preventDefault(); // suppress page scroll / pull-to-refresh / xterm's own handling
    e.stopPropagation();
  }, { capture: true, passive: false });

  termContainer.addEventListener('touchend', () => { touchPos = null; }, { capture: true, passive: true });

  // --- layout: track the visual viewport so the toolbar rides above the soft keyboard ---
  function applyViewport() {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${h}px`);
    fit.fit();
    sendResize();
    // keep the app pinned to the visible area (iOS scrolls the page when the keyboard opens)
    window.scrollTo(0, 0);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', applyViewport);
    window.visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
  }
  window.addEventListener('resize', applyViewport);
  window.addEventListener('orientationchange', () => setTimeout(applyViewport, 300));

  // returning to the foreground: reconnect if down, otherwise actively probe —
  // a connection blackholed while backgrounded looks open but is dead
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!transport) connect();
    else if (transport.ping) transport.ping();
  });
  window.addEventListener('pagehide', () => {
    reportMetrics(true);
    if (transport) transport.close();
  });

  // --- toolbar keys ---
  const ESCAPES = { '\\x1b': '\x1b', '\\t': '\t', '\\x03': '\x03', '\\x04': '\x04' };
  document.querySelectorAll('#toolbar .key[data-seq]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // data-seq holds a JS-style escaped string; decode \xNN and \[ sequences
      const seq = btn.dataset.seq.replace(/\\x1b|\\t|\\x03|\\x04/g, (m) => ESCAPES[m]);
      send(transformInput(seq));
      term.focus();
    });
  });

  ctrlBtn.addEventListener('click', () => {
    ctrlActive = !ctrlActive;
    ctrlBtn.classList.toggle('active', ctrlActive);
    term.focus();
  });
  altBtn.addEventListener('click', () => {
    altActive = !altActive;
    altBtn.classList.toggle('active', altActive);
    term.focus();
  });

  // --- image upload ---
  // A browser's clipboard/photo library can't reach the server's clipboard, so
  // "paste image" shortcuts inside server-side TUIs can never see it. Instead we
  // upload the image over the existing (authenticated, encrypted) channel and
  // type its server-side path into the terminal — TUIs like Claude Code accept
  // image paths in the prompt.
  function flashNote(text, ms = 3000) {
    sessionEl.textContent = text;
    setTimeout(() => { sessionEl.textContent = `tmux: ${sessionName}`; }, ms);
  }

  // multi-MP phone photos are 10-25MB — pointless for a terminal and beyond the
  // server cap. Re-encode to <=2560px JPEG before uploading (usually <1MB).
  async function shrinkImage(file) {
    if (file.size < 1.5e6 && file.type !== 'image/heic') return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.85));
      return blob && blob.size < file.size ? blob : file;
    } catch {
      return file; // e.g. HEIC on non-Safari: browser can't decode, send as-is
    }
  }

  async function uploadImage(orig) {
    if (!orig || !orig.type.startsWith('image/')) return;
    flashNote('处理图片中…', 30000);
    const file = await shrinkImage(orig);
    if (file.size > 15 << 20) { flashNote('图片太大（>15MB）且无法压缩，试试截图'); return; }
    flashNote(`上传中… (${Math.round(file.size / 1024)}KB)`, 30000);
    try {
      const r = await fetchT('/t/upload', { method: 'POST', headers: { 'Content-Type': file.type }, body: file }, 60000);
      const m = await r.json().catch(() => ({}));
      if (!r.ok) { flashNote(`上传失败: ${m.error || 'HTTP ' + r.status}`); return; }
      send(m.path + ' '); // type the path at the cursor; TUIs pick it up from the prompt
      flashNote('已插入图片路径');
    } catch (e) {
      flashNote(e.name === 'AbortError' ? '上传超时，网络太慢' : '上传失败: 网络错误');
    }
    term.focus();
  }

  const imgInput = document.getElementById('img-input');
  document.getElementById('btn-img').addEventListener('click', () => imgInput.click());
  imgInput.addEventListener('change', () => {
    for (const f of imgInput.files) uploadImage(f);
    imgInput.value = '';
  });

  // clipboard button: mobile long-press paste menus don't hand images to web
  // pages, but the async Clipboard API can read them (user gesture required)
  document.getElementById('btn-clip').addEventListener('click', async () => {
    if (!navigator.clipboard || !navigator.clipboard.read) return flashNote('浏览器不支持读剪贴板，请用 📷');
    try {
      const items = await navigator.clipboard.read();
      let found = 0;
      for (const item of items) {
        const t = item.types.find((x) => x.startsWith('image/'));
        if (t) { found++; uploadImage(await item.getType(t)); }
      }
      if (!found) flashNote('剪贴板里没有图片');
    } catch {
      flashNote('剪贴板读取被拒绝或为空');
    }
  });

  // desktop: pasting an image (Ctrl/Cmd+V) uploads it; text paste stays native
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const imgs = [...items].filter((i) => i.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    for (const i of imgs) uploadImage(i.getAsFile());
  });

  // --- status bar buttons ---
  document.getElementById('btn-font-inc').addEventListener('click', () => setFont(fontSize + 1));
  document.getElementById('btn-font-dec').addEventListener('click', () => setFont(fontSize - 1));
  function setFont(px) {
    fontSize = Math.max(9, Math.min(24, px));
    localStorage.setItem('fontSize', fontSize);
    term.options.fontSize = fontSize;
    fit.fit();
    sendResize();
  }

  document.getElementById('btn-session').addEventListener('click', () => {
    const name = prompt('tmux 会话名（不存在会自动创建）：', sessionName);
    if (!name) return;
    sessionName = name.replace(/[^\w-]/g, '') || 'mobile';
    localStorage.setItem('session', sessionName);
    if (transport) { const t = transport; transport = null; t.close(); }
    term.reset();
    connect();
  });

  applyViewport();
  connect();
})();
