#!/usr/bin/env bash
# provision-fast-relay.sh — 为 mobile-terminal 搭「快速通道」(端到端 TLS，中转机只见密文)。
#
# 架构 (复刻已上线的主节点 self)：
#   中国客户端 --DNS直连(绕 CF)--> JUMP 中转机 --L4 TCP 透传(nginx stream)-->
#   WireGuard 隧道 --> ORIGIN 源站 Caddy(端到端 TLS 终结) --> 127.0.0.1:7681 终端
#   JUMP 不持任何私钥，只转发 TLS 密文；被攻破也看不到明文。
#
# 本脚本在「控制机」上运行(对 JUMP/ORIGIN 均已配好免密 ssh)，双端经 ssh 驱动。
# 幂等：可反复重跑；检测后再建；wg 私钥只在缺失时 genkey，绝不覆盖既有密钥/对端；
#      服务只在配置真的变了才 restart，no-op 重跑不抖动线上会话。
# 可参数化复用于 Phase-2：给同一 ORIGIN 追加第 2/3 台 JUMP —— ORIGIN 侧是「追加式」，
# 只往 wg 接口 append 一个 [Peer] + 一条 ufw allow，不动既有对端/规则。
#
# 用法：
#   CF_DNS_TOKEN=<zone:read+dns:edit 令牌> scripts/provision-fast-relay.sh \
#       [JUMP_SSH] [JUMP_PUBIP] [ORIGIN_SSH] [ORIGIN_PUBIP] \
#       [ORIGIN_WG_IP] [JUMP_WG_IP] [WG_SUBNET] [FAST_DOMAIN] [FAST_PORT] [CF_ZONE]
#   位置参数可省(用 Phase-1 默认值)，也可用同名环境变量覆盖。
#   拆除某条快速通道：DOWN=1 ...(同一组参数) —— 见文末 teardown。
#
# Phase-1 目标(默认值)：ORIGIN=term2(racknerd-13d12ee/192.255.136.151)，
#   JUMP=BW-02(bw-02/67.230.186.149)，快速域名 term-fast2.doge-liang-space.uk:2096，
#   新 wg 子网 10.78.0.0/24 (ORIGIN=.1 JUMP=.2)，源站 wg 接口名 wgfast(避开 self 的 wg1)。
#
# 不可变(immutable-after-first-run)字段：ORIGIN_WG_IP / JUMP_WG_IP / WG_SUBNET / WG_PORT /
#   WG_IF —— 首跑落盘后不再自动改写(live 接口不做 down/up 以免拆隧道)。要改这些须先 DOWN=1
#   拆除再重建。FAST_DOMAIN/FAST_PORT 可变(会就地更新 FAST_HOST 与 Caddy 块)。
#
# 机密：CF_DNS_TOKEN 与 wg 私钥绝不打印/记录/进 argv，文件 600。脚本不开 set -x。
set -euo pipefail

# ssh / git 凭证要读 $HOME；精简 shell 可能没设。
export HOME="${HOME:-/root}"

# ── 参数：位置参数 > 环境变量 > Phase-1 默认值 ───────────────────────────────
JUMP_SSH="${1:-${JUMP_SSH:-bw-02}}"
JUMP_PUBIP="${2:-${JUMP_PUBIP:-67.230.186.149}}"
ORIGIN_SSH="${3:-${ORIGIN_SSH:-racknerd-13d12ee}}"
ORIGIN_PUBIP="${4:-${ORIGIN_PUBIP:-192.255.136.151}}"
ORIGIN_WG_IP="${5:-${ORIGIN_WG_IP:-10.78.0.1}}"
JUMP_WG_IP="${6:-${JUMP_WG_IP:-10.78.0.2}}"
WG_SUBNET="${7:-${WG_SUBNET:-10.78.0.0/24}}"
FAST_DOMAIN="${8:-${FAST_DOMAIN:-term-fast2.doge-liang-space.uk}}"
FAST_PORT="${9:-${FAST_PORT:-2096}}"
CF_ZONE="${10:-${CF_ZONE:-doge-liang-space.uk}}"

# 次级参数(一般不用改)
WG_IF="${WG_IF:-wgfast}"            # 源站 wg 接口名，务必 != wg1(self 占用)
WG_PORT="${WG_PORT:-51820}"         # 源站 wg 监听 UDP 端口(中转机主动发起，不监听)
ENABLE_UFW="${ENABLE_UFW:-0}"       # 1=在源站启用 ufw(先放行 SSH)。姿态变更，须先确认主路径不是直连入站，见文末风险。
ALLOW_MOD_INSTALL="${ALLOW_MOD_INSTALL:-0}"  # 1=允许在中转机 apt 安装 libnginx-mod-stream。默认 0：模块缺失即中止(不冒 ABI 风险)。
DOWN="${DOWN:-0}"                   # 1=拆除本条快速通道(见文末)
WG_MASK="${WG_SUBNET##*/}"; [ "$WG_MASK" = "$WG_SUBNET" ] && WG_MASK=24

