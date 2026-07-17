// 自包含的节点面板 Worker：内嵌静态 HTML + KV 注册表 API。
// 单文件便于经 Cloudflare API 直接上传（无需 wrangler 静态资源管线）。
//
// 账号相关配置全部从 env 读（在 wrangler.toml [vars] 或 Cloudflare 面板设置）：
//   TEAM_DOMAIN  Cloudflare Access 团队域，如 your-team.cloudflareaccess.com
//   PANEL_AUD    本面板 Access 应用的 AUD Tag（留空则暂放行，便于联调）
//   ZONE_SUFFIX  允许的节点域名后缀，如 .example.com（留空则只校验 https）
//   SEED_NODES   可选：初始节点表 JSON；留空则首启为空，用面板 UI 添加
//   SVC_TOKEN_ID / SVC_TOKEN_SECRET  Worker secret（非 [vars]）：Access 服务令牌，
//     供本 Worker 经 Access 调各节点 /t/box/* 控制面
function cfgFrom(env) {
  return {
    teamDomain: env.TEAM_DOMAIN || "",
    panelAud: env.PANEL_AUD || "",
    zoneSuffix: env.ZONE_SUFFIX || "",
    seed: env.SEED_NODES ? JSON.parse(env.SEED_NODES) : [],
    svcId: env.SVC_TOKEN_ID || "",
    svcSecret: env.SVC_TOKEN_SECRET || "",
  };
}

async function loadNodes(env, cfg) {
  const raw = await env.NODES.get("nodes");
  if (raw) return JSON.parse(raw);
  await env.NODES.put("nodes", JSON.stringify(cfg.seed));
  return cfg.seed;
}
const saveNodes = (env, nodes) => env.NODES.put("nodes", JSON.stringify(nodes));
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// 只允许 https（配了 zoneSuffix 时还须属本 zone），防乱填
function validUrl(u, zoneSuffix) {
  try { const x = new URL(u);
    return x.protocol === "https:" && (!zoneSuffix || x.hostname.endsWith(zoneSuffix)); }
  catch { return false; }
}

// --- Access JWT 验签（纵深防御；主闸是 workers_dev=false + 自定义域挂 Access） ---
let JWKS = null;
async function getJwks(teamDomain) {
  if (JWKS) return JWKS;
  const r = await fetch("https://" + teamDomain + "/cdn-cgi/access/certs");
  JWKS = (await r.json()).keys;
  return JWKS;
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function verifyAccess(request, cfg) {
  if (!cfg.panelAud) return true; // 填 AUD 之前先放行，便于联调
  const tok = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!tok) return false;
  const parts = tok.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))); } catch { return false; }
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(cfg.panelAud)) return false;
  if (payload.exp && Date.now() / 1000 > payload.exp) return false;
  const kid = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))).kid;
  const jwk = (await getJwks(cfg.teamDomain)).find(k => k.kid === kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
    b64urlToBytes(s), new TextEncoder().encode(h + "." + p));
}

// --- 盒控制面:服务端经 Access 服务令牌调各节点 /t/box/*,浏览器只见本 Worker ---
const validBoxName = (n) => typeof n === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(n) && !n.includes("..");
const svcHeaders = (cfg) => ({ "CF-Access-Client-Id": cfg.svcId, "CF-Access-Client-Secret": cfg.svcSecret });

async function nodeBoxLs(node, cfg) {
  try {
    const r = await fetch(node.url + "/t/box/ls", { headers: svcHeaders(cfg), signal: AbortSignal.timeout(15000) });
    if (r.status === 403) return { node, ok: false, reason: "控制面无法访问节点(服务令牌?)" };
    if (!r.ok) return { node, ok: false, reason: "HTTP " + r.status };
    return { node, ok: true, data: await r.json() };
  } catch (e) {
    return { node, ok: false, reason: (e && e.message) || "unreachable" };
  }
}

// 聚合各节点上报:注册表字段(R2 一致)取首见;running/mem 归上报的那个节点
export function mergeBoxLs(results) {
  const nodes = results.map((r) => ({
    id: r.node.id, name: r.node.name, url: r.node.url,
    boxNode: r.ok ? r.data.node : null, online: !!r.ok, reason: r.ok ? undefined : r.reason,
  }));
  const byName = new Map();
  for (const r of results) {
    if (!r.ok) continue;
    for (const b of r.data.boxes || []) {
      const cur = byName.get(b.name) || { ...b, running: false, runningOn: null, mem: null };
      if (b.running) {
        cur.running = true;
        cur.runningOn = r.data.node;
        cur.mem = r.data.mem && r.data.mem[b.name] != null ? r.data.mem[b.name] : null;
      }
      byName.set(b.name, cur);
    }
  }
  return { boxes: [...byName.values()], nodes };
}

