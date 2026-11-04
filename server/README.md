# 5blong 自托管后端

把 `Cloudflare Pages Worker` 上的账号系统 + PeerJS 信令搬到一台香港 ECS 上。
**目的只有一个：把跨境那 200ms 打掉。**

---

## 为什么搬

实测（2026-11-03，业主家里的线路）：

| 目标 | TCP 连接耗时 |
|---|---|
| 百度（国内基准） | 17–25 ms |
| 香港（阿里云国际站） | **20–41 ms** |
| Cloudflare（落到 LAX 洛杉矶） | **154–220 ms** |

`5blong.pages.dev` 在这条线路上被 CF 路由到洛杉矶，于是：

- 主包 639 KB 实测 **1.7–7.8 秒**才下完
- `/ice` 接口 8 次里有 1 次超过 6 秒无响应，而客户端只等 2.5 秒
  → 拿不到 TURN 凭据 → 打洞失败时没有中继 → **「两个人都显示已连接却互相听不到」**

所以这套服务放在香港，本质是把「每次都要跨太平洋的事」变成「37ms 的事」。

---

## 架构

```
                        5blong.site（同一个域名，避免跨站 cookie）
                                  │
                        ┌─────────┴─────────┐
                        │      nginx        │  TLS / 静态 / 反代
                        └─────────┬─────────┘
              ┌───────────────────┼────────────────────┐
              │                   │                    │
      /var/www/5blong        /api/*  /ice         /peerjs（WebSocket）
       静态站（dist-web）          │                    │
                          ┌───────┴───────┐    ┌───────┴───────┐
                          │ 5blong-api    │    │ 5blong-peer   │
                          │ :8788         │    │ :9000         │
                          │ SQLite        │    │ PeerJS 内存态  │
                          └───────────────┘    └───────────────┘
```

**为什么静态站也放在这台机器上**，而不是 EdgeOne Pages：

前端在 `5blong.site`、接口在 `api.5blong.site` 就是**跨站**，而登录 cookie 是
`SameSite=Lax` —— 跨站不带 cookie，**所有人会掉登录**。同域名就完全没有这个问题，
也不需要写反代函数。639 KB 从香港直出比"绕去 EdgeOne 再回源"还少一跳。

以后真要 CDN，把 EdgeOne 的 CDN 模式套在这台机器前面，源站不用动。

---

## 本地跑起来

```bash
cd server
npm install                       # 只有 express + peer，纯 JS，不需要编译工具

DB_PATH=./.tmp/app.db \
COOKIE_SECURE=0 \
PORT=8788 \
node src/index.mjs                # 接口

PEER_PORT=9000 node scripts/peer.mjs   # 信令（另开一个终端）
```

冒烟测试（会真的写测试账号，别对着生产库跑）：

```bash
BASE=http://127.0.0.1:8788 npm run selftest
```

当前实测 **40 项全过**，覆盖：注册 / 用户名判重 / 弱密码 / 改昵称 /
房号认领与锁定 / 好友申请与同意 / 备注名 / 在线心跳 / 邀请（含钥匙）/ 改密码 /
登出 / TURN 凭据。

信令单独验过两件事：

- 单连接握手收到 `{"type":"OPEN"}`，`/peerjs/id` 返回 UUID
- **两个 peer 之间能互相转发 OFFER**（真正的信令中继）

---

## 部署到 ECS（Ubuntu 22.04 / 24.04，香港）

### 1. 装环境

```bash
# 代码放上去（git clone 或 rsync）
sudo mkdir -p /opt/5blong && sudo chown $USER /opt/5blong
# 把仓库内容放到 /opt/5blong

cd /opt/5blong/server
sudo bash deploy/setup.sh 5blong.site you@example.com
```

`setup.sh` 会装 Node 22 + nginx + certbot + sqlite3，建目录，写 `/etc/5blong/env` 模板，
并**自检 `node:sqlite` 是否可用**（不可用直接报错，不让你到跑接口时才发现）。

