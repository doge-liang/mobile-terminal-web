/* mobile-terminal-web frontend (socket.io transport: HTTP long-polling first,
   auto-upgrades to WebSocket only when the network actually allows it) */
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

  function setStatus(on, text) {
    statusEl.className = on ? 'on' : 'off';
    statusEl.textContent = text;
    sessionEl.textContent = `tmux: ${sessionName}`;
  }

  // --- socket.io connection ---
  fit.fit();
  const socket = io({
    transports: ['polling', 'websocket'],
    upgrade: true,
    auth: { session: sessionName, cols: term.cols, rows: term.rows },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 8000,
  });

  function transportLabel() {
    const t = socket.io.engine && socket.io.engine.transport.name;
    return t === 'websocket' ? 'WS' : t === 'polling' ? '轮询' : '';
  }

  function send(data) {
    if (socket.connected) socket.emit('i', data);
  }

  function sendResize() {
    if (socket.connected) socket.emit('r', { cols: term.cols, rows: term.rows });
  }

  socket.on('connect', () => {
    setStatus(true, `已连接 (${transportLabel()})`);
    sendResize();
    term.focus();
    socket.io.engine.on('upgrade', () => setStatus(true, `已连接 (${transportLabel()})`));
  });
  socket.on('o', (data) => term.write(data));
  socket.on('disconnect', () => setStatus(false, '已断开，重连中…'));
  socket.on('connect_error', (err) => {
    setStatus(false, err.message === 'unauthorized' ? '认证失败，请刷新页面重新登录' : '连接失败，重试中…');
  });

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
    if (document.visibilityState === 'visible' && !socket.connected) socket.connect();
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
    socket.auth = { session: sessionName, cols: term.cols, rows: term.rows };
    term.reset();
    socket.disconnect();
    socket.connect();
  });

  applyViewport();
})();
