// 自包含的节点面板 Worker：内嵌静态 HTML + KV 注册表 API。
// 单文件便于经 Cloudflare API 直接上传（无需 wrangler 静态资源管线）。
const TEAM_DOMAIN = "doge-liang.cloudflareaccess.com";
const PANEL_AUD = ""; // 部署最后一步填 panel Access app 的 AUD
const ZONE_SUFFIX = ".doge-liang-space.uk";

const SEED = [
  { id: "self", name: "本机", url: "https://term.doge-liang-space.uk", note: "node-a", addedAt: 0 },
  { id: "term2", name: "RackNerd-8G", url: "https://term2.doge-liang-space.uk", note: "node-b", addedAt: 0 },
];

async function loadNodes(env) {
  const raw = await env.NODES.get("nodes");
  if (raw) return JSON.parse(raw);
  await env.NODES.put("nodes", JSON.stringify(SEED));
  return SEED;
}
const saveNodes = (env, nodes) => env.NODES.put("nodes", JSON.stringify(nodes));
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// 只允许 https 且属本 zone 的域名，防乱填
function validUrl(u) {
  try { const x = new URL(u);
    return x.protocol === "https:" && x.hostname.endsWith(ZONE_SUFFIX); }
  catch { return false; }
}

// --- Access JWT 验签（纵深防御；主闸是 workers_dev=false + 自定义域挂 Access） ---
let JWKS = null;
async function getJwks() {
  if (JWKS) return JWKS;
  const r = await fetch("https://" + TEAM_DOMAIN + "/cdn-cgi/access/certs");
  JWKS = (await r.json()).keys;
  return JWKS;
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function verifyAccess(request) {
  if (!PANEL_AUD) return true; // 填 AUD 之前先放行，便于联调
  const tok = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!tok) return false;
  const parts = tok.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))); } catch { return false; }
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(PANEL_AUD)) return false;
  if (payload.exp && Date.now() / 1000 > payload.exp) return false;
  const kid = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))).kid;
  const jwk = (await getJwks()).find(k => k.kid === kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
    b64urlToBytes(s), new TextEncoder().encode(h + "." + p));
}

const newId = () => crypto.randomUUID().slice(0, 8);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!(await verifyAccess(request))) return json({ error: "forbidden" }, 403);
    }
    if (url.pathname === "/api/nodes" && request.method === "GET") {
      return json({ nodes: await loadNodes(env) });
    }
    if (url.pathname === "/api/nodes" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const name = String(body.name || "").trim().slice(0, 40);
      const nodeUrl = String(body.url || "").trim();
      const note = String(body.note || "").trim().slice(0, 60);
      if (!name) return json({ error: "name required" }, 400);
      if (!validUrl(nodeUrl)) return json({ error: "url must be https and under " + ZONE_SUFFIX }, 400);
      const nodes = await loadNodes(env);
      nodes.push({ id: newId(), name, url: nodeUrl, note, addedAt: Date.now() });
      await saveNodes(env, nodes);
      return json({ nodes });
    }
    const del = url.pathname.match(/^\/api\/nodes\/([\w-]+)$/);
    if (del && request.method === "DELETE") {
      const id = del[1];
      if (id === "self") return json({ error: "cannot delete self" }, 400);
      const nodes = (await loadNodes(env)).filter(n => n.id !== id);
      await saveNodes(env, nodes);
      return json({ nodes });
    }
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

