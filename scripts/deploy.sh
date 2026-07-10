#!/usr/bin/env bash
# 把当前工作区的运行时代码发布到 scripts/nodes 里列出的每个节点，并做发布后健康检查。
#
# 用法:
#   scripts/deploy.sh              # 发布到所有节点并重启、自检
#   scripts/deploy.sh --dry-run    # 只演示 rsync 会传哪些文件，不改任何节点
#   scripts/deploy.sh --deps       # 依赖变更时，在每个节点额外跑 npm ci
#
# 节点清单来自 scripts/nodes（不进仓库，见 scripts/nodes.example）。每行:
#   <ssh别名|local>  <部署路径>  <端口>
#
# 设计要点:
#   - 只发布“白名单”里的运行时文件；机密(.auth-secret)、每机独立的 node_modules
#     (含原生 node-pty)、服务器上的运行时数据(uploads/metrics)一律不碰。
#   - 不用 rsync --delete：绝不删除目标机上白名单以外的东西。
#   - server.js 改动需重启才生效，所以每个节点都重启 + 自检。
#   - local 节点即本机(工作区就是源)，免 ssh，直接校验/重启/自检。
set -euo pipefail

# ssh 与 git 凭证都要读 $HOME；有些精简 shell 不设 HOME，兜一个默认值。
export HOME="${HOME:-/root}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODES_FILE="${NODES_FILE:-$REPO/scripts/nodes}"
SERVICE="${SERVICE:-mobile-terminal}"

# 白名单:恰好是应用运行时需要的东西，别的都不发。
WHITELIST=(server.js lib public package.json package-lock.json)

DEPS=0; DRYRUN=""
for a in "$@"; do
  case "$a" in
    --deps)          DEPS=1 ;;
    -n|--dry-run)    DRYRUN="-n" ;;
    -h|--help)       sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "未知参数: $a（见 --help）" >&2; exit 2 ;;
  esac
done

[ -f "$NODES_FILE" ] || {
  echo "找不到节点清单: $NODES_FILE" >&2
  echo "→ 复制 scripts/nodes.example 为 scripts/nodes 并按你的机器填写。" >&2
  exit 2
}

# 你发布的是“磁盘上此刻的文件”，不是某个 git 提交——有未提交改动就提醒一声。
if [ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]; then
  echo "⚠ 工作区有未提交改动，将按磁盘现状发布。"
fi

# 在节点上执行一段命令：local 直接跑，远程走 ssh。
on_node() { local host="$1"; shift
  if [ "$host" = local ]; then bash -c "$*"; else ssh -o ConnectTimeout=10 "$host" "$*"; fi
}

sha() { sha256sum "$1" | awk '{print $1}'; }

fails=()
while read -r host path port _rest; do
  [ -z "${host:-}" ] && continue
  case "$host" in \#*) continue ;; esac
  echo "── $host  ($path :$port) ──"

  # 1) 同步白名单（local 的工作区就是源，免同步；除非 path 不是本仓库）
  if [ "$host" = local ] && [ "$path" = "$REPO" ]; then
    echo "  local：工作区即源，跳过同步"
  else
    dest="$path/"; [ "$host" = local ] || dest="$host:$path/"
    src=(); for f in "${WHITELIST[@]}"; do src+=("$REPO/$f"); done
    rsync -az $DRYRUN "${src[@]}" "$dest"
    echo "  同步完成${DRYRUN:+（dry-run，未改动）}"
  fi
  [ -n "$DRYRUN" ] && { echo "  dry-run：跳过校验/重启/自检"; continue; }

  # 2) 重启前校验：语法 + 关键 require 能解析（避免把崩溃的代码重启上线）
  if ! on_node "$host" "cd $path && node --check server.js && node -e 'require(\"./lib/chunk-upload\")'" ; then
    echo "  ✗ 校验失败，跳过该节点（未重启）"; fails+=("$host:validate"); continue
  fi

  # 3) 依赖变更时才装（默认不动 node_modules）
  if [ "$DEPS" = 1 ]; then
    echo "  npm ci …"; on_node "$host" "cd $path && npm ci --omit=dev" || { echo "  ✗ npm ci 失败"; fails+=("$host:deps"); continue; }
  fi

  # 4) 重启
  on_node "$host" "systemctl restart $SERVICE"
  sleep 1.5

  # 5) 健康检查：服务 active + 端口有响应(未鉴权应答 401/403，非 000) + server.js 字节与本地一致
  ok=1
  active=$(on_node "$host" "systemctl is-active $SERVICE" || true)
  [ "$active" = active ] || { echo "  ✗ 服务未 active（$active）"; ok=0; }
  code=$(on_node "$host" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$port/ || true")
  case "$code" in 000|"") echo "  ✗ 端口无响应（进程未起？）"; ok=0 ;; *) echo "  ✓ 端口有响应（HTTP $code）" ;; esac
  want=$(sha "$REPO/server.js"); got=$(on_node "$host" "sha256sum $path/server.js | awk '{print \$1}'" || true)
  [ "$want" = "$got" ] && echo "  ✓ server.js 字节一致" || { echo "  ✗ server.js 与本地不一致（want ${want:0:12} got ${got:0:12}）"; ok=0; }

  if [ "$ok" = 1 ]; then echo "  ✓ $host 健康"; else fails+=("$host:health"); fi
done < "$NODES_FILE"

echo "────────"
if [ ${#fails[@]} -eq 0 ]; then
  echo "✓ 全部节点发布并自检通过。"
else
  echo "✗ 有节点未通过: ${fails[*]}"; exit 1
fi
