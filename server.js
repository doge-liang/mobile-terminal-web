const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server: SocketIOServer } = require('socket.io');
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

// --- static files ---
const PUBLIC_DIR = path.join(__dirname, 'public');
const VENDOR = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-web-links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
  '/vendor/socket.io.js': 'node_modules/socket.io/client-dist/socket.io.min.js',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
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

// --- socket.io terminal ---
// Transport order matters for restricted networks: plain HTTP long-polling is
// accepted first (works through any proxy that can load the page), then the
// client probes for a WebSocket upgrade in the background and switches only
// if it actually works. pingInterval stays well under Cloudflare's ~100s
// idle-connection cutoff.
const io = new SocketIOServer(server, {
  transports: ['polling', 'websocket'],
  allowUpgrades: true,
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1 << 20,
  serveClient: false,
});

// Access JWT gate on the initial handshake. Every polling request and the WS
// upgrade all pass through Cloudflare, which injects the JWT header; checking
// the handshake is sufficient because the session id is bound to it.
io.use(async (socket, next) => {
  const auth = await verifyAccessJwt(socket.request);
  if (!auth.ok) {
    console.error(`handshake rejected: ${auth.reason}`);
    return next(new Error('unauthorized'));
  }
  socket.data.email = auth.email;
  next();
});

io.on('connection', (socket) => {
  const q = socket.handshake.auth || {};
  // tmux session names: letters, digits, dash, underscore only
  const session = String(q.session || DEFAULT_SESSION).replace(/[^\w-]/g, '').slice(0, 32) || DEFAULT_SESSION;
  const cols = Math.max(2, Math.min(500, parseInt(q.cols, 10) || 80));
  const rows = Math.max(2, Math.min(300, parseInt(q.rows, 10) || 24));

  console.log(`[${new Date().toISOString()}] ${socket.data.email} attached to tmux session "${session}" (${cols}x${rows}, transport=${socket.conn.transport.name})`);
  socket.conn.on('upgrade', (t) => console.log(`[${new Date().toISOString()}] ${socket.data.email} transport upgraded to ${t.name}`));

  const term = pty.spawn('tmux', ['new-session', '-A', '-s', session], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: SHELL_CWD,
    env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' },
  });

  term.onData((data) => socket.emit('o', data));
  term.onExit(() => socket.disconnect(true));

  socket.on('i', (d) => {
    if (typeof d === 'string') term.write(d);
  });
  socket.on('r', (m) => {
    if (m && typeof m === 'object') {
      term.resize(Math.max(2, Math.min(500, m.cols | 0)), Math.max(2, Math.min(300, m.rows | 0)));
    }
  });

  socket.on('disconnect', () => {
    term.kill(); // kills the tmux *client*; the session stays alive on the server
  });
});

server.listen(PORT, HOST, () => {
  console.log(`mobile-terminal-web listening on http://${HOST}:${PORT}`);
  console.log(CF_TEAM_DOMAIN ? `Access JWT verification: ON (${CF_TEAM_DOMAIN})` : 'Access JWT verification: OFF (local dev)');
});
