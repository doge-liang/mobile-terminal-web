#!/usr/bin/env bash
# pool-add-jump.sh — 一条命令把一台跳板机加进(或摘出)全部加速池。
#
# provision-fast-relay.sh 每次只处理「一台跳板 × 一个池」，要手填 10 个位置参数外加
# 人工挑 wg 尾号；一台跳板要进 N 个池就得抄 N 遍。本脚本是它的薄包装：
#   - 读池表 scripts/pools(格式见 scripts/pools.example，真实池表不进仓库)；
#   - 尾号自动：从各池源站的 wg 配置反查(只取 `# relay <ip>` / `AllowedIPs` 两类行，
#     不读私钥)。该跳板已入某池则复用其既有尾号(幂等重跑)；否则取「所有池都空闲」
#     的最小尾号(≥2)，让同一台跳板在各池尾号一致，便于对照；
#   - 逐池调用 provision-fast-relay.sh(池模式)。任一池失败即停：provision 幂等，
#     修因后重跑本命令即可；要整体回退加 --down。
#   本脚本不改 provision 的任何语义，也不打印令牌。
#
# 用法：
#   scripts/pool-add-jump.sh <jump-ssh-alias> <jump-pubip> [选项]
#     --sudo             中转机登录用户非 root(须免密 sudo) → JUMP_SUDO=1
#     --name <label>     快速域名首标签(缺省=ssh 别名小写，如 DMIT-HK01 → dmit-hk01)
#     --pool <name>      只处理该池(可重复)；缺省=池表全部
#     --tail <N>         指定 wg 尾号(缺省自动；与既有落盘不符会中止而非改写)
#     --down             摘除：逐池跑 DOWN=1(尾号自源站反查；本就不在的池跳过)
#     --dry-run          只打印计划与将执行的命令，不改任何机器(仍会 ssh 只读探测尾号)
#     --no-mod-install   ALLOW_MOD_INSTALL=0(缺省 1：允许中转机 apt 装 libnginx-mod-stream)
# 环境：
#   CF_DNS_TOKEN   Cloudflare 令牌(Zone:Read + DNS:Edit)；缺省从 CF_TOKEN_FILE(~/.cf_token)读
#   POOLS_FILE     池表路径(缺省 scripts/pools)
#   CF_ZONE        Cloudflare 区(缺省=池域去掉首标签：t2.example.com → example.com)
#
# 前提：控制机对中转机与各池源站均已配好免密 ssh；中转机已装 nginx(缺 stream 模块可由
#   provision 按 ALLOW_MOD_INSTALL 补装，但 nginx 本体不代装——apt 连带装 nginx 会带出默认
#   :80 站点，须人工处理，故预检直接中止)。
set -euo pipefail

export HOME="${HOME:-/root}"
HERE=$(cd "$(dirname "$0")" && pwd)
PROVISION="$HERE/provision-fast-relay.sh"
POOLS_FILE="${POOLS_FILE:-$HERE/pools}"
CF_TOKEN_FILE="${CF_TOKEN_FILE:-$HOME/.cf_token}"

log()  { printf '\033[1;36m[pool-add-jump]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[pool-add-jump] ⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[pool-add-jump] ✗ %s\033[0m\n' "$*" >&2; exit 1; }
SSH()  { ssh -o BatchMode=yes -o ConnectTimeout=10 "$@"; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

# ── 参数 ────────────────────────────────────────────────────────────────────
need_arg() { [ $# -ge 2 ] || die "选项 $1 需要一个参数"; }
JUMP_SSH=""; JUMP_PUBIP=""; NAME=""; JUMP_SUDO=0; TAIL=""; DOWN=0; DRY=0; MOD=1
ONLY_POOLS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --sudo)           JUMP_SUDO=1 ;;
    --name)           need_arg "$@"; NAME="$2"; shift ;;
    --pool)           need_arg "$@"; ONLY_POOLS+=("$2"); shift ;;
    --tail)           need_arg "$@"; TAIL="$2"; shift ;;
    --down)           DOWN=1 ;;
    --dry-run)        DRY=1 ;;
    --no-mod-install) MOD=0 ;;
    -h|--help)        usage; exit 0 ;;
    --*)              die "未知选项：$1(--help 看用法)" ;;
    *)
      if   [ -z "$JUMP_SSH" ];   then JUMP_SSH="$1"
      elif [ -z "$JUMP_PUBIP" ]; then JUMP_PUBIP="$1"
      else die "多余参数：$1"; fi ;;
  esac
  shift
