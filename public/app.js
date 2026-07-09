/* mobile-terminal-web frontend
   Transport chain, most to least capable — the client walks down until one works:
     1. WebSocket          (bidirectional, lowest latency)
     2. SSE + POST         (downstream is one continuous HTTP stream: no polling gaps)
     3. long-poll + POST   (last resort, works anywhere HTTPS works)
*/
(() => {
  const params = new URLSearchParams(location.search);
  const sanitizeName = (n) => String(n || '').replace(/[^\w-]/g, '').slice(0, 32);
  // Per-tab session: sessionStorage keeps this tab's own session across refresh,
  // independent of other tabs. Resolution order — explicit URL param, then this
  // tab's last session, then the global "last used" (seeds a fresh tab), then default.
  let sessionName = sanitizeName(
    params.get('session') || sessionStorage.getItem('session') ||
    localStorage.getItem('session') || 'mobile') || 'mobile';
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

  // --- copy / paste ---
  // tmux mouse mode (enabled on attach for touch scrolling) swallows mouse drags
  // as SGR reports, so the browser never forms a selection to copy — and Ctrl+C
  // is the terminal interrupt, not copy. So we bridge the clipboard explicitly:
  // Shift+drag makes xterm do a local selection (bypassing mouse reporting),
  // then these paths move text in/out of the system clipboard.
  async function clipWrite(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to legacy path */ }
    try { // http / older browsers: hidden textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }

  async function clipRead() {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        return await navigator.clipboard.readText();
      }
    } catch { /* permission denied or unavailable */ }
    return null;
  }

  // Remember the last non-empty selection: invoking copy (button click, or a
  // shortcut some browsers grab) can clear xterm's live selection before doCopy
  // reads it, so capture the text the moment the selection is made.
  let lastSelection = '';
  term.onSelectionChange(() => { const s = term.getSelection(); if (s) lastSelection = s; });

  // read the visible viewport as plain text (fallback when nothing is selected)
  function readVisible() {
    const buf = term.buffer && term.buffer.active;
    if (!buf) return '';
    const lines = [];
    for (let i = 0; i < term.rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n').replace(/\s+$/, '');
  }

  // copy the current selection, or the whole visible screen if nothing selected.
  // Reports the character count so an empty/wrong copy is diagnosable at a glance.
  async function doCopy() {
    const sel = term.getSelection() || lastSelection;
    const fromSel = !!sel;
    const text = sel || readVisible();
    const ok = await clipWrite(text);
    flashNote(!ok ? '复制失败：剪贴板不可用'
      : text ? `已复制${fromSel ? '选区' : '整屏'} ${text.length} 字`
      : '没有可复制的内容（未选中且屏幕为空）');
    lastSelection = ''; // consumed
    term.focus();
  }

  async function doPaste() {
    const text = await clipRead();
    if (text == null) { flashNote('粘贴失败：浏览器拒绝读剪贴板'); return; }
    if (text) send(text);
    term.focus();
  }

  // No custom Ctrl+C/Ctrl+V handling: Ctrl+C stays the terminal interrupt and
  // Ctrl+V stays native paste (which also lets the desktop image-paste `paste`
  // event fire). Copy happens via OSC 52 (select-to-copy) or the copy button;
  // paste via native Ctrl+V or the paste button.

  // OSC 52 clipboard: TUIs (Claude Code, tmux, vim…) emit `ESC]52;c;<base64>` to
  // set the system clipboard on select-to-copy. xterm.js drops this by default,
  // so the app "sends 25 chars via OSC 52" but nothing reaches the clipboard.
  // Bridge it to the real clipboard; ignore read requests (`?`) for privacy.
  term.parser.registerOscHandler(52, (data) => {
    const semi = data.indexOf(';');
    const b64 = semi === -1 ? data : data.slice(semi + 1);
    if (!b64 || b64 === '?') return true;
    try {
      const bin = atob(b64);
      const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      clipWrite(text).then((ok) => { if (ok) flashNote(`已复制 ${text.length} 字`); });
    } catch { /* malformed payload: leave clipboard untouched */ }
    return true; // handled either way
  });

  // --- bell: audio + background title notification ---
  // TUIs (Claude Code, shells) emit BEL (\x07) when work finishes; tmux forwards
  // it (visual-bell off), xterm.js fires onBell. Play a short synthesized chime
  // (no external asset) and, when the tab is backgrounded, flash the title as a
  // silent fallback (mobile browsers often suspend audio in the background).
  let bellOn = localStorage.getItem('bell') !== 'off'; // default on
  const bellBtn = document.getElementById('btn-bell');
  // inline SVG (Lucide bell / bell-off) so the toggle stays a real icon, not an
  // emoji; the accessible name lives on the button's title (see renderBell)
  const BELL_ON_SVG = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.268 21a2 2 0 0 0 3.464 0m-10.47-5.674A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>';
  const BELL_OFF_SVG = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.268 21a2 2 0 0 0 3.464 0M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742M2 2l20 20M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"/></svg>';
  function renderBell() {
    bellBtn.innerHTML = bellOn ? BELL_ON_SVG : BELL_OFF_SVG;
    bellBtn.title = bellOn ? '完成提示音：开' : '完成提示音：关';
  }
  renderBell();

  let audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch { /* Web Audio unavailable */ }
  }
  // browsers block audio until a user gesture — unlock on the first interaction
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  function beep() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    for (const [dt, freq] of [[0, 880], [0.12, 1320]]) { // two-tone "ding-dong"
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + dt);
      gain.gain.exponentialRampToValueAtTime(0.25, now + dt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dt + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + dt);
      osc.stop(now + dt + 0.2);
    }
  }

  const baseTitle = document.title;
  let titleFlashed = false;
  function flashTitle() {
    if (!document.hidden || titleFlashed) return;
    document.title = '🔔 完成 · ' + baseTitle;
    titleFlashed = true;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && titleFlashed) { document.title = baseTitle; titleFlashed = false; }
  });

  bellBtn.addEventListener('click', () => {
    bellOn = !bellOn;
    localStorage.setItem('bell', bellOn ? 'on' : 'off');
    renderBell();
    if (bellOn) { unlockAudio(); beep(); } // the click is a gesture: preview the sound
  });

  let lastBeep = 0;
  term.onBell(() => {
    flashTitle(); // silent fallback fires regardless of the sound toggle
    if (!bellOn) return;
    const t = Date.now();
    if (t - lastBeep < 2000) return; // coalesce bursts to one chime per 2s
    lastBeep = t;
    unlockAudio();
    beep();
  });

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
  // Keys send bytes straight down the transport, so they never need terminal
  // focus. On mobile the soft keyboard pops because the hidden xterm textarea
  // holds focus (activeElement) even after the keyboard is dismissed, so any
  // tap makes iOS re-present it. On pointerdown we:
  //   1. preventDefault  → the button never steals focus (avoids the flicker
  //      of losing focus and having it restored), and
  //   2. on touch, blur the textarea → drop that latent focus before iOS can
  //      re-present the keyboard for the tap. This unconditionally keeps the
  //      keyboard from popping when a toolbar key is used; the trade-off is
  //      that tapping a key mid-typing dismisses the keyboard (tap the terminal
  //      to bring it back). On desktop (mouse) we keep focus so typing flows.
  document.querySelectorAll('#toolbar .key').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (e.pointerType !== 'mouse' && term.textarea) term.textarea.blur();
    });
  });

  const ESCAPES = { '\\x1b': '\x1b', '\\t': '\t', '\\x03': '\x03', '\\x04': '\x04' };
  document.querySelectorAll('#toolbar .key[data-seq]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // data-seq holds a JS-style escaped string; decode \xNN and \[ sequences
      const seq = btn.dataset.seq.replace(/\\x1b|\\t|\\x03|\\x04/g, (m) => ESCAPES[m]);
      send(transformInput(seq));
    });
  });

  ctrlBtn.addEventListener('click', () => {
    ctrlActive = !ctrlActive;
    ctrlBtn.classList.toggle('active', ctrlActive);
  });
  altBtn.addEventListener('click', () => {
    altActive = !altActive;
    altBtn.classList.toggle('active', altActive);
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

  // 通用上传:任意类型,不再编码。dir 可选(面板传当前浏览目录;终端原生入口省略 → 服务端默认 /root/uploads)。
  // 返回服务端落地路径,失败返回 null(已 flashNote)。
  async function uploadFile(file, dir) {
    if (!file) return null;
    if (file.size > 100 << 20) { flashNote(`文件太大（>100MB）: ${file.name || ''}`); return null; }
    flashNote(`上传中… ${file.name || ''} (${Math.round(file.size / 1024)}KB)`, 120000);
    const qs = new URLSearchParams();
    if (dir) qs.set('dir', dir);
    if (file.name) qs.set('name', file.name);
    const suffix = qs.toString() ? `?${qs}` : '';
    try {
      const r = await fetchT(`/t/upload${suffix}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      }, 120000);
      const m = await r.json().catch(() => ({}));
      if (!r.ok) {
        flashNote(m.error ? `上传失败: ${m.error}` : `上传失败: HTTP ${r.status}（非应用响应，疑似被 Cloudflare 拦截）`, 6000);
        return null;
      }
      return m.path;
    } catch (e) {
      flashNote(e.name === 'AbortError' ? '上传超时，网络太慢' : '上传失败: 网络错误');
      return null;
    }
  }

  async function uploadImage(orig) {
    if (!orig || !orig.type.startsWith('image/')) return;
    flashNote('处理图片中…', 30000);
    const file = await shrinkImage(orig); // 返回 Blob（无 name)→ 服务端按 mime 生成名
    const p = await uploadFile(file, null);
    if (p) { send(p + ' '); flashNote('已插入图片路径'); }
    term.focus();
  }

  const imgInput = document.getElementById('img-input');
  document.getElementById('btn-img').addEventListener('click', () => imgInput.click());
  imgInput.addEventListener('change', () => {
    for (const f of imgInput.files) uploadImage(f);
    imgInput.value = '';
  });

  const fileInput = document.getElementById('file-input');
  document.getElementById('btn-file').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) {
      const p = await uploadFile(f, null);
      if (p) send(p + ' '); // 把落地路径打进终端
    }
    fileInput.value = '';
    term.focus();
  });

  // clipboard button: mobile long-press paste menus don't hand images to web
  // pages, but the async Clipboard API can read them (user gesture required)
  document.getElementById('btn-clip').addEventListener('click', async () => {
    if (!navigator.clipboard || !navigator.clipboard.read) return flashNote('浏览器不支持读剪贴板，请用相册按钮');
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
  document.getElementById('btn-copy').addEventListener('click', doCopy);
  document.getElementById('btn-paste').addEventListener('click', doPaste);
  document.getElementById('btn-font-inc').addEventListener('click', () => setFont(fontSize + 1));
  document.getElementById('btn-font-dec').addEventListener('click', () => setFont(fontSize - 1));
  function setFont(px) {
    fontSize = Math.max(9, Math.min(24, px));
    localStorage.setItem('fontSize', fontSize);
    term.options.fontSize = fontSize;
    fit.fit();
    sendResize();
  }

  // --- session panel & per-tab MRU ---
  const MRU_MAX = 8;
  function getMru() {
    try { const a = JSON.parse(sessionStorage.getItem('sessionMRU')); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  // Record the active session: this tab (sessionStorage) + its MRU queue, plus
  // the global "last used" (localStorage) so future new tabs start from here.
  function rememberSession(name) {
    sessionStorage.setItem('session', name);
    localStorage.setItem('session', name);
    const mru = [name, ...getMru().filter((n) => n !== name)].slice(0, MRU_MAX);
    sessionStorage.setItem('sessionMRU', JSON.stringify(mru));
  }
  // force a fresh (re)connect to a session — used by switch and by delete-current
  // (where the target name may equal sessionName but the old tmux session is gone)
  function connectSession(name) {
    sessionName = sanitizeName(name) || 'mobile';
    rememberSession(sessionName);
    if (transport) { const t = transport; transport = null; t.close(); }
    term.reset();
    connect();
    closePanel();
  }
  function switchSession(name) {
    const n = sanitizeName(name);
    if (!n || n === sessionName) { closePanel(); return; } // already here: no-op
    connectSession(n);
  }
  async function deleteSession(name) {
    if (!confirm(`删除会话 “${name}”？该会话内所有进程都会终止，不可恢复。`)) return;
    let ok = false;
    try {
      const r = await fetchT('/t/kill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }, 5000);
      ok = r.ok;
    } catch { /* network error */ }
    if (!ok) { flashNote('删除失败'); return; }
    // drop from this tab's MRU
    sessionStorage.setItem('sessionMRU', JSON.stringify(getMru().filter((n) => n !== name)));
    if (name === sessionName) {
      // deleting the session we're attached to: hop to another live one, else default
      let next = 'mobile';
      try {
        const r = await fetchT('/t/sessions', {}, 5000);
        if (r.ok) {
          const others = (await r.json()).sessions.map((s) => s.name).filter((n) => n !== name);
          if (others.length) next = others[0];
        }
      } catch { /* keep default */ }
      connectSession(next);
    } else {
      openPanel(); // just refresh the list
    }
  }

  const panel = document.getElementById('session-panel');
  const panelList = document.getElementById('sp-list');
  const panelMru = document.getElementById('sp-mru');
  const panelInput = document.getElementById('sp-new');
  function closePanel() { panel.hidden = true; }
  async function openPanel() {
    document.getElementById('file-panel').hidden = true;
    panel.hidden = false;
    panelInput.value = '';
    // MRU chips for this tab (skip the current session — it's already active)
    panelMru.innerHTML = '';
    for (const n of getMru().filter((x) => x !== sessionName)) {
      const chip = document.createElement('button');
      chip.className = 'sp-chip';
      chip.textContent = n;
      chip.addEventListener('click', () => switchSession(n));
      panelMru.appendChild(chip);
    }
    panelMru.parentElement.hidden = panelMru.children.length === 0;
    // live server sessions
    panelList.innerHTML = '<div class="sp-empty">加载中…</div>';
    let sessions = null;
    try {
      const r = await fetchT('/t/sessions', {}, 5000);
      if (r.ok) sessions = (await r.json()).sessions;
    } catch { /* fall through to error state */ }
    if (!sessions) { panelList.innerHTML = '<div class="sp-empty">无法获取会话列表（可新建）</div>'; return; }
    if (!sessions.length) { panelList.innerHTML = '<div class="sp-empty">暂无活跃会话（新建一个）</div>'; return; }
    panelList.innerHTML = '';
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'sp-row' + (s.name === sessionName ? ' current' : '');
      const pick = document.createElement('button');
      pick.className = 'sp-pick';
      pick.innerHTML = `<span class="sp-name"></span><span class="sp-meta"></span>`;
      pick.querySelector('.sp-name').textContent = s.name;
      pick.querySelector('.sp-meta').textContent = `${s.windows} 窗口${s.attached ? ' · ●' : ''}`;
      pick.addEventListener('click', () => switchSession(s.name));
      const del = document.createElement('button');
      del.className = 'sp-del';
      del.innerHTML = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      del.title = '删除会话';
      del.addEventListener('click', () => deleteSession(s.name));
      row.append(pick, del);
      panelList.appendChild(row);
    }
  }

  document.getElementById('btn-session').addEventListener('click', openPanel);
  document.getElementById('sp-close').addEventListener('click', closePanel);
  panel.addEventListener('click', (e) => { if (e.target === panel) closePanel(); });
  document.getElementById('sp-create').addEventListener('click', () => switchSession(panelInput.value));
  panelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') switchSession(panelInput.value); });

  rememberSession(sessionName); // persist the resolved session for this tab
  applyViewport();
  connect();

  // --- 文件浏览器面板 ---
  const filePanel = document.getElementById('file-panel');
  const fpPath = document.getElementById('fp-path');
  const fpList = document.getElementById('fp-list');
  const fpInput = document.getElementById('fp-input');
  let fpCwd = null; // 当前浏览目录（绝对路径)

  function fmtSize(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1048576) return `${Math.round(n / 1024)}K`;
    return `${(n / 1048576).toFixed(1)}M`;
  }

  // 文件行类型图标（静态 SVG 常量，Lucide folder/link/file）——列表标记不用 emoji
  const FP_ICON_DIR = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
  const FP_ICON_LINK = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  const FP_ICON_FILE = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/></svg>';
  async function fpLoad(dir) {
    fpList.innerHTML = '<div class="sp-empty">加载中…</div>';
    const url = dir ? `/t/ls?path=${encodeURIComponent(dir)}` : '/t/ls';
    let data;
    try {
      const r = await fetchT(url, {}, 8000);
      data = await r.json().catch(() => ({}));
      if (!r.ok) { fpList.innerHTML = '<div class="sp-empty"></div>'; fpList.firstChild.textContent = data.error || `HTTP ${r.status}`; return; }
    } catch { fpList.innerHTML = '<div class="sp-empty">网络错误</div>'; return; }

    if (!data || !Array.isArray(data.entries)) { fpList.innerHTML = '<div class="sp-empty">返回数据异常</div>'; return; }
    fpCwd = data.path;
    fpPath.textContent = data.path;
    fpPath.dataset.parent = data.parent;
    fpList.innerHTML = '';
    if (!data.entries.length) { fpList.innerHTML = '<div class="sp-empty">（空目录）</div>'; }
    for (const e of data.entries) {
      const row = document.createElement('div');
      row.className = 'sp-row fp-row';
      const pick = document.createElement('button');
      pick.className = 'sp-pick';
      const icon = e.type === 'dir' ? FP_ICON_DIR : e.type === 'symlink' ? FP_ICON_LINK : FP_ICON_FILE;
      const meta = e.type === 'dir' ? '' : `<span class="sp-meta">${fmtSize(e.size)}</span>`;
      // icon 是静态 SVG 常量（可信）；文件名仍走 textContent，避免注入
      pick.innerHTML = `<span class="sp-name">${icon}<span class="fp-name"></span></span>${meta}`;
      // 长文件名:主干截断、扩展名钉住可见;全部 textContent,无注入面
      const nameEl = pick.querySelector('.fp-name');
      const dot = e.name.lastIndexOf('.');
      const hasExt = dot > 0 && dot < e.name.length - 1; // 不拆 .bashrc 这类点开头文件
      const stemEl = document.createElement('span');
      stemEl.className = 'fn-stem';
      stemEl.textContent = hasExt ? e.name.slice(0, dot) : e.name;
      nameEl.appendChild(stemEl);
      if (hasExt) {
        const extEl = document.createElement('span');
        extEl.className = 'fn-ext';
        extEl.textContent = e.name.slice(dot);
        nameEl.appendChild(extEl);
      }
      const abs = (fpCwd.endsWith('/') ? fpCwd : fpCwd + '/') + e.name;
      if (e.type === 'dir') {
        pick.addEventListener('click', () => fpLoad(abs));
      } else {
        // 文件:先 HEAD 预检,通过才导航下载——避免出错时把 App 跳到裸 JSON 错误页
        pick.addEventListener('click', async () => {
          const dlUrl = `/t/dl?path=${encodeURIComponent(abs)}`;
          try {
            const r = await fetchT(dlUrl, { method: 'HEAD' }, 8000);
            if (!r.ok) {
              flashNote(r.status === 404 ? '文件不存在' : r.status === 403 ? '无权限读取'
                : r.status === 400 ? '无法下载（目录或符号链接）' : `下载失败: HTTP ${r.status}`);
              return;
            }
            window.location.href = dlUrl; // 预检通过,触发系统下载
          } catch {
            flashNote('下载失败: 网络错误');
          }
        });
      }
      row.appendChild(pick);
      fpList.appendChild(row);
    }
  }

  document.getElementById('btn-files').addEventListener('click', () => { document.getElementById('session-panel').hidden = true; filePanel.hidden = false; fpLoad(null); });
  document.getElementById('fp-close').addEventListener('click', () => { filePanel.hidden = true; });
  filePanel.addEventListener('click', (e) => { if (e.target === filePanel) filePanel.hidden = true; });
  document.getElementById('fp-up').addEventListener('click', () => { const par = fpPath.dataset.parent; if (par) fpLoad(par); });
  document.getElementById('fp-upload').addEventListener('click', () => fpInput.click());
  fpInput.addEventListener('change', async () => {
    for (const f of fpInput.files) await uploadFile(f, fpCwd); // 落到当前浏览目录
    fpInput.value = '';
    fpLoad(fpCwd); // 刷新
  });
})();