: "${CF_DNS_TOKEN:?need CF_DNS_TOKEN (Cloudflare 令牌，权限 Zone:Read + Zone:DNS:Edit)}"

# ── 小工具 ──────────────────────────────────────────────────────────────────
log()  { printf '\033[1;36m[fast-relay]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[fast-relay] ⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[fast-relay] ✗ %s\033[0m\n' "$*" >&2; exit 1; }
SSH()  { ssh -o BatchMode=yes -o ConnectTimeout=10 "$@"; }
# 令牌只经 curl -K 配置文件(进程替换=管道 fd)喂进去，绝不进 argv(/proc/<pid>/cmdline 全局可读)。
cf_api() {
  curl -sS -K <(printf 'header = "Authorization: Bearer %s"\n' "$CF_DNS_TOKEN") \
       -H "Content-Type: application/json" "$@"
}

# 控制机依赖
command -v jq   >/dev/null 2>&1 || die "控制机缺 jq(用于解析 Cloudflare API)。请先 apt-get install jq。"
command -v curl >/dev/null 2>&1 || die "控制机缺 curl。"
command -v ssh  >/dev/null 2>&1 || die "控制机缺 ssh。"

# Cloudflare 区 id（DOWN 与正常路径都要）。
cf_zone_id() { cf_api "https://api.cloudflare.com/client/v4/zones?name=$CF_ZONE" | jq -r '.result[0].id // empty'; }

# ── 拆除模式：DOWN=1 —— 只回退本条快速通道，绝不碰其它对端/站点/端口 80/xray ──
if [ "$DOWN" = 1 ]; then
  log "DOWN：拆除快速通道 $FAST_DOMAIN:$FAST_PORT  (ORIGIN=$ORIGIN_SSH JUMP=$JUMP_SSH)"
  # 取中转机公钥用于在源站按公钥精确删除该对端(删错对端会误伤其它中转机)。
  JPUB=$(SSH "$JUMP_SSH" "cat /etc/wireguard/$WG_IF.pub 2>/dev/null" | tr -d '\r\n' || true)

  log "  ORIGIN：删对端 + 停 caddy-fast + 还原 mobile-terminal env"
  SSH "$ORIGIN_SSH" bash -s -- "$WG_IF" "${JPUB:-}" "$FAST_DOMAIN" "$FAST_PORT" "$ORIGIN_WG_IP" <<'REMOTE'
set -euo pipefail
IF="$1"; JPUB="$2"; FDOM="$3"; FPORT="$4"; OWGIP="$5"
CONF="/etc/wireguard/$IF.conf"
# 删 wg 对端(live + 落盘)，仅当拿到公钥；用段落模式按公钥删整个 [Peer] 段，其它对端不动。
if [ -n "$JPUB" ]; then
  wg set "$IF" peer "$JPUB" remove 2>/dev/null || true
  if [ -f "$CONF" ] && grep -qF "$JPUB" "$CONF"; then
    umask 077
    awk -v k="$JPUB" 'BEGIN{RS="";ORS="\n\n"} index($0,k)==0 {print}' "$CONF" > "$CONF.tmp"
    mv "$CONF.tmp" "$CONF"; chmod 600 "$CONF"
  fi
fi
# 停快速 Caddy + 删其配置(不碰任何 apt caddy / 其它站点)。
systemctl disable --now caddy-fast >/dev/null 2>&1 || true
rm -f /etc/systemd/system/caddy-fast.service /etc/caddy/conf.d/term-fast.caddy
systemctl daemon-reload >/dev/null 2>&1 || true
# 还原终端 env：删 FAST_HOST 行、从 HOST 摘掉 wg IP。变了才 restart。
ENVF=/etc/default/mobile-terminal
if [ -f "$ENVF" ]; then
  BAK=$(mktemp); cp -a "$ENVF" "$BAK"
  sed -i '/^FAST_HOST=/d' "$ENVF"
  cur=$(sed -n 's/^HOST=//p' "$ENVF" | head -1)
  if [ -n "$cur" ]; then
    # grep -vxF 全被过滤时退出 1，pipefail 会中止 teardown —— 用 || new="" 兜底，交给下一行回落。
    new=$(printf '%s' "$cur" | tr ',' '\n' | grep -vxF "$OWGIP" | paste -sd, -) || new=""
    [ -z "$new" ] && new="127.0.0.1"
    sed -i "s|^HOST=.*|HOST=$new|" "$ENVF"
  fi
  if ! cmp -s "$BAK" "$ENVF"; then systemctl restart mobile-terminal || true; fi
  rm -f "$BAK"
fi
echo OK
REMOTE

  log "  JUMP：删 nginx stream drop-in + 拆 wg 接口(中转机侧接口专属，可整拆)"
  SSH "$JUMP_SSH" bash -s -- "$WG_IF" <<'REMOTE'