done
if [ -z "$JUMP_SSH" ] || [ -z "$JUMP_PUBIP" ]; then usage >&2; exit 2; fi
[ -x "$PROVISION" ] || die "找不到 $PROVISION"

# 参数会经 ssh 交远端 shell 二次解析、也会拼进域名——只放行安全字符。
case "$JUMP_SSH" in ''|*[!a-zA-Z0-9._@-]*) die "ssh 别名含非法字符：$JUMP_SSH" ;; esac
case "$JUMP_PUBIP" in
  *[!0-9.]*|'') die "跳板公网 IP 须为 IPv4：$JUMP_PUBIP" ;;
esac
[ -n "$NAME" ] || NAME=$(printf '%s' "${JUMP_SSH##*@}" | tr 'A-Z' 'a-z')
case "$NAME" in
  ''|-*|*-|*[!a-z0-9-]*) die "域名标签非法：$NAME(只允许 a-z 0-9 -，不首尾连字符；用 --name 指定)" ;;
esac
if [ -n "$TAIL" ]; then
  case "$TAIL" in ''|*[!0-9]*) die "--tail 须为纯数字：$TAIL" ;; esac
  if [ "$TAIL" -lt 2 ] || [ "$TAIL" -gt 254 ]; then die "--tail 须在 2..254：$TAIL"; fi
fi
JSUDO=""
if [ "$JUMP_SUDO" = 1 ]; then JSUDO="sudo -n"; fi

# ── 池表 ────────────────────────────────────────────────────────────────────
# 列：name origin_ssh origin_pubip origin_wg_ip wg_subnet pool_domain fast_port wg_if wg_port
[ -f "$POOLS_FILE" ] || die "缺池表 $POOLS_FILE —— 复制 scripts/pools.example 按实际填写。"
P_NAME=(); P_OSSH=(); P_OIP=(); P_OWG=(); P_SUBNET=(); P_DOMAIN=(); P_PORT=(); P_IF=(); P_WGPORT=()
ALL_NAMES=()
pool_wanted() {
  local want
  [ ${#ONLY_POOLS[@]} -eq 0 ] && return 0
  for want in "${ONLY_POOLS[@]}"; do [ "$want" = "$1" ] && return 0; done
  return 1
}
while read -r n ossh oip owg subnet dom port ifn wgport _extra; do
  case "$n" in ''|'#'*) continue ;; esac
  [ -n "$wgport" ] || die "池表行格式错(需 9 列)：$n $ossh $oip $owg $subnet $dom $port $ifn"
  case "$owg" in *.*.*.*) : ;; *) die "池 $n 的 origin_wg_ip 非 IPv4：$owg" ;; esac
  ALL_NAMES+=("$n")
  pool_wanted "$n" || continue
  P_NAME+=("$n"); P_OSSH+=("$ossh"); P_OIP+=("$oip"); P_OWG+=("$owg"); P_SUBNET+=("$subnet")
  P_DOMAIN+=("$dom"); P_PORT+=("$port"); P_IF+=("$ifn"); P_WGPORT+=("$wgport")
done < "$POOLS_FILE"
for want in ${ONLY_POOLS[@]+"${ONLY_POOLS[@]}"}; do
  found=0; for n in ${ALL_NAMES[@]+"${ALL_NAMES[@]}"}; do [ "$n" = "$want" ] && found=1; done
  [ "$found" = 1 ] || die "--pool $want 不在池表中(池表：$POOLS_FILE，已有：${ALL_NAMES[*]:-无})"
