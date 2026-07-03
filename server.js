const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const PORT = parseInt(process.env.PORT || '7681', 10);
// comma-separated list; e.g. "127.0.0.1,10.77.0.1" to also serve the WireGuard link
const HOSTS = (process.env.HOST || '127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean);
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

// ---------------------------------------------------------------------------
// Fast-path auth: the direct (non-Cloudflare) domain can't rely on Access JWTs,
// so it uses a signed cookie instead. Cookies are minted ONLY via /pair, which
// itself requires a valid Access JWT — the email whitelist in Cloudflare Access
// therefore remains the single gate for both domains.
// ---------------------------------------------------------------------------
const FAST_HOST = process.env.FAST_HOST || '';                                  // e.g. term-fast.doge-liang-space.uk
const MAIN_HOST = process.env.MAIN_HOST || 'term.doge-liang-space.uk';          // Access-protected domain
const COOKIE_NAME = 'mtw_auth';
const COOKIE_TTL_S = 30 * 24 * 3600;
const PAIR_TTL_S = 60;

const SECRET_FILE = path.join(__dirname, '.auth-secret');
let AUTH_SECRET = process.env.AUTH_SECRET || '';
if (!AUTH_SECRET) {
  try { AUTH_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {}
  if (!AUTH_SECRET) {
    AUTH_SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, AUTH_SECRET, { mode: 0o600 });
  }
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifySigned(token) {
  if (typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp && p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const usedPairIds = new Map(); // jti -> exp (pairing links are single-use)

// Accept either a Cloudflare Access JWT (main domain) or our signed cookie (fast path)
async function verifyAuth(req) {
  const jwt = await verifyAccessJwt(req);
  if (jwt.ok) return jwt;
  const p = verifySigned(parseCookies(req)[COOKIE_NAME]);
  if (p && p.typ === 'cookie') return { ok: true, email: p.email };
  return { ok: false, reason: jwt.reason || 'no credentials' };
}

function sanitizeSession(name) {
  return String(name || DEFAULT_SESSION).replace(/[^\w-]/g, '').slice(0, 32) || DEFAULT_SESSION;
}
function clampCols(v) { return Math.max(2, Math.min(500, parseInt(v, 10) || 80)); }
function clampRows(v) { return Math.max(2, Math.min(300, parseInt(v, 10) || 24)); }

function spawnTmux(session, cols, rows) {
  // "; set-option mouse on" runs after attach: wheel reports then scroll tmux's
  // own scrollback (copy-mode) — that's how touch scrolling reaches history
  return pty.spawn('tmux', ['new-session', '-A', '-s', session, ';', 'set-option', 'mouse', 'on'], {
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
  for (const [jti, exp] of usedPairIds) {
    if (exp < now / 1000) usedPairIds.delete(jti);
  }
}, 10000).unref();

function readBodyRaw(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const readBody = (req, limit) => readBodyRaw(req, limit).then((b) => b.toString('utf8'));

// --- image uploads (browser clipboard/photos can't reach the server's clipboard;
//     files are uploaded here and their path typed into the terminal instead) ---
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/root/uploads';
const UPLOAD_MAX = 15 << 20;
const UPLOAD_KEEP_MS = 7 * 24 * 3600 * 1000;
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/svg+xml': 'svg' };
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
setInterval(() => {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return;
    for (const f of files) {
      const p = path.join(UPLOAD_DIR, f);
      fs.stat(p, (e, st) => { if (!e && Date.now() - st.mtimeMs > UPLOAD_KEEP_MS) fs.unlink(p, () => {}); });
    }
  });
}, 3600 * 1000).unref();

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
  '/vendor/addon-unicode11.js': 'node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js',
};

const requestHandler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ------------------------- pairing (fast-path credentials) -------------------------
  // JWT-only on purpose: only someone who passed the Access email whitelist
  // (OTP on the main domain) can mint fast-path credentials.
  if (url.pathname === '/pair' && req.method === 'GET') {
    const auth = await verifyAccessJwt(req);
    if (!auth.ok) return json(res, 403, { error: 'open /pair via the Access-protected domain' });
    if (!FAST_HOST) return json(res, 400, { error: 'FAST_HOST not configured' });
    const tk = sign({ typ: 'pair', email: auth.email, jti: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + PAIR_TTL_S });
    const dest = `https://${FAST_HOST}/pair/claim?tk=${encodeURIComponent(tk)}`;
    console.log(`[${new Date().toISOString()}] ${auth.email} minted a fast-path pairing link`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${dest}"><body style="background:#0d1117;color:#c9d1d9;font-family:sans-serif;padding:2em"><p>正在跳转到快速通道…</p><p><a style="color:#58a6ff" href="${dest}">没有自动跳转请点这里</a>（链接 60 秒内有效）</p>`);
  }

  if (url.pathname === '/pair/claim' && req.method === 'GET') {
    const p = verifySigned(url.searchParams.get('tk'));
    if (!p || p.typ !== 'pair' || usedPairIds.has(p.jti)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><meta charset="utf-8"><body style="background:#0d1117;color:#c9d1d9;font-family:sans-serif;padding:2em"><p>配对链接无效或已过期。</p><p><a style="color:#58a6ff" href="https://${MAIN_HOST}/pair">重新配对</a></p>`);
    }
    usedPairIds.set(p.jti, p.exp);
    const cookie = sign({ typ: 'cookie', email: p.email, exp: Math.floor(Date.now() / 1000) + COOKIE_TTL_S });
    console.log(`[${new Date().toISOString()}] ${p.email} claimed fast-path cookie`);
    res.writeHead(302, {
      'Set-Cookie': `${COOKIE_NAME}=${cookie}; Max-Age=${COOKIE_TTL_S}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      Location: '/',
    });
    return res.end();
  }

  // ------------------------- terminal HTTP API -------------------------
  if (url.pathname.startsWith('/t/')) {
    const auth = await verifyAuth(req);
    if (!auth.ok) return json(res, 403, { error: 'unauthorized' });

    if (req.method === 'POST' && url.pathname === '/t/upload') {
      const mime = (req.headers['content-type'] || '').split(';')[0].trim();
      const ext = IMG_EXT[mime];
      if (!ext) return json(res, 415, { error: 'unsupported type' });
      let buf;
      try { buf = await readBodyRaw(req, UPLOAD_MAX); } catch { return json(res, 413, { error: 'too large (max 15MB)' }); }
      if (!buf.length) return json(res, 400, { error: 'empty body' });
      const name = `paste-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
      const dest = path.join(UPLOAD_DIR, name);
      await fs.promises.writeFile(dest, buf);
      console.log(`[${new Date().toISOString()}] ${auth.email} uploaded ${name} (${buf.length} bytes)`);
      return json(res, 200, { path: dest });
    }

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
      // real event, not a comment: EventSource can't see comments, and the client
      // uses these as a liveness signal to detect silently-blackholed connections
      const ka = setInterval(() => { try { res.write('event: ka\ndata: {}\n\n'); } catch {} }, SSE_KEEPALIVE_MS);
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

  // ------------------------- static files (auth-gated) -------------------------
  {
    const auth = await verifyAuth(req);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#0d1117;color:#c9d1d9;font-family:sans-serif;padding:2em"><h3>需要配对</h3><p>此入口的凭证要先通过邮箱验证获取：</p><p><a style="color:#58a6ff" href="https://${MAIN_HOST}/pair">用主域名完成邮箱验证并配对 →</a></p><p style="color:#8b949e;font-size:13px">完成后本设备 30 天内可直接访问此快速入口。</p>`);
    }
  }

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
};

// ------------------------- WebSocket transport (preferred) -------------------------
const wss = new WebSocketServer({ noServer: true });

const upgradeHandler = async (req, socket, head) => {
  const auth = await verifyAuth(req);
  if (!auth.ok) {
    console.error(`WS rejected: ${auth.reason}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, auth));
};

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

for (const host of HOSTS) {
  const server = http.createServer(requestHandler);
  server.on('upgrade', upgradeHandler);
  // a missing address (e.g. WireGuard interface still coming up) must not take
  // down the listeners that did bind — log and keep running
  server.on('error', (err) => console.error(`listen ${host}:${PORT} failed: ${err.message}`));
  server.listen(PORT, host, () => console.log(`mobile-terminal-web listening on http://${host}:${PORT}`));
}
console.log(CF_TEAM_DOMAIN ? `Access JWT verification: ON (${CF_TEAM_DOMAIN})` : 'Access JWT verification: OFF (local dev)');