set -euo pipefail
IF="$1"
DROPIN=/etc/nginx/stream.d/term-fast.conf
if [ -f "$DROPIN" ]; then
  rm -f "$DROPIN"
  # 删 drop-in 后 nginx -t 通过才 reload；不通过不动运行态(极不可能，删文件而已)。
  if nginx -t >/dev/null 2>&1; then nginx -s reload || true; fi
fi
# 中转机的 wgfast 接口是本快速通道专属，可整体拆(不影响 80/xray)。keys 保留供重建复用。
wg-quick down "$IF" >/dev/null 2>&1 || true
systemctl disable "wg-quick@$IF" >/dev/null 2>&1 || true
echo OK
REMOTE

  log "  Cloudflare：删 A 记录 $FAST_DOMAIN"
  ZID=$(cf_zone_id)
  if [ -n "$ZID" ]; then
    RID=$(cf_api "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records?type=A&name=$FAST_DOMAIN" \
            | jq -r '.result[0].id // empty')
    if [ -n "$RID" ]; then
      cf_api -X DELETE "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records/$RID" >/dev/null \
        && log "  DNS 记录已删(id=$RID)" || warn "DNS 记录删除失败(可手动在 CF 面板删 $FAST_DOMAIN)。"
    else
      log "  DNS 记录不存在，跳过。"
    fi
  else
    warn "找不到区 $CF_ZONE 或令牌权限不足，跳过 DNS 删除。"
  fi
  log "DOWN 完成。wg 私钥仍保留(/etc/wireguard/$WG_IF.key，重建会复用)。"
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# 正常(建/更新)路径
# ══════════════════════════════════════════════════════════════════════════════
log "参数：JUMP=$JUMP_SSH($JUMP_PUBIP) ORIGIN=$ORIGIN_SSH($ORIGIN_PUBIP)"
log "      wg $WG_IF  $ORIGIN_WG_IP <- $JUMP_WG_IP  子网 $WG_SUBNET  UDP:$WG_PORT"
log "      快速域名 $FAST_DOMAIN:$FAST_PORT  CF 区 $CF_ZONE"

# ── 1) Cloudflare：upsert A 记录 FAST_DOMAIN -> JUMP_PUBIP (DNS-only/灰云) ────
log "[1/9] Cloudflare DNS：A $FAST_DOMAIN -> $JUMP_PUBIP (proxied=false)"
ZID=$(cf_zone_id)
[ -n "$ZID" ] || die "Cloudflare：找不到区 $CF_ZONE，或令牌缺 Zone:Read 权限。"
RID=$(cf_api "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records?type=A&name=$FAST_DOMAIN" \
        | jq -r '.result[0].id // empty')
DNS_BODY=$(jq -n --arg n "$FAST_DOMAIN" --arg c "$JUMP_PUBIP" \
             '{type:"A",name:$n,content:$c,ttl:120,proxied:false}')
if [ -n "$RID" ]; then
  DNS_RES=$(cf_api -X PUT  "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records/$RID" --data "$DNS_BODY")
else
  DNS_RES=$(cf_api -X POST "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records"       --data "$DNS_BODY")
fi
echo "$DNS_RES" | jq -e '.success' >/dev/null \
  || die "Cloudflare DNS upsert 失败：$(echo "$DNS_RES" | jq -c '.errors')"
log "      DNS 记录已就绪(id=$(echo "$DNS_RES" | jq -r '.result.id'))"

# ── 2) ORIGIN：装 wireguard + 幂等生成密钥，取回公钥 ─────────────────────────
log "[2/9] ORIGIN 装 wireguard + 生成 wg 密钥(幂等)"
ORIGIN_PUB=$(SSH "$ORIGIN_SSH" bash -s -- "$WG_IF" <<'REMOTE'
set -euo pipefail
IF="$1"
export DEBIAN_FRONTEND=noninteractive
command -v wg >/dev/null 2>&1 || { apt-get update -qq >&2; apt-get install -y -qq wireguard wireguard-tools >&2; }
umask 077
mkdir -p /etc/wireguard
[ -s "/etc/wireguard/$IF.key" ] || wg genkey > "/etc/wireguard/$IF.key"   # 只在缺失时生成，绝不覆盖
chmod 600 "/etc/wireguard/$IF.key"
wg pubkey < "/etc/wireguard/$IF.key" > "/etc/wireguard/$IF.pub"
cat "/etc/wireguard/$IF.pub"
REMOTE
)
ORIGIN_PUB="${ORIGIN_PUB//[$'\r\n']/}"
[ -n "$ORIGIN_PUB" ] || die "取源站 wg 公钥失败。"