### 2. 装依赖、建库

```bash
cd /opt/5blong/server
npm install --omit=dev
sudo -u 5blong DB_PATH=/data/5blong/app.db node scripts/init-db.mjs
```

`init-db` 会打印表、索引、`journal_mode`，并**检查两个关键唯一索引**
（`idx_accounts_username`、`idx_accounts_room_code`）—— 缺了说明建表没成功，
没有它们两个账号能抢到同一个房号。

### 3. 起服务

```bash
sudo cp deploy/5blong-api.service deploy/5blong-peer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now 5blong-api 5blong-peer
systemctl status 5blong-api --no-pager
curl -s 127.0.0.1:8788/healthz | head
```

### 4. 放静态产物

```bash
# 在开发机上
cd /path/to/5blong
npm run build:web:pages
rsync -av --delete dist-web/ root@5blong.site:/var/www/5blong/
```

### 4b. 降噪模型（18MB，单独放，不随前端产物）

DeepFilterNet3 的 wasm 已经从安装包/前端产物里摘出去了（否则安装包多 11MB），
由用户在首次使用时点「立即下载」拉取。文件放在**前端产物之外**的目录，
因为上面那条 rsync 带 `--delete`，放站点根目录里每次发版都会被删掉。

```bash
# 1) 从依赖包里取（和客户端构建用的是同一份）
cp node_modules/denoise-voice-clarity/dist/wasm/denoise_voice_core_bg.wasm /tmp/dfn3.wasm

# 2) 传到独立目录
ssh root@5blong.site 'mkdir -p /var/www/5blong-models'
scp /tmp/dfn3.wasm root@5blong.site:/var/www/5blong-models/denoise_voice_core_bg.wasm
```

nginx 的 `/models/` 段已经写在 `deploy/nginx.conf` 里（主域和 web 子域各一份），
换文件后 `sudo nginx -t && sudo systemctl reload nginx` 即可。

验证（两个域都要通，且必须是 `application/wasm` + 带 ACAO）：

```bash
curl -sI https://5blong.site/models/denoise_voice_core_bg.wasm | grep -iE "HTTP/|content-type|content-length|access-control"
curl -sI https://web.5blong.site/models/denoise_voice_core_bg.wasm | grep -iE "HTTP/|content-type|content-length|access-control"
```

> 没有这个文件会怎样：下载对话框报 `HTTP 404`，用户点「暂不」或下载失败后，
> 客户端自动降级到 RNNoise——能正常通话，只是降噪效果回到 1.9.22 之前。


### 5. 配 nginx + 证书

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/5blong
sudo ln -sf /etc/nginx/sites-available/5blong /etc/nginx/sites-enabled/5blong
sudo rm -f /etc/nginx/sites-enabled/default

# 先签证书（此时 nginx 配置里的 ssl_certificate 还不存在，先注释掉那两行或先跑 certbot --standalone）
sudo certbot --nginx -d 5blong.site -d www.5blong.site --agree-tos -m you@example.com

sudo nginx -t && sudo systemctl reload nginx
```

> 首次签证书的顺序坑：`nginx.conf` 里已经写了证书路径，但文件还不存在 →
> `nginx -t` 会失败。两种做法（选一个）：
> 1. 先注释掉 `ssl_certificate` 两行和整个 443 server 块，只留 80，签完再加回来；
> 2. 用 `certbot certonly --standalone` 先签，再启用 443。
> 推荐 **2**，少改配置。

### 6. 验证

```bash
curl -s https://5blong.site/healthz            # 从服务器本机（nginx 只放行 127.0.0.1）
curl -s https://5blong.site/ice | head -c 200  # 未配 TURN key 会返回 501，属正常降级
curl -s https://5blong.site/api/account/me     # 应返回 {"account":null}
```

浏览器打开 `https://5blong.site`，注册一个账号，然后：

```
F12 → Network → 看 index-*.js 的耗时
```

目标：**从 3.5–7.8 秒降到 1 秒出头**。达不到就说明 EdgeOne/机房方向没兑现，别继续迁。

