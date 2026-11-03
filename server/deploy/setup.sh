#!/usr/bin/env bash
# 5blong 服务端一键装环境（Ubuntu 22.04 / 24.04）
#
# 用法（在服务器上，root 或 sudo）：
#   bash deploy/setup.sh 5blong.site admin@example.com
#
# 做四件事：Node 20 + nginx + certbot + 目录骨架。
# 它**不**碰你的代码，也不启动服务 —— 那些在 README 的"上线步骤"里。
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"

if [[ -z "$DOMAIN" ]]; then
  echo "用法：bash deploy/setup.sh <域名> [邮箱]"
  echo "例：  bash deploy/setup.sh 5blong.site me@example.com"
  exit 1
fi

echo "==> 域名：$DOMAIN"

# ── 1. 系统包 ────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg nginx certbot python3-certbot-nginx sqlite3 rsync ufw

# ── 2. Node 22（服务端用 node:sqlite 内置模块，需要 ≥22.5，且**不需要编译工具**） ─
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  echo "==> 安装 Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
else
  echo "==> Node 已就绪：$(node -v)"
fi
node -v
npm -v

# 自检：node:sqlite 必须可用（Node 22.5 起内置）。不可用就别往下走，
# 否则要等到跑接口时才发现，那时已经在排查"为什么注册 500"了。
node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').exec('select 1')" \
  || { echo "❌ 这个 Node 版本没有 node:sqlite，请升级到 22.5+"; exit 1; }
echo "==> node:sqlite 可用"

# ── 3. 目录骨架 ──────────────────────────────────────────────────────────
echo "==> 建目录"
mkdir -p /opt/5blong /var/www/5blong /var/www/certbot /data/5blong/backup /etc/5blong

# 数据库目录给服务用户读写
id -u 5blong >/dev/null 2>&1 || useradd --system --home /opt/5blong --shell /usr/sbin/nologin 5blong
chown -R 5blong:5blong /opt/5blong /data/5blong

# ── 4. 环境变量模板（不覆盖已存在的） ────────────────────────────────────
ENV_FILE=/etc/5blong/env
if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> 写环境变量模板 $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# 5blong 服务端环境变量（改完 systemctl restart 5blong-api）
PORT=8788
PEER_PORT=9000
DB_PATH=/data/5blong/app.db
PUBLIC_ORIGIN=https://${DOMAIN}
# 生产一定要 Secure（走 https）；本地 http 调试时设 0
COOKIE_SECURE=1

# Cloudflare Realtime TURN 凭据签发（不填也能跑，客户端会自动退回纯 STUN）
CF_TURN_APP_ID=
CF_TURN_API_TOKEN=
EOF
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
else
  echo "==> 已存在 $ENV_FILE，跳过（不覆盖你的配置）"
fi

# ── 5. 防火墙 ────────────────────────────────────────────────────────────
# 阿里云的安全组也要开 80/443，这里只是本机层
echo "==> 配置 ufw"
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

echo
echo "=============================================================="
echo " 环境装好了。接下来（见 server/README.md）："
echo "   1. 把代码放到 /opt/5blong"
echo "   2. cd /opt/5blong/server && npm install --omit=dev"
echo "   3. npm run init-db"
echo "   4. 装 systemd：deploy/5blong-api.service / 5blong-peer.service"
echo "   5. 静态产物放到 /var/www/5blong"
echo "   6. 配 nginx：deploy/nginx.conf → /etc/nginx/sites-available/5blong"
if [[ -n "$EMAIL" ]]; then
  echo "   7. 签证书：certbot --nginx -d $DOMAIN -d www.$DOMAIN -m $EMAIL --agree-tos"
else
  echo "   7. 签证书：certbot --nginx -d $DOMAIN -m <你的邮箱> --agree-tos"
fi
echo "=============================================================="