// 纯编排决策:要不要 park、去哪 up(执行由调用方做,便于单测)
export function planLoad(boxes, name, targetBoxNode) {
  const b = boxes.find((x) => x.name === name);
  if (!b) return { error: "未知盒 " + name };
  if (!targetBoxNode) return { error: "目标节点离线或未上报 ag-box 身份" };
  if (b.leased_by === targetBoxNode) {
    return b.running && b.runningOn === targetBoxNode
      ? { park: null, up: null }
      : { park: null, up: targetBoxNode };
  }
  return { park: b.leased_by || null, up: targetBoxNode };
}

async function aggregateBoxLs(env, cfg) {
  const nodes = await loadNodes(env, cfg);
  return mergeBoxLs(await Promise.all(nodes.map((n) => nodeBoxLs(n, cfg))));
}

async function postNodeBox(node, op, name, cfg) {
  try {
    const r = await fetch(node.url + "/t/box/" + op, {
      method: "POST",
      headers: { ...svcHeaders(cfg), "content-type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(630000),
    });
    if (!r.ok) return { ok: false, error: "节点 HTTP " + r.status + (r.status === 403 ? "(服务令牌?)" : "") };
    const body = JSON.parse(await r.text());  // 节点用前导空白心跳,JSON.parse 容忍
    return body.ok ? { ok: true } : { ok: false, error: body.error || "unknown" };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "unreachable" };
  }
}

// 浏览器→Worker 这一跳同样受 ~100s 无字节超时约束:先回流式 200,
// 期间周期写空格,编排完成后写最终 JSON(客户端 r.json() 不受前导空白影响)
function streamJson(work) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(c) {
      const hb = setInterval(() => { try { c.enqueue(enc.encode(" ")); } catch {} }, 15000);
      let out;
      try { out = await work(); } catch (e) { out = { ok: false, error: (e && e.message) || "internal" }; }
      clearInterval(hb);
      try { c.enqueue(enc.encode(JSON.stringify(out))); c.close(); } catch {}
    },
  }), { headers: { "content-type": "application/json" } });
}

const newId = () => crypto.randomUUID().slice(0, 8);

