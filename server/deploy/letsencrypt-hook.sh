#!/bin/sh
# =============================================================================
# Let's Encrypt 续期后，把证书同步给 coturn
# =============================================================================
# 为什么不让 coturn 直接读 /etc/letsencrypt/live：
#   那里是 root:root 0700，而 coturn 以 turnserver 用户运行，读不到。
#   把证书放宽权限不安全，复制一份到 /etc/coturn 并只给 turnserver 读，更干净。
#
# 放在 /etc/letsencrypt/renewal-hooks/deploy/ 下，certbot 每次续期成功后自动执行
# （首次签发时也会执行）。
#
# 注意：这里重启 coturn 会让**正在进行的中继会话**断开几秒。
# 续期每 60 天才一次，且实际在到期前 30 天触发，可接受。
# =============================================================================
set -e

DOMAIN="${1:-5blong.site}"
SRC="/etc/letsencrypt/live/$DOMAIN"
DST="/etc/coturn"

[ -f "$SRC/fullchain.pem" ] || { echo "找不到证书：$SRC" >&2; exit 0; }

mkdir -p "$DST"
cp -f "$SRC/fullchain.pem" "$DST/fullchain.pem"
cp -f "$SRC/privkey.pem"   "$DST/privkey.pem"
# 只给 coturn 的运行用户读：0640 + 属主 turnserver
chown root:turnserver "$DST/fullchain.pem" "$DST/privkey.pem"
chmod 640 "$DST/fullchain.pem" "$DST/privkey.pem"

# 配置里 cert/pkey 指向这两个文件；coturn 启动时读，所以要重启才生效
systemctl restart coturn 2>/dev/null || true
echo "已同步证书到 $DST 并重启 coturn"