# ── 3) JUMP：装 wireguard + 幂等生成密钥，取回公钥 ──────────────────────────
# stream 模块不在这装：任务保证 BW-02 已自带 stream；能力检测放到第 8 步(见 has_stream)。
log "[3/9] JUMP 装 wireguard + 生成 wg 密钥(幂等)"
JUMP_PUB=$(SSH "$JUMP_SSH" bash -s -- "$WG_IF" <<'REMOTE'
set -euo pipefail
IF="$1"
export DEBIAN_FRONTEND=noninteractive
command -v wg >/dev/null 2>&1 || { apt-get update -qq >&2; apt-get install -y -qq wireguard wireguard-tools >&2; }
umask 077
mkdir -p /etc/wireguard
[ -s "/etc/wireguard/$IF.key" ] || wg genkey > "/etc/wireguard/$IF.key"
chmod 600 "/etc/wireguard/$IF.key"
wg pubkey < "/etc/wireguard/$IF.key" > "/etc/wireguard/$IF.pub"
cat "/etc/wireguard/$IF.pub"
REMOTE
)
JUMP_PUB="${JUMP_PUB//[$'\r\n']/}"
[ -n "$JUMP_PUB" ] || die "取中转机 wg 公钥失败。"

# ── 4) ORIGIN：wg 接口(幂等) + 追加 JUMP 为对端(live+持久，additive) + ufw ──
log "[4/9] ORIGIN 配 $WG_IF(监听 UDP $WG_PORT) + 追加对端 $JUMP_WG_IP + ufw 规则"
SSH "$ORIGIN_SSH" bash -s -- \
  "$WG_IF" "$ORIGIN_WG_IP" "$WG_MASK" "$WG_PORT" "$JUMP_PUB" "$JUMP_WG_IP" "$JUMP_PUBIP" "$ENABLE_UFW" "$FAST_PORT" <<'REMOTE'
set -euo pipefail
IF="$1"; OWGIP="$2"; MASK="$3"; WGPORT="$4"; JPUB="$5"; JWGIP="$6"; JPUBIP="$7"; ENUFW="$8"; FPORT="$9"
CONF="/etc/wireguard/$IF.conf"
umask 077
# 首建接口配置：只写 [Interface]（对端一律走「追加式」，run1/runN 同一条路径）。
if [ ! -f "$CONF" ]; then
  {
    echo "[Interface]"
    echo "Address = $OWGIP/$MASK"
    echo "ListenPort = $WGPORT"
    echo "PrivateKey = $(cat "/etc/wireguard/$IF.key")"
  } > "$CONF"
  chmod 600 "$CONF"
else
  # 既有接口：这些字段视为不可变(不做 live down/up 以免拆隧道)。若请求值与落盘不符，只告警不改。
  have_addr=$(sed -n 's/^Address *= *//p'    "$CONF" | head -1)
  have_port=$(sed -n 's/^ListenPort *= *//p' "$CONF" | head -1)
  [ -n "$have_addr" ] && [ "$have_addr" != "$OWGIP/$MASK" ] && \
    echo "WARN: $IF Address 落盘=$have_addr 请求=$OWGIP/$MASK —— 不自动改(要改请先 DOWN=1)。" >&2
  [ -n "$have_port" ] && [ "$have_port" != "$WGPORT" ] && \
    echo "WARN: $IF ListenPort 落盘=$have_port 请求=$WGPORT —— 不自动改(要改请先 DOWN=1)。" >&2
fi
# enable 独立于 up-check，无条件确保(幂等)：避免「已 up 但未 enable」重启后不回来的漏网。
systemctl enable "wg-quick@$IF" >/dev/null 2>&1 || true
# 接口没起就起(绝不 down/up：会拆隧道、扰动既有对端)。
if ! wg show "$IF" >/dev/null 2>&1; then
  wg-quick up "$IF"
fi
# 追加对端(live)：源站侧无 Endpoint(由中转机发起)。已存在则跳过，绝不覆盖既有对端。
if ! wg show "$IF" peers 2>/dev/null | grep -qxF "$JPUB"; then
  wg set "$IF" peer "$JPUB" allowed-ips "$JWGIP/32"
fi
# 持久化对端到配置文件(重启后仍在)。用公钥去重，不用 wg-quick save(会重写/丢注释)。
if ! grep -qF "$JPUB" "$CONF"; then
  {
    echo ""
    echo "[Peer]"
    echo "# relay $JPUBIP"
    echo "PublicKey = $JPUB"
    echo "AllowedIPs = $JWGIP/32"
  } >> "$CONF"
fi
# ufw：仅「追加」规则(源站 ufw 现为 inactive)。默认不 enable —— 启用是姿态变更且有锁死风险。
if command -v ufw >/dev/null 2>&1; then
  ufw allow from "$JPUBIP" to any port "$WGPORT" proto udp   >/dev/null 2>&1 || true  # wg 仅来自该中转机
  ufw allow in on "$IF" from "$JWGIP" to any port "$FPORT" proto tcp >/dev/null 2>&1 || true  # 快速端口，仅经隧道
  ufw allow in on "$IF" from "$JWGIP" to any port 7681    proto tcp >/dev/null 2>&1 || true  # 终端，仅经隧道(与 self 对齐)
  if [ "$ENUFW" = 1 ] && ! ufw status 2>/dev/null | grep -qi '^Status: active'; then
    ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true          # 先放行 SSH，避免锁死
    ufw --force enable >/dev/null
  fi
