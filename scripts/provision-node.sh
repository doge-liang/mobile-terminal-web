#!/usr/bin/env bash
# 在新机器上一键起 mobile-terminal 栈 + token 化 cloudflared tunnel。
# 用法: TUNNEL_TOKEN=... ACCESS_AUD=... ./scripts/provision-node.sh <ssh-host> <main-host>
#   <ssh-host>  已在 ~/.ssh/config 配好免密的别名，如 racknerd-13d12ee
#   <main-host> 对外域名，如 term2.doge-liang-space.uk
set -euo pipefail

SSH_HOST="${1:?need ssh host}"
MAIN_HOST="${2:?need main host}"
: "${TUNNEL_TOKEN:?need TUNNEL_TOKEN}"
: "${ACCESS_AUD:?need ACCESS_AUD}"
TEAM_DOMAIN="doge-liang.cloudflareaccess.com"
DIR="/root/mobile-terminal-web"
# 本控制机上的仓库即部署源（GitHub 仓库为私有，新机器无凭据；从这里 tar 过去更可靠）。
LOCAL_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[1/6] 装系统依赖 (build-essential python3 tmux git ca-certificates)"
ssh "$SSH_HOST" 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && \
  apt-get install -y -qq build-essential python3 tmux git ca-certificates curl'

echo "[2/6] 装 Node.js 20 (NodeSource)"
ssh "$SSH_HOST" 'command -v node >/dev/null && node -v | grep -q "^v20" || { \
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs; }; node -v'

echo "[3/6] 装 cloudflared (.deb)"
ssh "$SSH_HOST" 'command -v cloudflared >/dev/null || { \
  curl -fsSL -o /tmp/cfd.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && \
  dpkg -i /tmp/cfd.deb; }; cloudflared --version'

echo "[4/6] 同步仓库(tar over ssh) + npm ci (编译 node-pty)"
ssh "$SSH_HOST" "mkdir -p $DIR"
tar -C "$LOCAL_REPO" --exclude=node_modules --exclude=.git -czf - . \
  | ssh "$SSH_HOST" "tar -C $DIR -xzf -"
ssh "$SSH_HOST" "cd $DIR && npm ci --no-audit --no-fund"

echo "[5/6] 写 env + 装 mobile-terminal.service"
ssh "$SSH_HOST" "cat > /etc/default/mobile-terminal <<EOF
CF_ACCESS_TEAM_DOMAIN=$TEAM_DOMAIN
CF_ACCESS_AUD=$ACCESS_AUD
MAIN_HOST=$MAIN_HOST
HOST=127.0.0.1
EOF
cat > /etc/systemd/system/mobile-terminal.service <<'UNIT'
[Unit]
Description=mobile-terminal-web (xterm.js + node-pty + tmux)
After=network.target
[Service]
Type=simple
WorkingDirectory=/root/mobile-terminal-web
EnvironmentFile=-/etc/default/mobile-terminal
ExecStart=/usr/bin/node /root/mobile-terminal-web/server.js
Restart=always
RestartSec=3
KillMode=process
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now mobile-terminal.service"

echo "[6/6] 装 token 化 cloudflared 服务"
ssh "$SSH_HOST" "cloudflared service install $TUNNEL_TOKEN"

echo "完成。校验:"
sleep 5
curl -sI "https://$MAIN_HOST" | head -3 || true
echo "→ 期望 302（Access 登录页）。请在浏览器打开 https://$MAIN_HOST 走一次 OTP 确认终端可连。"
