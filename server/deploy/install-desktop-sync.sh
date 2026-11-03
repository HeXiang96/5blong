#!/usr/bin/env bash
# 安装「桌面端更新源自动同步」：把 CI 出的新版安装包拉到本机静态站目录。
#
# 幂等：重复执行只会刷新文件并重启定时器，不会产生第二份。
# 用法（在服务器上，解包后）：
#   bash /opt/5blong/server/deploy/install-desktop-sync.sh
set -euo pipefail

SERVER_DIR=/opt/5blong/server
UNIT_DIR=/etc/systemd/system

NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  echo "找不到 node，先确认 Node 22 已装" >&2
  exit 1
fi
echo "node: $NODE ($("$NODE" -v))"

chmod 0755 "$SERVER_DIR/scripts/sync-desktop.mjs"

# service 里的 node 路径按本机实际位置写死，避免 PATH 不一致
sed "s|^ExecStart=.*|ExecStart=$NODE $SERVER_DIR/scripts/sync-desktop.mjs|" \
  "$SERVER_DIR/deploy/5blong-desktop-sync.service" > "$UNIT_DIR/5blong-desktop-sync.service"
install -m 0644 "$SERVER_DIR/deploy/5blong-desktop-sync.timer" "$UNIT_DIR/5blong-desktop-sync.timer"

systemctl daemon-reload
systemctl enable 5blong-desktop-sync.timer >/dev/null 2>&1 || true
systemctl restart 5blong-desktop-sync.timer

echo "--- 立刻跑一次 ---"
systemctl start 5blong-desktop-sync.service || true
sleep 1
journalctl -u 5blong-desktop-sync.service -n 20 --no-pager -o cat || true

echo "--- 定时器状态 ---"
systemctl list-timers 5blong-desktop-sync.timer --no-pager || true