export default {
  async fetch(request, env) {
    const cfg = cfgFrom(env);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!(await verifyAccess(request, cfg))) return json({ error: "forbidden" }, 403);
    }
    if (url.pathname === "/api/box/ls" && request.method === "GET") {
      return json(await aggregateBoxLs(env, cfg));
    }
    if (url.pathname.startsWith("/api/box/") && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const name = body.name;
      if (!validBoxName(name)) return json({ error: "非法盒名" }, 400);

      if (url.pathname === "/api/box/load") {
        const targetNodeId = String(body.targetNodeId || "");
        return streamJson(async () => {
          const agg = await aggregateBoxLs(env, cfg);
          const target = agg.nodes.find((n) => n.id === targetNodeId);
          if (!target) return { ok: false, error: "未知目标节点" };
          if (!target.online) return { ok: false, error: "目标节点离线" };
          const plan = planLoad(agg.boxes, name, target.boxNode);
          if (plan.error) return { ok: false, error: plan.error };
          if (plan.park) {
            const src = agg.nodes.find((n) => n.boxNode === plan.park);
            if (!src || !src.online) return { ok: false, error: "持租节点 " + plan.park + " 离线,无法迁移" };
            const p = await postNodeBox(src, "park", name, cfg);
            if (!p.ok) return { ok: false, error: "归档失败: " + p.error };
          }
          if (plan.up) {
            const u = await postNodeBox(target, "up", name, cfg);
            if (!u.ok) {
              return plan.park
                ? { ok: false, retriable: true, error: "已归档但拉起失败(数据在 R2 完好,可重试加载): " + u.error }
                : { ok: false, retriable: true, error: "拉起失败: " + u.error };
            }
          }
          return { ok: true, termUrl: target.url + "/?box=" + encodeURIComponent(name) };
        });
      }

      if (url.pathname === "/api/box/park") {
        return streamJson(async () => {
          const agg = await aggregateBoxLs(env, cfg);
          const b = agg.boxes.find((x) => x.name === name);
          if (!b) return { ok: false, error: "未知盒 " + name };
          if (!b.leased_by) return { ok: true };  // 已 parked,幂等
          const src = agg.nodes.find((n) => n.boxNode === b.leased_by);
          if (!src || !src.online) return { ok: false, error: "持租节点 " + b.leased_by + " 离线" };
          return postNodeBox(src, "park", name, cfg);
        });
      }

      if (url.pathname === "/api/box/drop") {
        return streamJson(async () => {
          const agg = await aggregateBoxLs(env, cfg);
          const b = agg.boxes.find((x) => x.name === name);
          if (!b) return { ok: false, error: "未知盒 " + name };
          if (b.leased_by) return { ok: false, error: "盒活跃于 " + b.leased_by + ",先归档再删除" };
          const any = agg.nodes.find((n) => n.online && n.boxNode);
          if (!any) return { ok: false, error: "无在线节点可执行删除" };
          return postNodeBox(any, "drop", name, cfg);
        });
      }
      return json({ error: "unknown box endpoint" }, 404);
    }
    if (url.pathname === "/api/nodes" && request.method === "GET") {
      return json({ nodes: await loadNodes(env, cfg) });
    }
    if (url.pathname === "/api/nodes" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const name = String(body.name || "").trim().slice(0, 40);
      const nodeUrl = String(body.url || "").trim();
      const note = String(body.note || "").trim().slice(0, 60);
      if (!name) return json({ error: "name required" }, 400);
      if (!validUrl(nodeUrl, cfg.zoneSuffix)) return json({ error: "url must be https" + (cfg.zoneSuffix ? " and under " + cfg.zoneSuffix : "") }, 400);
      const nodes = await loadNodes(env, cfg);
      nodes.push({ id: newId(), name, url: nodeUrl, note, addedAt: Date.now() });
      await saveNodes(env, nodes);
      return json({ nodes });
    }
    const del = url.pathname.match(/^\/api\/nodes\/([\w-]+)$/);
    if (del && request.method === "DELETE") {
      const id = del[1];
      if (id === "self") return json({ error: "cannot delete self" }, 400);
      const nodes = (await loadNodes(env, cfg)).filter(n => n.id !== id);
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
  .del{display:flex;align-items:center;background:transparent;border:1px solid var(--border);
    color:#8b949e;border-radius:8px;padding:8px 10px;font:inherit}
  .del svg{display:block}
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
  h2{font-size:15px;margin:18px 0 10px;color:#8b949e}
  .bcard{background:var(--bar);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:10px}
  .brow{display:flex;align-items:center;gap:8px}
  .bname{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
  .badge{font-size:11px;border-radius:6px;padding:2px 8px;white-space:nowrap}
  .badge.active{background:#1a7f37;color:#fff}
  .badge.parked{background:#30363d;color:#8b949e}
  .badge.pin{background:transparent;border:1px solid var(--border);color:#8b949e}
  .bmem{font-size:11px;color:#8b949e}
  .bops{display:flex;gap:8px;margin-top:10px;align-items:center}
  .bops select{background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--fg);padding:7px 8px;font:inherit;flex:1}
  .bops button{border:none;border-radius:8px;padding:8px 12px;font:inherit;font-weight:600}
  .bload{background:var(--accent);color:#0d1117}
  .bpark{background:transparent;border:1px solid var(--border);color:var(--fg)}
  .bdrop{background:transparent;border:1px solid var(--border);color:#f85149}
  button[disabled]{opacity:.5}
  .offline{color:#f85149;font-size:12px;margin-bottom:8px}
</style></head>
<body>
<h1>节点面板</h1>
<h2>沙盒</h2>
<div id="box-offline"></div>
<div id="boxes">加载中…</div>
<h2>节点</h2>
<div id="list"></div>
<form id="add">
  <input id="f-name" placeholder="名称，如 RackNerd-8G" maxlength="40" autocomplete="off">
  <input id="f-url" placeholder="https://term.example.com" inputmode="url" autocomplete="off">
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
      var del = document.createElement("button"); del.className = "del";
      del.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      del.title = "删除节点";
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
var boxesEl = document.getElementById("boxes");
var boxOff = document.getElementById("box-offline");
var boxNodes = [];
var inflight = {};
function fmtMem(b){ return b == null ? "" : (b/1048576).toFixed(0) + " MB"; }
function nodeLabel(bn){ var n = boxNodes.find(function(x){ return x.boxNode === bn; }); return n ? n.name : (bn || "?"); }
function boxOp(path, body, btn, name, done){
  btn.disabled = true;
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); })
    .then(function(d){ btn.disabled = false; delete inflight[name]; done(d); loadBoxes(); })
    .catch(function(e){ btn.disabled = false; delete inflight[name]; toast("请求失败: " + e.message); loadBoxes(); });
}
function renderBoxes(d){
  boxNodes = d.nodes;
  var off = d.nodes.filter(function(n){ return !n.online; });
  boxOff.innerHTML = "";
  off.forEach(function(n){
    var el = document.createElement("div"); el.className = "offline";
    el.textContent = "节点「" + n.name + "」不可达:" + (n.reason || ""); boxOff.append(el);
  });
  boxesEl.innerHTML = "";
  if (!d.boxes.length){ boxesEl.textContent = "(无沙盒;在节点终端里 ag-box track)"; return; }
  d.boxes.forEach(function(b){
    var card = document.createElement("div"); card.className = "bcard";
    var row = document.createElement("div"); row.className = "brow";
    var nm = document.createElement("div"); nm.className = "bname"; nm.textContent = b.name;
    var badge = document.createElement("span");
    if (b.leased_by){ badge.className = "badge active"; badge.textContent = "active@" + nodeLabel(b.leased_by); }
    else { badge.className = "badge parked"; badge.textContent = "parked"; }
    row.append(nm, badge);
    if (b.pin){ var pin = document.createElement("span"); pin.className = "badge pin"; pin.textContent = "pin=" + nodeLabel(b.pin); row.append(pin); }
    if (b.running && b.mem != null){ var mem = document.createElement("span"); mem.className = "bmem"; mem.textContent = fmtMem(b.mem); row.append(mem); }
    card.append(row);
    var ops = document.createElement("div"); ops.className = "bops";
    var busy = inflight[b.name];
    var sel = document.createElement("select");
    sel.disabled = !!busy;
    d.nodes.filter(function(n){ return n.online && n.boxNode; }).forEach(function(n){
      var o = document.createElement("option"); o.value = n.id; o.textContent = "加载到 " + n.name;
      if (b.runningOn ? n.boxNode === b.runningOn : (!b.running && b.pin && n.boxNode === b.pin)) o.selected = true;
      sel.append(o);
    });
    var loadBtn = document.createElement("button"); loadBtn.className = "bload";
    loadBtn.textContent = busy === "迁移中…" ? busy : "加载";
    loadBtn.disabled = !!busy;
    loadBtn.onclick = function(){
      if (!sel.value) return toast("无在线节点");
      var chosen = d.nodes.find(function(n){ return n.id === sel.value; });
      if (b.pin && (!chosen || chosen.boxNode !== b.pin)){
        if (!confirm("盒 " + b.name + " 固定在 " + nodeLabel(b.pin) + ",确定加载到其它节点?(可能丢失未快照的凭证)")) return;
      }
      var w = window.open("", "_blank");  // 先同步开空标签,避免 await 后被弹窗拦截
      inflight[b.name] = "迁移中…";
      loadBtn.textContent = "迁移中…";
      boxOp("/api/box/load", { name: b.name, targetNodeId: sel.value }, loadBtn, b.name, function(d2){
        loadBtn.textContent = "加载";
        if (d2.ok){ w.location = d2.termUrl; toast("已加载"); }
        else { if (w) w.close(); toast(d2.error || "加载失败"); }
      });
    };
    ops.append(sel, loadBtn);
    if (b.leased_by){
      var parkBtn = document.createElement("button"); parkBtn.className = "bpark";
      parkBtn.textContent = busy === "归档中…" ? busy : "归档";
      parkBtn.disabled = !!busy;
      parkBtn.onclick = function(){
        inflight[b.name] = "归档中…";
        parkBtn.textContent = "归档中…";
        boxOp("/api/box/park", { name: b.name }, parkBtn, b.name, function(d2){
          parkBtn.textContent = "归档";
          toast(d2.ok ? "已归档" : (d2.error || "归档失败"));
        });
      };
      ops.append(parkBtn);
    } else {
      var dropBtn = document.createElement("button"); dropBtn.className = "bdrop";
      dropBtn.textContent = busy === "删除中…" ? busy : "删除";
      dropBtn.disabled = !!busy;
      dropBtn.onclick = function(){
        if (!confirm("删除沙盒「" + b.name + "」的全部 R2 数据?不可恢复。")) return;
        inflight[b.name] = "删除中…";
        boxOp("/api/box/drop", { name: b.name }, dropBtn, b.name, function(d2){
          toast(d2.ok ? "已删除" : (d2.error || "删除失败"));
        });
      };
      ops.append(dropBtn);
    }
    card.append(ops);
    boxesEl.append(card);
  });
}
function loadBoxes(){
  fetch("/api/box/ls").then(function(r){ return r.json(); }).then(renderBoxes)
    .catch(function(){ boxesEl.textContent = "沙盒列表加载失败"; });
}
loadBoxes();
setInterval(loadBoxes, 10000);
load();
</script></body></html>`;
