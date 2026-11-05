# 自托管后端（香港 ECS）· 现行事实源

> 状态：已上线并稳定运行｜基准版本：1.9.26｜最后核实：2026-11-04
>
> 合并自两份原文（后端迁移交接、自写信令方案），它们只在 `archive/` 里作历史；
> **运维/部署只按本文**。

---

## 0. 一分钟速览

- 域名 `5blong.site`（主站/介绍页 + 桌面更新源）、`web.5blong.site`（网页版应用）。
- 一台香港 ECS，Ubuntu，nginx 收口，四个本地服务：

```
nginx 443
  ├─ /api/           → 127.0.0.1:8788  5blong-api（Node 22 + express + node:sqlite）
  ├─ /sfu/           → 127.0.0.1:8788  屏幕共享代理（→ Cloudflare Realtime）
  ├─ /ice            → 127.0.0.1:8788  TURN 凭据（本地 HMAC 签发）
  ├─ 后台页 /admin /accounts-admin /rooms /game-admin → 8788
  ├─ /peerjs         → 127.0.0.1:9000  5blong-peer（PeerJS 信令）
  ├─ /peerjs/inbox   → 127.0.0.1:8788  账号收件箱推送（**精确匹配**，别写成前缀）
  ├─ /models/        → /var/www/5blong-models  降噪模型（ACAO *，见 §5）
  └─ 静态：/var/www/5blong（主站）、/var/www/5blong/app（web 子域）
coturn（systemd）：3478 udp+tcp、5349 tcp、中继 50000-50999/udp
SQLite：/data/5blong/app.db（WAL），每天 03:00 备份到 /data/5blong/backup/
```

- 8788 / 9000 **只绑 127.0.0.1**，对外一律走 nginx TLS。
- CI 只发网页 + 桌面安装包；**server 代码永远不在 CI 里**（见 §4）。

---

## 1. 为什么搬（别再重新讨论）

Cloudflare Workers 的出口落在 LAX，国内到港/到美西的差距是实测出来的：

| 路径 | RTT |
|---|---|
| CF（LAX） | 154–220 ms |
| 香港 ECS | 20–41 ms |

语音信令、账号接口、TURN 凭据全部对延迟敏感；而且 Workers 的 PBKDF2 迭代有硬上限
（100000），账号密码强度受限。搬完这些限制都没了。

---

## 2. 目录 / 服务 / 数据

| 路径 | 内容 |
|---|---|
| `/opt/5blong/server` | 后端代码（`src/` `scripts/` `deploy/` `db/`），属主 `5blong:5blong` |
| `/var/www/5blong` | 主站（介绍页）+ `desktop/`（更新源）+ `app/`（网页版产物） |
| `/var/www/5blong-models` | 降噪模型（18MB，**不随前端产物**，见 §5） |
| `/data/5blong/app.db` | 全部业务数据（账号、好友、邀请、遥测、duel_sessions…） |

systemd：`5blong-api`、`5blong-peer`、`coturn`、`nginx`，外加三个 timer：
`5blong-web-sync`（5 分钟）、`5blong-desktop-sync`（10 分钟）、`5blong-backup`（每天 03:00）。

**两个 sync timer 是"服务器主动拉"**：CI 打完包发 GitHub Release，服务器自己去拉
`dist-web.tar.gz` 和桌面产物。好处是 CI 里不需要任何服务器凭据。

---

## 3. 日常运维（复制即用）

```bash
# 状态
systemctl status 5blong-api 5blong-peer coturn nginx --no-pager
curl -s http://127.0.0.1:8788/healthz   # ok / accounts / turnConfigured / liveRooms
curl -s https://5blong.site/api/duel/poll -X POST -H 'Content-Type: application/json' \
  -d '{"clientId":"diag12345678","room":"000000"}'

# 日志
journalctl -u 5blong-api --since '-10min' --no-pager | tail -50
journalctl -u coturn --since '-10min' --no-pager | grep -E 'session .*: usage'

# 备份（别用 cp！WAL 模式会拷到半截）
sudo -u 5blong sqlite3 /data/5blong/app.db ".backup '/data/5blong/backup/manual.db'"
```

健康检查在公网是 403（nginx `allow 127.0.0.1; deny all`），**这是正确行为**，不是故障。

---

## 4. 部署（最容易漏的一步）

### 4.1 服务端代码：手动，永远手动

```bash
scp -i .deploy_key server/src/*.mjs   root@5blong.site:/opt/5blong/server/src/
scp -i .deploy_key server/db/schema.sql root@5blong.site:/opt/5blong/server/db/
ssh -i .deploy_key root@5blong.site 'node /opt/5blong/server/scripts/init-db.mjs'   # 幂等
ssh -i .deploy_key root@5blong.site 'systemctl restart 5blong-api'
ssh -i .deploy_key root@5blong.site 'cd /opt/5blong/server && BASE=https://5blong.site node scripts/duel-smoke.mjs'
```

> **1.9.24 事故**：客户端发了新功能、服务端 `/api/duel` 没推，线上 404 两天没人发现。
> **CI 绿 ≠ 全部上线。改了什么端，就部署什么端，并 curl 验证那个端。**

### 4.2 网页 / 桌面

发 `npm run bump -- x.y.z` 推 tag → CI 出包 → 服务器两个 timer 自动拉，**不需要手动 rsync**。
手动 `rsync -av --delete dist-web/ ...` 只在应急时用，且要注意 `apps` 在 `app/` 子目录。

### 4.3 nginx

仓库里的 `server/deploy/nginx.conf` 就是线上那份（改完 scp 到
`/etc/nginx/sites-available/5blong`，`nginx -t` 过了再 `reload`，改前先备份）。

---

## 5. 降噪模型（18MB，独立于前端产物）

- 文件：`/var/www/5blong-models/denoise_voice_core_bg.wasm`
- nginx：主域 + web 子域各一段 `location ^~ /models/`（alias、`application/wasm`、ACAO `*`、immutable）
- **不能**放站点根目录：前端产物是整目录 `rsync --delete`，发一次版就删没了
- 客户端：用户点「立即下载」才拉，存 Cache Storage；没下就降级 RNNoise
- 换模型时改文件名（带版本），别原地覆盖——客户端按 immutable 缓存

---

## 6. 仍在 Cloudflare 的东西

| 东西 | 位置 | 说明 |
|---|---|---|
| 信令 Worker | `worker/signal/`（`5blong-signal`） | **不随 CI 更新**，改完用 `npm run signal:deploy` 单独部署，且必须**先部署它再 bump** |
| 屏幕共享 SFU | Cloudflare Realtime | 只做转发，`/sfu/` 代理补 Bearer |

Workers 的 Pages 部署（`deploy-pages.mjs`）已退居兜底，正常发版不走它。

---

## 7. 已知的坑（新增请接着往下写）

1. **`/peerjs/inbox` 必须精确匹配**，写成前缀会把整条 PeerJS 连接吃掉。
2. coturn 的 `user-quota` 默认 12 → 第 13 个人静默失败（1.9.20 真因），已抬到 500。
3. ECS 网卡只有私网地址（172.x），coturn 必须显式配 `external-ip`。
4. ufw 是最后一道卡点（安全组放行不等于本机放行）。
5. `PBKDF2` 在 Workers 上最多 100000 次迭代；ECS 上没这个限制（哈希串自带轮数，改强度不影响老密码）。
6. 备份只认 `sqlite3 .backup`，`cp` 会拷到 WAL 半截。
