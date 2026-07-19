#!/usr/bin/env bash
# box 安装器:默认装本机;--to <ssh-host> 推送到远程节点并在远端执行
set -euo pipefail

if [ "${1:-}" = "--to" ]; then
  host="${2:?用法: install.sh --to <ssh-host>}"
  src="$(cd "$(dirname "$0")" && pwd)"
  tar czf - -C "$(dirname "$src")" box | ssh "$host" 'rm -rf /tmp/box-dist && mkdir -p /tmp/box-dist && tar xzf - -C /tmp/box-dist'
  ssh "$host" 'bash /tmp/box-dist/box/install.sh && rm -rf /tmp/box-dist'
  exit 0
fi

src="$(cd "$(dirname "$0")" && pwd)"
mkdir -p /opt/box /etc/box /run/box /var/lib/box
cp -r "$src/bin" "$src/lib" "$src/exclude.txt" "$src/env.example" "$src/nodes.example" /opt/box/
chmod +x /opt/box/bin/box
ln -sf /opt/box/bin/box /usr/local/bin/box
cp "$src/tmux-inner.conf" /etc/box/tmux-inner.conf
[ -d "$src/base-flake" ] && mkdir -p /etc/box/base-flake && cp "$src"/base-flake/flake.* /etc/box/base-flake/
[ -d "$src/systemd" ] && cp "$src"/systemd/*.service "$src"/systemd/*.timer /etc/systemd/system/ && systemctl daemon-reload
printf 'dev.tty.legacy_tiocsti=0\n' > /etc/sysctl.d/90-box.conf
sysctl -p /etc/sysctl.d/90-box.conf >/dev/null

missing=""
for dep in bwrap restic rclone node tmux; do
  command -v "$dep" >/dev/null || missing="$missing $dep"
done
if [ -n "$missing" ]; then
  echo "缺依赖:$missing" >&2
  echo "  apt-get install -y bubblewrap restic; rclone: curl https://rclone.org/install.sh | bash" >&2
  exit 1
fi
echo "box 安装完成: $(box --help | head -1)"
[ -f /root/.config/box/env ] || echo "提醒: 还需创建 /root/.config/box/env(模板 /opt/box/env.example)"