// 内嵌页面（其内联脚本刻意不使用反引号，以便安全地放入本模板字符串）。
const HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<title>节点面板</title>
<style>
  :root{--bg:#0d1117;--bar:#161b22;--border:#30363d;--fg:#c9d1d9;--accent:#58a6ff}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,"Segoe UI",Roboto,ui-monospace,monospace;
    padding:max(16px,env(safe-area-inset-top)) 16px 24px;max-width:640px;margin:0 auto}
  h1{font-size:18px;margin-bottom:16px}
  .card{display:flex;align-items:center;gap:10px;background:var(--bar);border:1px solid var(--border);
    border-radius:12px;padding:12px 14px;margin-bottom:10px}
  .card .meta{flex:1;min-width:0}
  .card .name{font-weight:600}
  .card .host{color:#8b949e;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .card .note{color:#6e7681;font-size:11px}
  .open{background:var(--accent);color:#0d1117;border:none;border-radius:8px;padding:8px 14px;
    font:inherit;font-weight:600;text-decoration:none}
  .del{background:transparent;border:1px solid var(--border);color:#8b949e;border-radius:8px;
    padding:8px 10px;font:inherit}
  .del:active{color:#f85149;border-color:#f85149}
  form{display:flex;flex-direction:column;gap:8px;background:var(--bar);border:1px solid var(--border);
    border-radius:12px;padding:14px;margin-top:16px}
  input{background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--fg);
    padding:9px 12px;font:inherit}
  input:focus{outline:none;border-color:var(--accent)}
  button.add{background:var(--accent);color:#0d1117;border:none;border-radius:8px;padding:9px;
    font:inherit;font-weight:600}
  .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--bar);
    border:1px solid var(--border);border-radius:8px;padding:8px 16px;font-size:13px;opacity:0;
    transition:opacity .2s;pointer-events:none}
  .toast.show{opacity:1}
</style></head>
<body>
<h1>节点面板</h1>
<div id="list"></div>
<form id="add">
  <input id="f-name" placeholder="名称，如 RackNerd-8G" maxlength="40" autocomplete="off">
  <input id="f-url" placeholder="https://termN.doge-liang-space.uk" inputmode="url" autocomplete="off">
  <input id="f-note" placeholder="备注（可选）" maxlength="60" autocomplete="off">
  <button class="add" type="submit">添加节点</button>
</form>
<div class="toast" id="toast"></div>
<script>
var listEl = document.getElementById("list");
var toastEl = document.getElementById("toast");
function toast(msg){ toastEl.textContent = msg; toastEl.classList.add("show");
  setTimeout(function(){ toastEl.classList.remove("show"); }, 1800); }
function host(u){ try{ return new URL(u).host; }catch(e){ return u; } }
function render(nodes){
  listEl.innerHTML = "";
  nodes.forEach(function(n){
    var card = document.createElement("div"); card.className = "card";
    var meta = document.createElement("div"); meta.className = "meta";
    var nm = document.createElement("div"); nm.className = "name"; nm.textContent = n.name;
    var hs = document.createElement("div"); hs.className = "host"; hs.textContent = host(n.url);
    var nt = document.createElement("div"); nt.className = "note"; nt.textContent = n.note || "";
    meta.append(nm, hs, nt);
    var open = document.createElement("a"); open.className = "open"; open.textContent = "打开";
    open.href = n.url; open.target = "_blank"; open.rel = "noopener";
    card.append(meta, open);
    if (n.id !== "self"){
      var del = document.createElement("button"); del.className = "del"; del.textContent = "✕";
      del.onclick = function(){
        if (!confirm("删除节点「" + n.name + "」？")) return;
        fetch("/api/nodes/" + n.id, { method: "DELETE" }).then(function(r){
          return r.json().then(function(d){
            if (r.ok){ render(d.nodes); toast("已删除"); } else toast(d.error || "删除失败");
          });
        });
      };
      card.append(del);
    }
    listEl.append(card);
  });
}
function load(){ fetch("/api/nodes").then(function(r){ return r.json(); }).then(function(d){ render(d.nodes); }); }
document.getElementById("add").onsubmit = function(e){
  e.preventDefault();
  var name = document.getElementById("f-name").value.trim();
  var url = document.getElementById("f-url").value.trim();
  var note = document.getElementById("f-note").value.trim();
  fetch("/api/nodes", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name, url: url, note: note }) })
    .then(function(r){ return r.json().then(function(d){
      if (r.ok){ render(d.nodes); e.target.reset(); toast("已添加"); } else toast(d.error || "添加失败");
    }); });
};
load();
</script></body></html>`;