done
NP=${#P_NAME[@]}
[ "$NP" -gt 0 ] || die "池表 $POOLS_FILE 里没有池。"

# ── 令牌(dry-run 不需要；绝不打印) ───────────────────────────────────────────
if [ "$DRY" = 0 ]; then
  if [ -z "${CF_DNS_TOKEN:-}" ]; then
    [ -r "$CF_TOKEN_FILE" ] || die "缺 CF_DNS_TOKEN，且 $CF_TOKEN_FILE 不可读。"
    CF_DNS_TOKEN=$(tr -d '\r\n' < "$CF_TOKEN_FILE")
  fi
  [ -n "$CF_DNS_TOKEN" ] || die "CF_DNS_TOKEN 为空。"
  export CF_DNS_TOKEN
fi

# ── 预检：控制机到各机的连通性；中转机须已有 nginx ───────────────────────────
log "预检：ssh $JUMP_SSH ${JSUDO:+(经 $JSUDO)}"
SSH "$JUMP_SSH" "$JSUDO true" >/dev/null 2>&1 \
  || die "中转机 $JUMP_SSH 不可达(BatchMode)${JSUDO:+，或 sudo -n 失败(需免密 sudo)}。"
if [ "$DOWN" = 0 ]; then
  SSH "$JUMP_SSH" "command -v nginx >/dev/null 2>&1" \
    || die "中转机 $JUMP_SSH 没有 nginx。请先手工 apt-get install nginx libnginx-mod-stream 并处理默认 :80 站点，再重跑。"
fi
for ((i=0; i<NP; i++)); do
  SSH "${P_OSSH[i]}" true >/dev/null 2>&1 || die "池 ${P_NAME[i]} 的源站 ${P_OSSH[i]} 不可达。"
done

# 中转机 nginx 预检(仅入池)：provision 要到第 8 步才发现端口被占/遗留 stream 块缺 include，
# 但那时源站侧(DNS、wg 对端、站点块、env)已经落地——半配置。这里把两项判断前移到触碰
# 任何机器之前。「:PORT 在监听且 stream.d 里有指向本池源站的透传」是池化合法复用(SHARED_L4)。
# nginx -T 先捕获再匹配(见 provision 里 SIGPIPE/pipefail 教训)。
if [ "$DOWN" = 0 ]; then
  for ((i=0; i<NP; i++)); do
    verdict=$(SSH "$JUMP_SSH" $JSUDO bash -s -- "${P_PORT[i]}" "${P_OWG[i]}" <<'REMOTE'
PORT="$1"; OWG="$2"
listening=0; ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q . && listening=1
shared=0; grep -qsE "^[[:space:]]*proxy_pass[[:space:]]+$OWG:$PORT;" /etc/nginx/stream.d/*.conf 2>/dev/null && shared=1
if [ "$listening" = 1 ] && [ "$shared" = 0 ]; then echo PORT_TAKEN; fi
dump=$(nginx -T 2>/dev/null) || true
if printf '%s\n' "$dump" | grep -E '^[[:space:]]*stream[[:space:]]*\{' >/dev/null \
   && ! printf '%s\n' "$dump" | grep -E '^[[:space:]]*include[[:space:]]+/etc/nginx/stream\.d/\*\.conf;' >/dev/null; then
  echo FOREIGN_STREAM_NO_INCLUDE
fi
echo END
REMOTE
    ) || die "中转机 $JUMP_SSH 的 nginx 预检执行失败。"
    case "$verdict" in
      *PORT_TAKEN*)
        die "池 ${P_NAME[i]}：中转机 :${P_PORT[i]} 已被非本池的监听占用(遗留手写 stream 块或其它服务)，且 stream.d 里没有指向 ${P_OWG[i]}:${P_PORT[i]} 的透传。请先释放该端口，或用 --pool 只做其它池。未触碰任何机器。" ;;
      *FOREIGN_STREAM_NO_INCLUDE*)
        die "中转机 nginx 已有 stream{} 但未 include /etc/nginx/stream.d/*.conf。请在该 stream{} 内加一行 include /etc/nginx/stream.d/*.conf; 并 nginx -t && nginx -s reload 后重跑。未触碰任何机器。" ;;
      *END*) : ;;
      *) die "中转机 nginx 预检输出异常：$verdict" ;;
    esac
  done
fi

# ── 尾号：反查各池源站 wg 配置 ───────────────────────────────────────────────
# 只拉 `# relay <ip>` 与 `AllowedIPs` 两类行(私钥绝不过线)。输出每行「<ip或-> <尾号>」。
peers_of() {
  SSH "$1" "grep -E '^(# relay |AllowedIPs *=)' '/etc/wireguard/$2.conf' 2>/dev/null || true" \
  | awk '/^# relay /{ip=$3; next}
         /^AllowedIPs/{ v=$0; sub(/^AllowedIPs *= */,"",v); split(v,a,"[./]");
                        print (ip==""?"-":ip), a[4]; ip="" }'
}
EXIST=(); USED=()
for ((i=0; i<NP; i++)); do
  peers=$(peers_of "${P_OSSH[i]}" "${P_IF[i]}")
  ex=$(printf '%s\n' "$peers" | awk -v ip="$JUMP_PUBIP" '$1==ip{print $2; exit}')
  us=$(printf '%s\n' "$peers" | awk 'NF{print $2}' | sort -n | paste -sd' ' -)
  EXIST+=("$ex"); USED+=("$us")
  log "池 ${P_NAME[i]}(${P_IF[i]}@${P_OSSH[i]})：已占尾号 [${us:-无}]${ex:+；本跳板既有尾号 .$ex}"
done
in_list() { local x; for x in $2; do [ "$x" = "$1" ] && return 0; done; return 1; }

