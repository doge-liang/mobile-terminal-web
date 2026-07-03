const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const PORT = parseInt(process.env.PORT || '7681', 10);
const HOST = process.env.HOST || '127.0.0.1';
const SHELL_CWD = process.env.SHELL_CWD || process.env.HOME || '/root';
const DEFAULT_SESSION = process.env.TMUX_SESSION || 'mobile';

// Cloudflare Access JWT verification (defense in depth behind Access).
// If CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD are unset, verification is skipped
// (local development only — never expose the port publicly in that state).
const CF_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN || '';
const CF_AUD = process.env.CF_ACCESS_AUD || '';

let jwks = null;
async function verifyAccessJwt(req) {
  if (!CF_TEAM_DOMAIN || !CF_AUD) return { ok: true, email: 'local-dev' };
  const token = req.headers['cf-access-jwt-assertion'];
  if (!token) return { ok: false, reason: 'missing Cf-Access-Jwt-Assertion header' };
  try {
    const { jwtVerify, createRemoteJWKSet } = await import('jose');
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`https://${CF_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${CF_TEAM_DOMAIN}`,
      audience: CF_AUD,
    });
    return { ok: true, email: payload.email || payload.sub };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function sanitizeSession(name) {
  return String(name || DEFAULT_SESSION).replace(/[^\w-]/g, '').slice(0, 32) || DEFAULT_SESSION;
}
function clampCols(v) { return Math.max(2, Math.min(500, parseInt(v, 10) || 80)); }
function clampRows(v) { return Math.max(2, Math.min(300, parseInt(v, 10) || 24)); }

function spawnTmux(session, cols, rows) {
  return pty.spawn('tmux', ['new-session', '-A', '-s', session], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: SHELL_CWD,
    env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' },
  });
}

// ---------------------------------------------------------------------------
// HTTP transport sessions (SSE / long-poll fallbacks when WebSocket is blocked)
// sid -> { term, buf, sse, waiter, waiterTimer, lastSeen, exited }
// ---------------------------------------------------------------------------
const httpSessions = new Map();
const COALESCE_MS = 10;       // merge pty output bursts into fewer packets
const POLL_HOLD_MS = 25000;   // long-poll park time (Cloudflare cuts idle at ~100s)
const SSE_KEEPALIVE_MS = 20000;
const GC_IDLE_MS = 45000;     // kill pty if no downstream consumer for this long

function createHttpSession(session, cols, rows, email) {
  const sid = crypto.randomUUID();
  const s = {
    term: spawnTmux(session, cols, rows),
    buf: [],
    pending: '',
    flushTimer: null,
    sse: null,
    waiter: null,
    waiterTimer: null,
    lastSeen: Date.now(),
    exited: false,
    email,
  };
  s.term.onData((data) => {
    s.pending += data;
    if (!s.flushTimer) s.flushTimer = setTimeout(() => flushSession(s), COALESCE_MS);
  });
  s.term.onExit(() => {
    s.exited = true;
    flushSession(s, true);
  });
  httpSessions.set(sid, s);
  return sid;
}

function flushSession(s, force) {
  clearTimeout(s.flushTimer);
  s.flushTimer = null;
  if (s.pending) {
    s.buf.push(s.pending);
    s.pending = '';
  }
  if (!s.buf.length && !s.exited && !force) return;

  if (s.sse) {
    for (const chunk of s.buf) s.sse.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (s.exited) s.sse.write('event: exit\ndata: {}\n\n');
    s.buf = [];
  } else if (s.waiter) {
    const res = s.waiter;
    clearTimeout(s.waiterTimer);
    s.waiter = null;
    s.waiterTimer = null;
    res.end(JSON.stringify({ o: s.buf, exit: s.exited }));
    s.buf = [];
  }
}

