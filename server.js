const http = require('http');
const fs = require('fs');
const path = require('path');
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

// --- static files ---
const PUBLIC_DIR = path.join(__dirname, 'public');
const VENDOR = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-web-links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
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

// --- websocket terminal ---
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  const auth = await verifyAccessJwt(req);
  if (!auth.ok) {
    console.error(`WS rejected: ${auth.reason}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, auth);
  });
});

wss.on('connection', (ws, req, auth) => {
  const url = new URL(req.url, 'http://localhost');
  // tmux session names: letters, digits, dash, underscore only
  const session = (url.searchParams.get('session') || DEFAULT_SESSION).replace(/[^\w-]/g, '').slice(0, 32) || DEFAULT_SESSION;
  const cols = Math.max(2, Math.min(500, parseInt(url.searchParams.get('cols'), 10) || 80));
  const rows = Math.max(2, Math.min(300, parseInt(url.searchParams.get('rows'), 10) || 24));

  console.log(`[${new Date().toISOString()}] ${auth.email} attached to tmux session "${session}" (${cols}x${rows})`);

  const term = pty.spawn('tmux', ['new-session', '-A', '-s', session], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: SHELL_CWD,
    env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' },
  });

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(() => ws.close());

  ws.on('message', (msg) => {
    try {
      const m = JSON.parse(msg.toString());
      if (m.t === 'i') term.write(m.d);
      else if (m.t === 'r') term.resize(Math.max(2, Math.min(500, m.cols | 0)), Math.max(2, Math.min(300, m.rows | 0)));
      else if (m.t === 'ping' && ws.readyState === ws.OPEN) ws.send('\x00'.repeat(0)); // no-op keepalive reply not needed for term
    } catch {
      /* ignore malformed frames */
    }
  });

  // keepalive: Cloudflare drops idle websockets after ~100s
  const ka = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 30000);

  ws.on('close', () => {
    clearInterval(ka);
    term.kill(); // kills the tmux *client*; the session stays alive on the server
  });
});

server.listen(PORT, HOST, () => {
  console.log(`mobile-terminal-web listening on http://${HOST}:${PORT}`);
  console.log(CF_TEAM_DOMAIN ? `Access JWT verification: ON (${CF_TEAM_DOMAIN})` : 'Access JWT verification: OFF (local dev)');
});
