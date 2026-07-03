/* mobile-terminal-web frontend
   Transport chain, most to least capable — the client walks down until one works:
     1. WebSocket          (bidirectional, lowest latency)
     2. SSE + POST         (downstream is one continuous HTTP stream: no polling gaps)
     3. long-poll + POST   (last resort, works anywhere HTTPS works)
*/
(() => {
  const params = new URLSearchParams(location.search);
  let sessionName = (params.get('session') || localStorage.getItem('session') || 'mobile').replace(/[^\w-]/g, '');
  let fontSize = parseInt(localStorage.getItem('fontSize'), 10) || 15;

  const statusEl = document.getElementById('status');
  const sessionEl = document.getElementById('session-name');

  const term = new Terminal({
    fontSize,
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
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
  term.open(document.getElementById('term'));

  let ctrlActive = false;
  let altActive = false;
  const ctrlBtn = document.getElementById('key-ctrl');
  const altBtn = document.getElementById('key-alt');

  let rttMs = null;
  function noteRtt(ms) {
    rttMs = rttMs === null ? ms : Math.round(rttMs * 0.7 + ms * 0.3); // smoothed
  }
  function setStatus(on, text) {
    statusEl.className = on ? 'on' : 'off';
    statusEl.textContent = on && rttMs !== null ? `${text} ${rttMs}ms` : text;
    sessionEl.textContent = `tmux: ${sessionName}`;
  }

  // ------------------------------------------------------------------
  // transports — each returns a handle {send(str), resize(c,r), close()}
  // and calls hooks: onUp(label), onDown(), onData(strOrBytes)
  // ------------------------------------------------------------------
  const WS_PROBE_MS = 4000;
  const SSE_PROBE_MS = 4000;

  function tryWebSocket(hooks) {
    return new Promise((resolve) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?session=${sessionName}&cols=${term.cols}&rows=${term.rows}`);
      ws.binaryType = 'arraybuffer';
      let opened = false;
      const probe = setTimeout(() => { if (!opened) { ws.close(); resolve(null); } }, WS_PROBE_MS);

      ws.onopen = () => {
        opened = true;
        clearTimeout(probe);
        const pinger = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
        }, 10000);
        hooks.onUp('WS');
        resolve({
          send: (d) => ws.send(JSON.stringify({ t: 'i', d })),
          resize: (cols, rows) => ws.send(JSON.stringify({ t: 'r', cols, rows })),
          close: () => { clearInterval(pinger); ws.onclose = null; ws.close(); },
          _pinger: pinger,
        });
      };
      ws.onmessage = (ev) => {
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
      const r = await fetch('/t/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionName, cols: term.cols, rows: term.rows }),
      });
      if (!r.ok) return null;
      noteRtt(Date.now() - t0);
      sid = (await r.json()).sid;
    } catch {
      return null;
    }

    let alive = true;
    // serialized input queue: keystrokes arriving while a POST is in flight
    // get coalesced into the next POST, preserving order
    let inQueue = [];
    let inFlight = false;
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
        await fetch(`/t/in?sid=${sid}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        noteRtt(Date.now() - t0);
      } catch { /* dropped input is retried by the user; connection loss surfaces via downstream */ }
      inFlight = false;
      pump();
    }

    const handle = {
      send: (d) => { inQueue.push({ d }); pump(); },
      resize: (cols, rows) => { inQueue.push({ r: { cols, rows } }); pump(); },
      close: () => {
        alive = false;
        if (es) es.close();
        navigator.sendBeacon && navigator.sendBeacon(`/t/close?sid=${sid}`);
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
        es.onmessage = (ev) => hooks.onData(JSON.parse(ev.data));
        es.addEventListener('exit', () => { alive = false; hooks.onDown(); });
        es.onerror = () => { if (alive) { alive = false; hooks.onDown(); } };
        hooks.onUp('SSE');
        return handle;
      }
    }

    // --- downstream: long-poll fallback ---
    (async () => {
      let failures = 0;
      while (alive) {
        try {
          const r = await fetch(`/t/poll?sid=${sid}`);
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
      if (alive) { alive = false; hooks.onDown(); }
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
      onUp: (label) => { retryMs = 500; setStatus(true, `已连接 (${label})`); term.focus(); },
      onData: (d) => term.write(d),
      onDown: () => {
        transport = null;
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

  // reconnect promptly when the app returns to the foreground
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !transport) connect();
  });
  window.addEventListener('pagehide', () => { if (transport) transport.close(); });

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