function destroyHttpSession(sid) {
  const s = httpSessions.get(sid);
  if (!s) return;
  clearTimeout(s.flushTimer);
  clearTimeout(s.waiterTimer);
  if (s.sse) try { s.sse.end(); } catch {}
  if (s.waiter) try { s.waiter.end(JSON.stringify({ o: [], exit: true })); } catch {}
  if (!s.exited) try { s.term.kill(); } catch {} // kills the tmux client; the session survives
  httpSessions.delete(sid);
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of httpSessions) {
    const hasConsumer = s.sse || s.waiter;
    if (!hasConsumer && now - s.lastSeen > GC_IDLE_MS) destroyHttpSession(sid);
  }
}, 10000).unref();

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// --- static files ---
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const VENDOR = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-web-links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ------------------------- terminal HTTP API -------------------------
  if (url.pathname.startsWith('/t/')) {
    const auth = await verifyAccessJwt(req);
    if (!auth.ok) return json(res, 403, { error: 'unauthorized' });

    if (req.method === 'POST' && url.pathname === '/t/open') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const session = sanitizeSession(body.session);
      const sid = createHttpSession(session, clampCols(body.cols), clampRows(body.rows), auth.email);
      console.log(`[${new Date().toISOString()}] ${auth.email} attached to tmux "${session}" (http transport, sid=${sid.slice(0, 8)})`);
      return json(res, 200, { sid });
    }

    const sid = url.searchParams.get('sid');
    const s = sid && httpSessions.get(sid);

    if (req.method === 'POST' && url.pathname === '/t/close') {
      if (s) destroyHttpSession(sid);
      return json(res, 200, {});
    }
    if (!s) return json(res, 404, { error: 'no such session' });
    s.lastSeen = Date.now();

    if (req.method === 'POST' && url.pathname === '/t/in') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      if (typeof body.d === 'string' && !s.exited) s.term.write(body.d);
      if (body.r && typeof body.r === 'object' && !s.exited) s.term.resize(clampCols(body.r.cols), clampRows(body.r.rows));
      return json(res, 200, {});
    }

    if (req.method === 'GET' && url.pathname === '/t/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      });
      res.write('event: hello\ndata: {}\n\n'); // client uses this to confirm streaming works
      if (s.sse) try { s.sse.end(); } catch {}
      s.sse = res;
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, SSE_KEEPALIVE_MS);
      req.on('close', () => {
        clearInterval(ka);
        if (s.sse === res) s.sse = null;
        s.lastSeen = Date.now();
      });
      flushSession(s, true); // deliver anything buffered while switching transports
      return;
    }

    if (req.method === 'GET' && url.pathname === '/t/poll') {
      if (s.buf.length || s.exited) {
        const out = { o: s.buf, exit: s.exited };
        s.buf = [];
        return json(res, 200, out);
      }
      if (s.waiter) try { clearTimeout(s.waiterTimer); s.waiter.end(JSON.stringify({ o: [], exit: false })); } catch {}
      s.waiter = res;
      s.waiterTimer = setTimeout(() => {
        if (s.waiter === res) {
          s.waiter = null;
          s.waiterTimer = null;
          json(res, 200, { o: [], exit: false });
        }
      }, POLL_HOLD_MS);
      req.on('close', () => {
        if (s.waiter === res) { clearTimeout(s.waiterTimer); s.waiter = null; s.waiterTimer = null; }
        s.lastSeen = Date.now();
      });
      return;
    }

    return json(res, 404, { error: 'not found' });
  }

  // ------------------------- static files -------------------------
  let filePath = null;
  if (VENDOR[url.pathname]) {
    filePath = path.join(__dirname, VENDOR[url.pathname]);
  } else {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const resolved = path.resolve(PUBLIC_DIR, rel);
    if (resolved.startsWith(PUBLIC_DIR + path.sep) || resolved === path.join(PUBLIC_DIR, 'index.html')) {
      filePath = resolved;
    }
  }
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': url.pathname.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
});

// ------------------------- WebSocket transport (preferred) -------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  const auth = await verifyAccessJwt(req);
  if (!auth.ok) {
    console.error(`WS rejected: ${auth.reason}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, auth));
});

wss.on('connection', (ws, req, auth) => {
  const url = new URL(req.url, 'http://localhost');
  const session = sanitizeSession(url.searchParams.get('session'));
  const cols = clampCols(url.searchParams.get('cols'));
  const rows = clampRows(url.searchParams.get('rows'));

  console.log(`[${new Date().toISOString()}] ${auth.email} attached to tmux "${session}" (${cols}x${rows}, websocket)`);

  const term = spawnTmux(session, cols, rows);
  let pendingOut = '';
  let flushTimer = null;
  term.onData((data) => {
    pendingOut += data;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        // binary frames = terminal output; text frames = control messages (pong)
        if (ws.readyState === ws.OPEN && pendingOut) { ws.send(Buffer.from(pendingOut, 'utf8')); pendingOut = ''; }
      }, COALESCE_MS);
    }
  });
  term.onExit(() => ws.close());

  ws.on('message', (msg) => {
    try {
      const m = JSON.parse(msg.toString());
      if (m.t === 'i') term.write(m.d);
      else if (m.t === 'r') term.resize(clampCols(m.cols), clampRows(m.rows));
      else if (m.t === 'ping' && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'pong', ts: m.ts }));
    } catch { /* ignore malformed frames */ }
  });

  // keepalive: Cloudflare drops idle websockets after ~100s
  const ka = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 30000);
  ws.on('close', () => {
    clearInterval(ka);
    clearTimeout(flushTimer);
    term.kill(); // kills the tmux *client*; the session stays alive on the server
  });
});

server.listen(PORT, HOST, () => {
  console.log(`mobile-terminal-web listening on http://${HOST}:${PORT}`);
  console.log(CF_TEAM_DOMAIN ? `Access JWT verification: ON (${CF_TEAM_DOMAIN})` : 'Access JWT verification: OFF (local dev)');
});
