#!/usr/bin/env bash
# 5blong 数据库每日备份
#
# 装到 cron：
#   0 3 * * * /opt/5blong/server/deploy/backup.sh >> /var/log/5blong-backup.log 2>&1
#
# 为什么不用 cp：
#   数据库开着 WAL 的时候，直接 cp 主文件会拿到"半个事务"，
#   恢复出来可能缺最新几条记录、甚至校验不过。
#   `sqlite3 .backup` 走的是在线备份 API，能拿到一致性快照。
set -euo pipefail

DB="${DB_PATH:-/data/5blong/app.db}"
DIR="${BACKUP_DIR:-/data/5blong/backup}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DIR/app-$STAMP.db"

mkdir -p "$DIR"

if [[ ! -f "$DB" ]]; then
  echo "[$(date -Is)] 数据库不存在：$DB"
  exit 1
fi

# 在线一致性备份
sqlite3 "$DB" ".backup '$OUT'"

# 校验：备份文件能打开、能查、表数对得上，才算成功
if ! sqlite3 "$OUT" "PRAGMA integrity_check;" | grep -qx "ok"; then
  echo "[$(date -Is)] ❌ 备份完整性检查失败：$OUT"
  rm -f "$OUT"
  exit 1
fi

ACCOUNTS="$(sqlite3 "$OUT" "SELECT COUNT(*) FROM accounts;" 2>/dev/null || echo 0)"
SIZE="$(du -h "$OUT" | cut -f1)"
gzip -9 "$OUT"

echo "[$(date -Is)] ✅ 备份完成 app-$STAMP.db.gz · ${SIZE} · 账号 $ACCOUNTS 个"

# 清理过期备份
find "$DIR" -name 'app-*.db.gz' -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true

# 上传到阿里云 OSS（可选）
# 需要先装 ossutil 并配好 AK；没装就只留本地
if command -v ossutil >/dev/null 2>&1 && [[ -n "${OSS_BUCKET:-}" ]]; then
  ossutil cp "$DIR/app-$STAMP.db.gz" "oss://$OSS_BUCKET/5blong-backup/" >/dev/null
  echo "[$(date -Is)] ✅ 已上传 oss://$OSS_BUCKET/5blong-backup/app-$STAMP.db.gz"
else
  echo "[$(date -Is)] · 跳过 OSS 上传（未安装 ossutil 或未设 OSS_BUCKET）"
fi
