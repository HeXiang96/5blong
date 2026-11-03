#!/usr/bin/env bash
# 安装「内容同步」的两个 systemd 定时器：
#   5blong-desktop-sync —— 拉桌面安装包与 latest.json（发版后最多 10 分钟）
#   5blong-web-sync     —— 拉 dist-web.tar.gz 覆盖静态站（发版后最多 5 分钟）
#
# 幂等：重复执行只会刷新文件、重启定时器，不会产生第二份。
# 用法（解包后，在服务器上）：
#   bash /opt/5blong/server/deploy/install-sync.sh
set -euo pipefail

SERVER_DIR=/opt/5blong/server
UNIT_DIR=/etc/systemd/system

NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  echo "找不到 node，先确认 Node 22 已装" >&2
  exit 1
fi
echo "node: $NODE ($("$NODE" -v))"

for bin in tar rsync; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "缺 $bin：apt install -y $bin" >&2
    exit 1
  }
done
echo "tar/rsync: 就绪"

chmod 0755 "$SERVER_DIR/scripts/sync-desktop.mjs" "$SERVER_DIR/scripts/sync-web.mjs"

for name in desktop web; do
  # node 路径按本机实际位置写死，避免 systemd 的 PATH 与登录 shell 不一致
  sed "s|^ExecStart=.*|ExecStart=$NODE $SERVER_DIR/scripts/sync-$name.mjs|" \
    "$SERVER_DIR/deploy/5blong-$name-sync.service" > "$UNIT_DIR/5blong-$name-sync.service"
  install -m 0644 "$SERVER_DIR/deploy/5blong-$name-sync.timer" "$UNIT_DIR/5blong-$name-sync.timer"
done

systemctl daemon-reload
for name in desktop web; do
  systemctl enable "5blong-$name-sync.timer" >/dev/null 2>&1 || true
  systemctl restart "5blong-$name-sync.timer"
done

echo "--- 各跑一次 ---"
systemctl start 5blong-desktop-sync.service || true
systemctl start 5blong-web-sync.service || true
sleep 2
for name in desktop web; do
  echo "[$name]"
  journalctl -u "5blong-$name-sync.service" -n 10 --no-pager -o cat || true
done

echo "--- 定时器 ---"
systemctl list-timers '5blong-*-sync.timer' --no-pager || true
