#!/bin/bash
# =============================================================================
# 在服务器上安装/更新 coturn（自建 TURN 中继）
# =============================================================================
# 用法（在 server/deploy 目录下）：
#   sudo bash setup-turn.sh 8.210.198.140 172.22.210.232
#
# 幂等：重复执行会保留已有的 TURN_SECRET（否则每次换密钥，已经在房里的客户端
# 会在旧凭据过期后突然没中继 —— 那种问题极难查）。
#
# 做完还要手动在两处放行端口（云控制台里改，脚本碰不到）：
#   阿里云安全组入方向：UDP 3478、TCP 3478、TCP 5349、UDP 50000/50999
# =============================================================================
set -euo pipefail

PUBLIC_IP="${1:?缺少公网 IP}"
PRIVATE_IP="${2:?缺少私网 IP（ip -4 addr show 里的那个）}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE=/etc/5blong/env

echo "==> 生成/复用 TURN 密钥"
if grep -q '^TURN_SECRET=' "$ENV_FILE" 2>/dev/null && [ -n "$(grep '^TURN_SECRET=' "$ENV_FILE" | cut -d= -f2)" ]; then
  TURN_SECRET="$(grep '^TURN_SECRET=' "$ENV_FILE" | cut -d= -f2)"
  echo "    复用已有密钥（长度 ${#TURN_SECRET}）"
else
  TURN_SECRET="$(openssl rand -hex 24)"
  echo "    已生成新密钥（长度 ${#TURN_SECRET}）"
fi

echo "==> 写 /etc/turnserver.conf"
# realm / 证书路径是固定的，只有 IP 与密钥随机器变
sed -e "s|__PUBLIC_IP__|$PUBLIC_IP|g" \
    -e "s|__PRIVATE_IP__|$PRIVATE_IP|g" \
    -e "s|__TURN_SECRET__|$TURN_SECRET|g" \
    "$HERE/turnserver.conf" > /etc/turnserver.conf
# 里面有密钥：只给 root 与 turnserver 读
chown root:turnserver /etc/turnserver.conf
chmod 640 /etc/turnserver.conf

echo "==> 开启服务开关"
# Ubuntu 的 coturn 包默认关闭（/etc/default/coturn 里没有 TURNSERVER_ENABLED）
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn || echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn

echo "==> 装续期钩子并同步证书"
install -m 755 "$HERE/letsencrypt-hook.sh" /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
bash /etc/letsencrypt/renewal-hooks/deploy/coturn.sh 5blong.site || true

echo "==> 启动 coturn"
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn
sleep 2

echo "==> 放行本机防火墙（ufw）"
# ⚠️ 这一步最容易漏：云厂商的「安全组」和服务器里的 ufw 是**两道门**，
# 只开安全组、ufw 仍是 deny(incoming)，外面照样连不上。
# 2026-11-03 就是这么卡了半小时：安全组四条规则都加对了，STUN 还是没响应。
# 只加放行，绝不删任何现有规则（尤其 SSH，删了就连不上这台机器了）。
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -q active; then
  ufw allow 3478/udp comment 'TURN (coturn)' >/dev/null 2>&1 || true
  ufw allow 3478/tcp comment 'TURN over TCP' >/dev/null 2>&1 || true
  ufw allow 5349/tcp comment 'TURN over TLS' >/dev/null 2>&1 || true
  ufw allow 50000:50999/udp comment 'TURN relay range' >/dev/null 2>&1 || true
  echo "    ufw 已放行 3478/udp、3478/tcp、5349/tcp、50000:50999/udp"
else
  echo "    ufw 未启用，跳过"
fi

echo "==> 把密钥写进接口服务的环境（同一次执行，两处保持一致）"
if grep -q '^TURN_SECRET=' "$ENV_FILE"; then
  sed -i "s|^TURN_SECRET=.*|TURN_SECRET=$TURN_SECRET|" "$ENV_FILE"
else
  echo "TURN_SECRET=$TURN_SECRET" >> "$ENV_FILE"
fi
if grep -q '^TURN_HOST=' "$ENV_FILE"; then
  sed -i "s|^TURN_HOST=.*|TURN_HOST=5blong.site|" "$ENV_FILE"
else
  echo "TURN_HOST=5blong.site" >> "$ENV_FILE"
fi

echo "==> 状态"
systemctl is-active coturn
ss -lunp 2>/dev/null | grep -E ':3478|:5349' | awk '{print "    " $1, $5}' || echo "    ⚠ 没在监听，看 journalctl -u coturn"