fi
echo OK
REMOTE

# ── 5) JUMP：wg 接口(幂等) + 对端 ORIGIN(带 Endpoint，主动发起) ─────────────
log "[5/9] JUMP 配 $WG_IF + 对端源站 $ORIGIN_PUBIP:$WG_PORT (发起方，keepalive 25)"
SSH "$JUMP_SSH" bash -s -- \
  "$WG_IF" "$JUMP_WG_IP" "$WG_MASK" "$ORIGIN_PUB" "$ORIGIN_PUBIP" "$WG_PORT" "$ORIGIN_WG_IP" <<'REMOTE'
set -euo pipefail
IF="$1"; JWGIP="$2"; MASK="$3"; OPUB="$4"; OPUBIP="$5"; WGPORT="$6"; OWGIP="$7"
CONF="/etc/wireguard/$IF.conf"
umask 077
if [ ! -f "$CONF" ]; then
  {
    echo "[Interface]"
    echo "Address = $JWGIP/$MASK"
    echo "PrivateKey = $(cat "/etc/wireguard/$IF.key")"
  } > "$CONF"
  chmod 600 "$CONF"
fi
# enable 无条件确保(同 ORIGIN 侧理由)。
systemctl enable "wg-quick@$IF" >/dev/null 2>&1 || true
if ! wg show "$IF" >/dev/null 2>&1; then
  wg-quick up "$IF"
fi
# 对端=源站，带 Endpoint。always wg set 是幂等的，可顺带校正 endpoint(公网 IP 变更也不拆隧道)。
wg set "$IF" peer "$OPUB" endpoint "$OPUBIP:$WGPORT" allowed-ips "$OWGIP/32" persistent-keepalive 25
if ! grep -qF "$OPUB" "$CONF"; then
  {
    echo ""
    echo "[Peer]"
    echo "# origin $OPUBIP"
    echo "PublicKey = $OPUB"
    echo "Endpoint = $OPUBIP:$WGPORT"
    echo "AllowedIPs = $OWGIP/32"
    echo "PersistentKeepalive = 25"
  } >> "$CONF"
fi
echo OK
REMOTE

# ── 6) ORIGIN：写 CF 令牌到 Caddy env(600，经 stdin，绝不进 argv/journal) ────
log "[6/9] ORIGIN 写 Cloudflare 令牌 -> /etc/caddy/caddy.env (600)"
printf 'CF_DNS_TOKEN=%s\n' "$CF_DNS_TOKEN" \
  | SSH "$ORIGIN_SSH" 'umask 077; mkdir -p /etc/caddy && cat > /etc/caddy/caddy.env && chmod 600 /etc/caddy/caddy.env && chown root:root /etc/caddy/caddy.env'

# ── 7) ORIGIN：装带 cloudflare-dns 插件的 Caddy + DNS-01 快速块 + env 更新 ──
log "[7/9] ORIGIN 装自定义 Caddy(cloudflare-dns) + Caddyfile(DNS-01) + FAST_HOST/HOST + reload"
SSH "$ORIGIN_SSH" bash -s -- "$FAST_DOMAIN" "$FAST_PORT" "$ORIGIN_WG_IP" <<'REMOTE'
set -euo pipefail
FDOM="$1"; FPORT="$2"; OWGIP="$3"
export DEBIAN_FRONTEND=noninteractive
command -v curl >/dev/null 2>&1 || { apt-get update -qq >&2; apt-get install -y -qq curl >&2; }
# 装自定义 Caddy(含 caddy-dns/cloudflare)。普通 apt caddy 没这插件。已装且带插件则跳过。
if ! { command -v caddy >/dev/null 2>&1 && caddy list-modules 2>/dev/null | grep -q '^dns.providers.cloudflare$'; }; then
  curl -fsSL -o /tmp/caddy.bin "https://caddyserver.com/api/download?package=github.com/caddy-dns/cloudflare&os=linux&arch=amd64" >&2
  install -m 0755 /tmp/caddy.bin /usr/bin/caddy
  rm -f /tmp/caddy.bin
fi
# caddy 用户 + 数据目录(证书要能跨重启持久，否则每次开机重签)。
id caddy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
mkdir -p /var/lib/caddy /etc/caddy/conf.d
chown -R caddy:caddy /var/lib/caddy
# 主 Caddyfile 只放一条 import，快速块单独落 conf.d(追加式，幂等，不与其它站点冲突)。
if [ ! -f /etc/caddy/Caddyfile ]; then
  echo 'import /etc/caddy/conf.d/*.caddy' > /etc/caddy/Caddyfile