# 目标尾号 T：--tail > 既有(各池须一致) > 全池空闲最小值。
T="$TAIL"
if [ -z "$T" ]; then
  for ((i=0; i<NP; i++)); do
    [ -n "${EXIST[i]}" ] || continue
    if [ -z "$T" ]; then T="${EXIST[i]}"
    elif [ "$T" != "${EXIST[i]}" ]; then
      die "本跳板在各池的既有尾号不一致(.$T vs 池 ${P_NAME[i]} 的 .${EXIST[i]})——请 --pool 分池处理并 --tail 指定，或先 --down。"
    fi
  done
fi
if [ -z "$T" ] && [ "$DOWN" = 0 ]; then
  for ((n=2; n<=254; n++)); do
    free=1
    for ((i=0; i<NP; i++)); do in_list "$n" "${USED[i]}" && { free=0; break; }; done
    if [ "$free" = 1 ]; then T=$n; break; fi
  done
  [ -n "$T" ] || die "2..254 无全池空闲尾号。"
fi
# 逐池核对：既有 ≠ T 是不可变字段冲突(provision 不会改写)；无既有但 T 被别人占则是撞号。
for ((i=0; i<NP; i++)); do
  if [ -n "${EXIST[i]}" ] && [ "${EXIST[i]}" != "$T" ]; then
    die "池 ${P_NAME[i]}：本跳板既有尾号 .${EXIST[i]} ≠ 目标 .$T。尾号落盘后不可变，要改请先 --down 再重建。"
  fi
  if [ "$DOWN" = 0 ] && [ -z "${EXIST[i]}" ] && in_list "$T" "${USED[i]}"; then
    die "池 ${P_NAME[i]}：尾号 .$T 已被其它跳板占用。请换 --tail。"
  fi
done

# ── 逐池执行 ────────────────────────────────────────────────────────────────
run_pool() {  # $1=池下标 $2=尾号
  local i="$1" t="$2"
  local jwg="${P_OWG[i]%.*}.$t" fdom="$NAME.${P_DOMAIN[i]}" zone="${CF_ZONE:-${P_DOMAIN[i]#*.}}"
  local -a envs=("POOL_DOMAIN=${P_DOMAIN[i]}" "WG_IF=${P_IF[i]}" "WG_PORT=${P_WGPORT[i]}"
                 "ALLOW_MOD_INSTALL=$MOD" "JUMP_SUDO=$JUMP_SUDO")
  if [ "$DOWN" = 1 ]; then envs+=("DOWN=1"); fi
  local -a argv=("$JUMP_SSH" "$JUMP_PUBIP" "${P_OSSH[i]}" "${P_OIP[i]}" "${P_OWG[i]}" "$jwg"
                 "${P_SUBNET[i]}" "$fdom" "${P_PORT[i]}" "$zone")
  log "池 ${P_NAME[i]} → ${envs[*]} $PROVISION ${argv[*]}"
  if [ "$DRY" = 1 ]; then return 0; fi
  env "${envs[@]}" "$PROVISION" "${argv[@]}"
}

ACTION="入池"; DRYTAG=""
if [ "$DOWN" = 1 ]; then ACTION="摘除"; fi
if [ "$DRY" = 1 ]; then DRYTAG=" [dry-run]"; fi
log "计划：$ACTION $JUMP_SSH($JUMP_PUBIP) 标签 $NAME${T:+ 尾号 .$T}$DRYTAG；池：${P_NAME[*]}"
DONE=()
for ((i=0; i<NP; i++)); do
  t="$T"
  if [ "$DOWN" = 1 ] && [ -z "${EXIST[i]}" ]; then
    if [ -z "$TAIL" ]; then
      log "池 ${P_NAME[i]}：本跳板本就不在其中(源站无对端)，跳过。"; continue
    fi
    t="$TAIL"
  fi
  if ! run_pool "$i" "$t"; then
    die "池 ${P_NAME[i]} 失败(已完成：${DONE[*]:-无})。provision 幂等，修因后原样重跑本命令即可；要整体回退：$0 $JUMP_SSH $JUMP_PUBIP --down${JSUDO:+ --sudo}"
  fi
  DONE+=("${P_NAME[i]}")
done

if [ "$DRY" = 1 ]; then
  log "dry-run 完成，未改任何机器。"
elif [ "$DOWN" = 1 ]; then
  log "摘除完成：${DONE[*]:-无}。DNS/站点块/对端已随 provision DOWN 清理，wg 私钥保留供重建。"
else
  log "入池完成：${DONE[*]}。复核：面板「加速池」区，或各源站主域 /fast?stay=1 只测速。"
fi