---

## 环境变量（`/etc/5blong/env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8788 | 接口端口 |
| `PEER_PORT` | 9000 | 信令端口 |
| `DB_PATH` | /data/5blong/app.db | SQLite 文件 |
| `PUBLIC_ORIGIN` | 空 | 对外基址，如 `https://5blong.site` |
| `COOKIE_SECURE` | 1 | 生产必须 1；本地 http 调试设 0 |
| `CF_TURN_APP_ID` | 空 | Cloudflare Realtime TURN key ID |
| `CF_TURN_API_TOKEN` | 空 | 对应 token |

`CF_TURN_*` 留空也能跑：`/ice` 返回 501，客户端会自动退回纯 STUN（现有逻辑就支持）。

---

## 备份

```bash
# 装到 cron（凌晨 3 点）
sudo crontab -u root -e
0 3 * * * /opt/5blong/server/deploy/backup.sh >> /var/log/5blong-backup.log 2>&1
```

`backup.sh` 用 `sqlite3 .backup`（在线一致性快照，**不能直接 cp**，WAL 下会拿到半个事务），
备份后跑 `integrity_check`，通过才 gzip 保留 30 天；装了 `ossutil` 且设了 `OSS_BUCKET`
就顺手传到阿里云 OSS（试用送的 20GB 正好干这个）。

---

## 客户端要改什么

| 端 | 现在 | 切换后 | 改动 |
|---|---|---|---|
| **网页** | 相对路径 `/api/account` | 同一个相对路径 | **零改动** |
| **网页静态** | `5blong.pages.dev` | `5blong.site` | 只是域名，页面里没有硬编码 |
| **桌面** | `https://5blong.pages.dev/api/account`（写死） | `https://5blong.site/api/account` | `worker-adapter.ts:42` 一行 |
| **信令** | `SIGNAL_ROUTES[0]` = `5blong.pages.dev` | `5blong.site` | `engine.ts` 一行 |

桌面端那行是硬编码的，所以**必须发版**。网页端刷新即可。

---

## 没有搬的东西（故意的）

| 东西 | 为什么没搬 |
|---|---|
| **推送提醒**（`pushInboxHint` / `pushInviteHint`） | 那是"敲一下对方收件箱"的加速通道，客户端本来就有 90 秒兜底轮询。缺了只影响红点亮得慢，不影响数据正确性 |
| **管理后台**（`/accounts-admin` 那几个服务端渲染页面） | 还没搬。重置密码 / 重置链接 / 搜索目前仍在 CF 上。**切换前必须补上**，否则你自己救不了忘密码的用户 |
| **TURN 中继** | 中继服务器是 `turn.cloudflare.com`，搬不走。只是"签发凭据"这一跳变快了 |
| **屏幕共享 SFU** | EdgeOne/ECS 都不做 WebRTC 转发，仍在 Cloudflare |

---

## 已知风险

1. **单点**。这台机器挂了，账号 + 信令一起挂。CF 是分布式的，这是搬家的固有代价。
2. **备份要自己盯**。cron 没装 = 没有备份。装完顺手 `ls /data/5blong/backup` 看一眼。
3. **3 个月试用到期**。到期前换成包月机器（¥30/月左右），别等到期才搬。
4. **`node:sqlite` 是实验特性**。API 可能在小版本变。升级 Node 前先跑 `npm run selftest`。
5. **同一时刻只能跑一个实例**。PeerJS 是内存态、SQLite 是单文件，多实例会互相看不见。

---

## 回滚

切换后发现问题：

```bash
# 1. 客户端把地址改回 pages.dev，发一版
# 2. 或者只在 nginx 层切：把 5blong.site 的解析改回 CF，旧站即刻复活
```

数据侧：旧站（D1）在切换时是**只读**状态，没删。回滚后最多丢掉切换期间新注册的那部分。
所以切换窗口选凌晨、旧站先挂维护页，能把损失压到最小。