elif ! grep -qF 'import /etc/caddy/conf.d/*.caddy' /etc/caddy/Caddyfile; then
  printf '\nimport /etc/caddy/conf.d/*.caddy\n' >> /etc/caddy/Caddyfile
fi
# DNS-01 快速块(复刻 self，把 HTTP-01 换成 cloudflare DNS-01；令牌从环境读，不写死)。
cat > /etc/caddy/conf.d/term-fast.caddy <<CADDY
$FDOM:$FPORT {
    log { output stderr }
    tls { dns cloudflare {env.CF_DNS_TOKEN} }
    reverse_proxy 127.0.0.1:7681
}
CADDY
# systemd 单元(独立名 caddy-fast，不碰任何 apt caddy)。注意：不加 --environ，否则令牌会被打进 journal。
cat > /etc/systemd/system/caddy-fast.service <<'UNIT'
[Unit]
Description=Caddy fast-channel (DNS-01 via cloudflare)
After=network-online.target
Wants=network-online.target
[Service]
Type=notify
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/etc/caddy
EnvironmentFile=-/etc/caddy/caddy.env
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
Restart=on-failure
RestartSec=5s
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
# 起服务前 validate；source 令牌让 {env.CF_DNS_TOKEN} 能解析(仅进程内，不打印)。
if [ -f /etc/caddy/caddy.env ]; then set -a; . /etc/caddy/caddy.env; set +a; fi
caddy validate --config /etc/caddy/Caddyfile >&2
systemctl enable caddy-fast >/dev/null 2>&1 || true
# 已在跑就 reload(热应用 conf.d 变更，不抖 TLS)；没跑才 restart(首装)。
if systemctl is-active --quiet caddy-fast; then
  systemctl reload caddy-fast 2>/dev/null || systemctl restart caddy-fast
else
  systemctl restart caddy-fast
fi
# 更新终端服务 env：FAST_HOST(就地更新或新增) + HOST(追加 wg IP，不覆盖既有)。变了才 restart + 带回滚。
ENVF=/etc/default/mobile-terminal
BAK="$ENVF.fastbak.$(date +%s)"
cp -a "$ENVF" "$BAK"
if grep -q '^FAST_HOST=' "$ENVF"; then
  sed -i "s|^FAST_HOST=.*|FAST_HOST=$FDOM:$FPORT|" "$ENVF"   # 就地更新(改域名/端口也能收敛)
else
  echo "FAST_HOST=$FDOM:$FPORT" >> "$ENVF"
fi
cur=$(sed -n 's/^HOST=//p' "$ENVF" | head -1)
if [ -z "$cur" ]; then
  echo "HOST=127.0.0.1,$OWGIP" >> "$ENVF"
elif ! printf '%s' "$cur" | tr ',' '\n' | grep -qxF "$OWGIP"; then
  sed -i "s|^HOST=.*|HOST=$cur,$OWGIP|" "$ENVF"
fi
if cmp -s "$BAK" "$ENVF"; then
  rm -f "$BAK"                          # no-op：无变更，不 restart，不留备份(避免堆积)
else
  systemctl restart mobile-terminal
  if ! systemctl is-active --quiet mobile-terminal; then   # 起不来 -> 回滚 env 并重试，非零退出
    cp -a "$BAK" "$ENVF"
    systemctl restart mobile-terminal || true
    echo "MOBILE_TERMINAL_RESTART_FAILED" >&2
    exit 1
  fi
  # 成功：备份留一份(env 确实变了，供审计/手动回滚)。
fi
echo OK
REMOTE

# ── 8) JUMP：nginx stream drop-in(追加式，能力门控 + nginx -t 门控，失败即回滚) ─
log "[8/9] JUMP 加 nginx stream 转发 :$FAST_PORT -> $ORIGIN_WG_IP:$FAST_PORT (能力+语法门控)"
SSH "$JUMP_SSH" bash -s -- "$FAST_PORT" "$ORIGIN_WG_IP" "$ALLOW_MOD_INSTALL" <<'REMOTE'
set -euo pipefail
FPORT="$1"; OWGIP="$2"; ALLOW_MOD="$3"
export DEBIAN_FRONTEND=noninteractive

# 能力检测：nginx 是否真能吃 stream{}。不用 dpkg -s(非 stock 构建会误判)。
#   - 静态内建(--with-stream，非 =dynamic) → 有
#   - 动态模块已 load(modules-enabled 里有 stream 的 load_module，nginx -T 会 dump 出来) → 有
has_stream() {
  nginx -V 2>&1 | grep -qE -- '--with-stream([^=]|$)' && return 0
  nginx -T 2>/dev/null | grep -qE 'ngx_stream_module' && return 0
  return 1
}
MODFILE=""     # 若本次由我们 apt 装了动态模块，记下 modules-enabled 条目，供 nginx -t 失败时回滚
if ! has_stream; then
  if [ "$ALLOW_MOD" = 1 ]; then
    echo "WARN: 未检测到 nginx stream 能力，按 ALLOW_MOD_INSTALL=1 安装 libnginx-mod-stream。" >&2
    apt-get update -qq >&2; apt-get install -y -qq libnginx-mod-stream >&2
    MODFILE=/etc/nginx/modules-enabled/50-mod-stream.conf
  else
    echo "NGINX_STREAM_MODULE_MISSING: 该 nginx 不支持 stream。请手动确认/安装 libnginx-mod-stream" >&2
    echo "  (或 ALLOW_MOD_INSTALL=1 重跑；非 stock nginx 请自行处理 ABI，勿盲装)。" >&2
    exit 1
  fi
fi

mkdir -p /etc/nginx/stream.d
DROPIN=/etc/nginx/stream.d/term-fast.conf
TS=$(date +%Y%m%d%H%M%S)

# 目标 drop-in 内容；仅在与现状不同才写(避免无谓改动/备份堆积)。改既有 drop-in 前留一次快照供回滚。
read -r -d '' DESIRED_DROPIN <<CONF || true
# 快速通道：把整段 TLS 原样透传给源站(经 WireGuard)。L4，本机不持密钥、不解密。
server {
    listen $FPORT;
    proxy_pass $OWGIP:$FPORT;
    proxy_timeout 4h;
    proxy_connect_timeout 5s;
}
CONF
DROPIN_PREEXISTED=0
if [ -f "$DROPIN" ]; then
  DROPIN_PREEXISTED=1
  cp -a "$DROPIN" "$DROPIN.prev"            # 临时快照(成功后删)，供 nginx -t/reload 失败回滚
fi
if [ ! -f "$DROPIN" ] || ! printf '%s\n' "$DESIRED_DROPIN" | cmp -s - "$DROPIN"; then
  printf '%s\n' "$DESIRED_DROPIN" > "$DROPIN"
fi

restore_dropin() {
  if [ "$DROPIN_PREEXISTED" = 1 ]; then cp -a "$DROPIN.prev" "$DROPIN"; else rm -f "$DROPIN"; fi
}
abort_mod() { [ -n "$MODFILE" ] && rm -f "$MODFILE"; }   # 回滚我们刚装的 load_module(避免下次启动失败)

# 确认「生效配置」真的包含 stream.d/*.conf；否则本 drop-in 是孤儿(2096 不会 listen)。
NBAK=""
if nginx -T 2>/dev/null | grep -qE 'include[[:space:]]+\S*stream\.d'; then
  : # 已 include 我们的 drop-in 目录，无需动 nginx.conf
elif nginx -T 2>/dev/null | grep -qE '^[[:space:]]*stream[[:space:]]*\{' \
  || grep -qE '^[[:space:]]*stream[[:space:]]*\{' /etc/nginx/nginx.conf; then
  # 已存在 stream{} 但没 include 我们的目录：这可能是 xray/别人的块，不擅自改写，中止让人工处理。
  restore_dropin; rm -f "$DROPIN.prev"; abort_mod
  echo "FOREIGN_STREAM_BLOCK_NO_INCLUDE: 检测到已有 stream{} 且未 include /etc/nginx/stream.d/*.conf。" >&2
  echo "  为不误伤既有块，未自动注入。请手动在该 stream{} 内加：include /etc/nginx/stream.d/*.conf; 后重跑。" >&2
  exit 1
else
  # 完全没有 stream{}：追加我们自己的顶层块(只在此分支才改 nginx.conf，故仅此时备份，no-op 重跑不堆备份)。
  NBAK="/etc/nginx/nginx.conf.fastbak.$TS"
  cp -a /etc/nginx/nginx.conf "$NBAK"
  {
    echo ""
    echo "stream {"
    echo "    include /etc/nginx/stream.d/*.conf;"
    echo "}"
  } >> /etc/nginx/nginx.conf
fi

# nginx -t 门控：失败即还原(nginx.conf + drop-in + 我们装的模块)并中止。
if ! nginx -t >/dev/null 2>&1; then
  nginx -t >&2 || true
  [ -n "$NBAK" ] && cp -a "$NBAK" /etc/nginx/nginx.conf
  restore_dropin; rm -f "$DROPIN.prev"; abort_mod
  echo "NGINX_TEST_FAILED" >&2
  exit 1
fi
# reload 也可能失败(极少)：同样回滚，绝不留半改状态。
if ! nginx -s reload >/dev/null 2>&1; then
  nginx -s reload >&2 || true
  [ -n "$NBAK" ] && cp -a "$NBAK" /etc/nginx/nginx.conf
  restore_dropin; rm -f "$DROPIN.prev"; abort_mod
  echo "NGINX_RELOAD_FAILED" >&2
  exit 1
fi
rm -f "$DROPIN.prev"

# 运行态断言：reload 后 master 是否真的 listen 了 FPORT(nginx -t 只验语法，不证 listen)。
# 新装动态模块偶尔 SIGHUP reload 不生效 → 兜底 restart(对 80/xray 安全，同为 graceful)。
if ! ss -ltnH "sport = :$FPORT" 2>/dev/null | grep -q .; then
  systemctl restart nginx || true
  sleep 1
  ss -ltnH "sport = :$FPORT" 2>/dev/null | grep -q . \
    || { echo "FAST_PORT_NOT_LISTENING" >&2; exit 1; }
fi
echo OK
REMOTE

# ── 9) 内建校验：双端 wg 握手 + nginx listen + caddy validate + 端到端 curl ──
log "[9/9] 校验(证书签发/握手可能要 30–120s，带重试窗口)"
PASS=1

# wg 握手：源站上看到 JUMP 对端握手时间 >0；中转机上看到 ORIGIN 对端握手 >0。
hs_origin() { SSH "$ORIGIN_SSH" "wg show '$WG_IF' latest-handshakes" 2>/dev/null \
  | awk -v k="$JUMP_PUB"   '$1==k && $2>0{ok=1} END{exit ok?0:1}'; }
hs_jump()   { SSH "$JUMP_SSH"   "wg show '$WG_IF' latest-handshakes" 2>/dev/null \
  | awk -v k="$ORIGIN_PUB" '$1==k && $2>0{ok=1} END{exit ok?0:1}'; }

# 端到端 curl：--resolve 钉到中转机 IP，绕开 DNS 传播延迟，只测数据面。
# 只接受真正的「应用响应」：2xx/3xx/401/403(含配对页)。502/503/504=后端(终端)挂了 → 判 FAIL。
# 隧道/TLS 不通 = 连接错误(curl 非零) → 也判 FAIL，不会假 PASS。
E2E_CODE=""
e2e() {
  E2E_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    --resolve "$FAST_DOMAIN:$FAST_PORT:$JUMP_PUBIP" \
    "https://$FAST_DOMAIN:$FAST_PORT/" 2>/dev/null) || return 1
  case "$E2E_CODE" in
    2??|3??|401|403) return 0 ;;   # 应用真的应答了(含配对页/鉴权页)
    *)               return 1 ;;   # 000/502/503/504… 视为未就绪
  esac
}

# 重试窗口 ~120s：curl 本身也会触发握手流量。
deadline=$((SECONDS + 130)); e2e_ok=0
while :; do
  if e2e; then e2e_ok=1; break; fi
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 5
done

# 握手在 curl 之后再查(此时应已建立)，各留最多 ~30s 兜底。
hd=$((SECONDS + 30)); ho=0
while :; do hs_origin && { ho=1; break; }; [ "$SECONDS" -ge "$hd" ] && break; sleep 3; done
hd=$((SECONDS + 30)); hj=0
while :; do hs_jump   && { hj=1; break; }; [ "$SECONDS" -ge "$hd" ] && break; sleep 3; done

# nginx：既验 -t 又验 :FAST_PORT 真在 listen(仅 -t 会给假信心) / caddy validate
ngx_ok=0
if SSH "$JUMP_SSH" "nginx -t" >/dev/null 2>&1 \
   && SSH "$JUMP_SSH" "ss -ltnH 'sport = :$FAST_PORT' | grep -q ." >/dev/null 2>&1; then ngx_ok=1; fi
cad_ok=0; SSH "$ORIGIN_SSH" 'set -a; [ -f /etc/caddy/caddy.env ] && . /etc/caddy/caddy.env; set +a; caddy validate --config /etc/caddy/Caddyfile' >/dev/null 2>&1 && cad_ok=1

echo "────────────────────────────────────────"
chk() { if [ "$1" = 1 ]; then printf '  \033[1;32m✓\033[0m %s\n' "$2"; else printf '  \033[1;31m✗\033[0m %s\n' "$2"; PASS=0; fi; }
chk "$ho"     "源站 wg 握手 (对端 JUMP)"
chk "$hj"     "中转机 wg 握手 (对端 ORIGIN)"
chk "$ngx_ok" "中转机 nginx -t 通过 且 :$FAST_PORT 在 listen"
chk "$cad_ok" "源站 caddy validate 通过"
chk "$e2e_ok" "端到端 curl https://$FAST_DOMAIN:$FAST_PORT/ -> HTTP ${E2E_CODE:-无(连接/TLS 错误)}"
echo "────────────────────────────────────────"

if [ "$PASS" = 1 ]; then
  log "PASS —— 快速通道就绪。手机端可经 $FAST_DOMAIN:$FAST_PORT 连 $ORIGIN_SSH。"
  exit 0
else
  die "FAIL —— 见上方未通过项。证书首签可能仍在进行，可稍后重跑(幂等)复核。"
fi
