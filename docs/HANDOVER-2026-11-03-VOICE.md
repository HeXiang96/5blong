# 语音链路故障交接（2026-11-03 晚 · 已发 1.9.19）

> 本文只讲**今晚这一轮**：为什么"进不去房 / 听不到声音 / 后台看不到人"，
> 查到了什么、改了什么、还剩什么。后端迁移的交接见 `HANDOVER-2026-11-03.md`。

---

## 0. 一分钟速览

| 项 | 状态 |
|---|---|
| **终极根因** | **coturn `user-quota=12`**：每人凭据最多 12 条中继分配，重拨几轮打满 → 分配全被拒（30 分钟 622 次 486）→ 跨网必须中继 → 永远连不上。"重进有效" = 新凭据重置配额。已改 256/2400，**服务器侧立即对全部版本生效** |
| 次级根因 | **媒体协商只有一条命**（PeerJS 单次投递）→ 1.9.19 起房主↔访客改走数据通道自建协商 |
| 1.9.19 的新坑 | 自建协商三处时序缺陷：僵尸链路吞 offer、迟到的 failed 覆盖已连接、异常静默——表现"进房后重连一两分钟"。**1.9.20 已修**（另含单通不再拆腿、防递归护栏） |
| 已验证排除 | 端口屏蔽（3478/5349 TCP 全通）、中继不可用（完整收发 80 包 0 丢包）、NAT 玄学、版本混用（双方同版本全新实例仍复现 → 代码真 bug） |
| 客户端 | **1.9.20 已发**（=1.9.19 全部 + 协商四补丁 + 判死优化 + 防递归） |
| 服务端 | 自建信令（`signal.mjs`→9001，nginx 已切）+ 消息追踪（临时）+ 配额 256，均已生效 |

---

## 1. 架构现状（三层，务必分清）

```
第 1 层  信令服务器（谁在哪个房、把 OFFER/ANSWER 转给谁）
         ✅ 自建：server/src/signal.mjs
                   systemd 5blong-signal-node，绑 127.0.0.1:9001
                   nginx /peerjs → 127.0.0.1:9001
         入口仍是 wss://5blong.site/peerjs（客户端零改动）

第 2 层  数据通道（两人之间的可靠管道）
         ❌ 仍是 peerjs 的 DataConnection
         承载：hello 握手 / 名册下发 / 成员广播 / 聊天 / 心跳(2s)
               我们的 rtc-* 协商消息 / 屏幕共享控制

第 3 层  媒体协商（SDP/ICE 怎么交换）
         房主 ↔ 访客   ✅ 自建：src/client/voice/media-link.ts（1.9.19）
         访客 ↔ 访客   ⚠️ 仍走 PeerJS call/answer（信令单次投递）
```

**拓扑是 mesh**：N 人房 = N(N-1)/2 条腿，上限 `MAX_MEMBERS = 13`（含房主）。
6 人房 = 5 条走自建协商 + 10 条走 PeerJS；13 人房 = 12 + 66。

**"自建协商"≠"自建数据通道"**：前者只是借用 peerjs 的 `send()` 传 SDP，
建连/心跳/重连/名册路由都还是 peerjs 管的。要摘掉 peerjs 库得接管第 2 层（见第 5 节）。

---

## 2. 今天查出来的真问题（每条都有现场证据）

### 2.1 信令侧

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| 1 | 公共云兜底 = 三无用户 | 702621：全站访问日志 **0 命中**，面板查无此房，但房主界面一切正常 | 删掉兜底，只留自建线路（连不上就明确报错） |
| 2 | `alive_timeout` 60s 与后台心跳踩线 | 同一房号 25 分钟注册 **6 次**（15:00→15:10→15:11→15:14→15:17→15:24） | 服务端 60s → **180s** |
| 3 | 访客 1~2 秒内连拨三次就判死 | "房主不在线"出现得太快，房主正在重连也等不到 | 重拨间隔 1.2s / 3s |
| 4 | 房主信令掉线自己不知道 | 业主原话"我明明建了房" | `peer.on("disconnected")` 时给自己弹提示 |
| 5 | `reconnect()` 后重复挂监听 | 每重连一次 connection/call/disconnected 监听翻倍 | 用一次性标志位守卫 |
| 6 | 断开时 `client.getId()` 取不到 | 面板一直显示已关掉的房号（幽灵房） | WeakMap 记住 client→id |

### 2.2 媒体协商侧（核心）

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| 7 | **协商只有一条命** | 信令日志：每条 OFFER 都在 **100~120ms** 内拿到 ANSWER，候选齐全（host/srflx/**relay**），但连接仍停在 `new` | `media-link.ts`：SDP/ICE 走数据通道 + answer 超时重发 |
| 8 | 凭据晚到用不上 | coturn 日志：兰州出口只有**无凭据 STUN 探测**，**0 次带凭据分配**；`/ice` 18:08 才 200 | `onIceUpgrade`：凭据从无到有时拆腿重拨 |
| 9 | 兜底补拨绕过发起方向 | Bink ↔ 爱睡的锦鲤 **两边都 `new`**，而同一人对第三人正常 | `ensureCalls` / `onIceUpgrade` 加 `shouldCall` 判断 |
| 10 | 死链不被拆 | 判死链整段套在 `if (mediaAt)` 里，而 `lastMediaAt` 会先被清 | 用 `isCallDead()`，不再依赖 `lastMediaAt` |
| 11 | 重连后自愈计数不清零 | 断网 20 秒烧完 3 次机会；重连回来的人**从没离开名册**，走不到任何清零路径 | `resetLinkRetries()` |
| 12 | 手动「重新连接」固定 relay-only | 本端没有 TURN 时收集到 **0 个候选**，点多少次都不可能通 | 先中继，6 秒不通回落直连 |

### 2.3 后台与上报

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| 13 | 成员明细只在会话结束写库 | 卡片显示"2 人"，点开永远"暂无成员明细" | `persistMembers()` 每轮快照写一次 |
| 14 | 上报被信令守卫拦住 | 房主出口当晚调了 **1175 次 API**（每 30 秒续号成功），`/api/rooms/snapshot` **0 条** | 去掉 `peer.socket` 守卫 |
| 15 | 上报定时器死了没人知道 | 663332 停了 **25 分钟**，信令还在线 | 心跳每 2 秒检查、超 10 秒补发 |
| 16 | 上报器压根没启动 | 444333 建了房，`rooms` 表一条都没有 | `hosting && code && !roomTelemetry` 时自动重建 |
| 17 | 版本号取错 | 1.9.17 被报成 1.9.16（`latestChangelog()` 跳过无公告版本） | `currentVersion()` = CHANGELOG 首条 |

### 2.3b 1.9.19 实测的三个新缺陷（自建协商首日，1.9.20 修复）

诊断与复现条件：**双方同版本 1.9.19、全新实例、新房号**——排除版本混用与残留，
代码真 bug。表现："进房后与房主显示重连中一两分钟"，实际链路 ~20s 已通
（诊断铁证：`pk=20` 与 `link=failed` 并存）。

| # | 缺陷 | 修法 |
|---|---|---|
| a | **僵尸链路吞 offer**：任何 `rtc-*` 都会建链且角色按消息类型临时判，一条迟到的 `rtc-bye` 造出 closed/无 PC 的僵尸留在表里，后续 offer 被 `handle` 的 closed 守卫全部吞掉，answer 永远不来、零痕迹（Bink 诊断里 `via:datachannel` + `pc 全空` 即它） | 只对 `rtc-offer` 建链；非 offer 无现成链路直接丢弃；offer 到达时僵尸删除重建 |
| b | **迟到的 failed 覆盖已连接**：自建腿超时判 failed 无条件写状态，哪怕回落 PeerJS 腿已连上 | 已连接不覆盖，只记事件 |
| c | **异常静默**：`handle` 的 catch 吞掉一切，answer 生成失败零痕迹 | `onEvent` 回调上报，写进诊断 `events` |
| d | **单通拆腿循环**：ICE 通 14 秒无音频包（真单通）→ 拆腿重拨 → 治不了单通只制造"断开→重连→又断"循环 | 保持连接 + 3 秒低频复查，包来即转成功 |
| e | **无限递归隐患**：回落 PeerJS 未先标记 `dcFallback` | 回落前先标记 |

注意：`usedtx=0`（audio-profile.ts 明确禁用 DTX，静默期照样发包）——
"双方都没说话"**不会**导致 0 包；0 包 = 媒体真没流动。别再用"没人说话"解释 0 包。

### 2.4 屏幕共享（同一天的另一个 bug）

| # | 问题 | 修法 |
|---|---|---|
| 18 | 健康呼叫每 12 秒被判僵尸拆掉重建 → 观众端"黑一下→有画面→又黑一下" | `isZombieScreenCall(startedAt, now, connected)`：连上就不算僵尸 |
| 19 | 档位记忆永久固化 30fps（爬回满帧要 18 秒，而呼叫 12 秒就被杀） | 记忆加 10 分钟过期 + 不再每次新建就写回 |

---

## 3. 已上线（服务端，**不需要发版**）

| 改动 | 位置 | 回滚 |
|---|---|---|
| 自建信令服务 | `server/src/signal.mjs` + `signal-main.mjs` + systemd `5blong-signal-node` | `systemctl stop 5blong-signal-node` |
| nginx `/peerjs` → 9001 | `/etc/nginx/snippets/5blong-proxy.conf:93` | 改回 9000 + `systemctl reload nginx`（**10 秒**） |
| OFFER 暂存 2.5 秒重投 | `signal.mjs` | —— |
| `ROOM-SNAPSHOT` 走信令 | `signal.mjs` → 转交 `/api/rooms/snapshot` | —— |
| 判死 60s → 180s | `server/src/peer.mjs`（老服务仍在线） | 改回 60000 |
| 后台面板整套移植 | `server/src/admin.mjs`（卡片 + 成员明细 + 每日汇总 + 自动刷新） | —— |
| 成员在线落库 | `server/src/rooms.mjs`（`persistMembers`） | —— |
| 信令侧观测 | 快照文件 `/data/5blong/live-rooms.json`，每 20 秒重写 | —— |
| coturn verbose | `/etc/turnserver.conf`（**临时**，诊断完撤） | 删掉 `verbose` 行 + 重启 |

---

## 4. 已发版（客户端）

### 1.9.20（深夜，最新）

= 1.9.19 全部 + 自建协商四补丁（上表 a~d）+ 防递归（e）+ 判死优化 + 判定事件日志。
**验证方法**：更新后进房，若自建协商仍失败，诊断 `events` 里会有每一步失败原因
（offer 发出/Bink 收到/answer 生成/发回），不再靠推理。

**四版本速查**：`1.9.17` 重连/黑闪/档位记忆/采集读数 → `1.9.18` 凭据自愈/重拨间隔/
掉线提示/跨线路重试 → `1.9.19` 自建协商/ICE 探针/上报走信令/抢答护栏/删兜底 →
`1.9.20` 协商四补丁/判死优化/防递归。

### 1.9.17（上午）

- 断线重连后互相听不到：`resetLinkRetries`（重连清零自愈计数）/ 死链一律拆
  （不再被 `lastMediaAt` 缺失短路）/ 手动重连先中继 6 秒回落直连
- 屏幕共享每 12 秒黑闪：`isZombieScreenCall(startedAt, now, connected)`
- 档位记忆 10 分钟过期（不再被固化在 30fps）
- 共享者灯箱**采集侧读数**：没人在看时显示 `[采集] 1920×1080 · 60 fps`
  （以前发送端数据只在有观众时才存在），取发送连接的轮询不再 12 秒后放弃
- 测试基建：`engine-join-handshake.test.ts` 固定 `sleep` 全改 `waitFor(条件)`
  轮询（慢机器/并行不再假失败）

### 1.9.18（傍晚）

- 凭据晚到自愈 `onIceUpgrade`（等凭据上限维持 2.5s——业主口径，自愈兜底）
- 访客重拨留间隔 1.2s / 3s（原来 1~2 秒连拨三次就判死）
- 房主信令掉线时自己看到提示（"这期间别人进不来"）
- `reconnect()` 后重复挂监听修复（每重连一次监听翻倍）
- 跨线路重试：`routeAt(start, attempt)` 从任意线路起步（当时为"两张注册表"而做）

### 1.9.19

`npm run bump -- 1.9.19` → commit `2ef6540` → tag `app-v1.9.19`

内容：

1. **自建媒体协商**（`media-link.ts`）：房主↔访客这条腿自己建 PC、SDP 走数据通道、answer 超时重发；失败自动回落 PeerJS；开关 `localStorage["5blong:dc-media"]="off"`
2. **ICE 探针**：诊断包每条腿带 `gathering` + `pairs { total, succeeded, failed, inProgress, waiting, frozen, relayPairs }`
3. **上报走信令** + 心跳驱动 + 上报器自愈
4. **抢答护栏**（`shouldCall`）
5. **删公共云兜底**
6. 版本号修正（`currentVersion`）

---

## 5. 还没做（按优先级）

| 优先 | 事项 | 说明 |
|---|---|---|
| P0 | **用 events 定案 answer 缺失** | 1.9.20 的判定事件日志上线后，复现一次进房，读 `events` 里自建协商每一步——确认僵尸机制还是另有原因（如 Bink 端 answerTo 抛错的具体点） |
| P1 | **信令可靠中转补全** | `ANSWER` / `CANDIDATE` 目标不在时也应暂存补投（现在只有 `OFFER`）。只动服务端，覆盖访客↔访客那 66 条腿 |
| P2 | **自建数据通道**（第 2 层） | 自己 `createDataChannel` 接管 hello/名册/心跳/聊天/屏幕共享控制；服务端要双栈兼容老客户端。**几周的量** |
| P3 | TURN 上 443（SNI 分流） | 只放行 443 的网络才需要；当前实测可达 |
| P3 | 撤掉 `signal-trace.log` 与信令 trace 钩子 | 临时诊断，定性完即删 |
| P3 | 心跳体验（8 秒标灰 / 20 秒移除） | 业主明确说"心跳先不改"，别擅自做 |
| P3 | 中继丢包优化 | 实测跨网 relay 丢包 ~8%（理想 1~3%），听感差再说 |

---

## 6. 排障工具箱（复制即用）

### 6.1 信令在线情况

```bash
ssh root@5blong.site "curl -s http://127.0.0.1:9001/health"
# → {"ok":true,"clients":N,"rooms":N,"snapshots":N,"pending":N}
# rooms = 5b-h-* 的个数；如果某房号在线但库里有没数据 → 客户端没上报
```

### 6.2 房间与成员（读库）

```bash
ssh root@5blong.site 'cd /opt/5blong/server && node -e "
const {DatabaseSync}=require(\"node:sqlite\");
const db=new DatabaseSync(\"/data/5blong/app.db\",{readOnly:true});
console.log(JSON.stringify(db.prepare(\"select id,members,version,last_seen from rooms\").all()));
const s=db.prepare(\"select id,code from room_sessions order by rowid desc limit 1\").get();
if(s) console.log(JSON.stringify(db.prepare(\"select name,left_at,link,rtt_avg_ms,reconnects from room_members where session_id=?\").all(s.id)));
"'
```

### 6.3 谁在用中继、有没有真实音频

```bash
ssh root@5blong.site "journalctl -u coturn --since '-10min' --no-pager | grep -E 'session .*: usage' | tail -10"
# 判读：rb/sb 只有 140~300 字节 = 只保活，音频没走中继
#       rb/sb 上万字节 = 真实音频在跑
```

### 6.4 信令消息追踪（临时）

```bash
ssh root@5blong.site "tail -30 /data/5blong/signal-trace.log"
# 格式：2026-11-03T13:15:09.123Z OFFER 5b-g-xxx -> 5b-h-663332 kind=media
# 注意：文件里的时间是 UTC，+8 才是北京时间
```

判读表：

| 看到 | 结论 |
|---|---|
| 有 `OFFER` 无 `ANSWER` | 对方收到没回 → 客户端问题 |
| 连 `OFFER` 都没有 | 发起方没发 → 客户端问题 |
| 出现 `EXPIRE` | 目标不在注册表（或暂存 2.5s 后仍不在） |
| `CANDIDATE typ=relay` 存在 | 中继候选有收集到（不代表被选中） |

### 6.5 诊断包（最有用的一手数据）

**在房间里**：设置 → 意见反馈 → 随便写一句 → 提交。诊断包自动附上，读法：

```bash
ssh root@5blong.site 'cd /opt/5blong/server && node -e "
const {DatabaseSync}=require(\"node:sqlite\");
const db=new DatabaseSync(\"/data/5blong/app.db\",{readOnly:true});
const r=db.prepare(\"select created_at,platform,context_json from feedback order by created_at desc limit 1\").get();
const d=JSON.parse(JSON.parse(r.context_json||\"{}\").diag||\"{}\");
console.log(r.created_at, d.app&&d.app.version);
console.log(JSON.stringify(d.peers,null,1));
"'
```

**`pairs` 判读（1.9.19 起）**：

| pairs | 含义 | 修法方向 |
|---|---|---|
| `total: 0` | 候选没交换成功 | 我们的 bug（协商层） |
| `total > 0` 且全 `failed` | 路径确实不通 | relay / 443 |
| `succeeded > 0` | 通了 | 若还没声音，查解码/播放 |

**`iceConnectionState` 判读**：

| 值 | 含义 |
|---|---|
| `new` | **对方描述从未到达**（offer 或 answer 丢了）—— 不是网络问题 |
| `checking` | 在打洞，需要时间；被 9 秒看门狗拆掉是误杀 |
| `connected` | 通了 |
| `failed` | 候选对全废 |

---

## 7. 踩过的坑（今天新增，逐条都是真金白银）

1. **不要用"nginx 访问日志搜不到"来判断"没连过我们服务器"**。
   nginx 对 WebSocket **只在连接关闭那一刻才写日志**，一条正开着的长连接本来就不存在。
   702621 就是被这个推论带偏的。
2. **`5b-h-<房号>` 的 101 记录不能证明"房主网络差"**。
   业主反复进出、客户端重连都会产生同样的记录。我据此下过结论，是错的。
3. **`/tmp` 不可用**：服务被 systemd `PrivateTmp=true` 关在自己的私有 /tmp 里，
   外面看不见。跨进程共享文件用 `/data/5blong/`。
4. **Python 改文件会吃掉行尾**：仓库是混合行尾（CRLF/LF 都有），
   用 `io.open(..., newline="")` 读、按原样写回；整文件动行尾会让 diff 虚胖几千行。
5. **`onIncomingCall` 里"已有连接就拒绝"会挡住自愈**：
   必须放行"旧连接已死"的来呼，否则对方重拨永远进不来。
6. **同一个 `Peer` 对象可能进入"能发数据、但新呼叫的 answer 回不来"的状态**，
   退出重进（换新 peer id + 新 Peer 对象）能好。这是"重进几次就好了"的机制解释。
7. **`git tag` 必须在 rebase 之后重打**（`git tag -f`），否则 CI 按旧提交构建。
   今天又踩了一次。
8. **推送要用代理**：`GIT_CONFIG_VALUE_0="http://127.0.0.1:7890"`；
   代理没开时报 `Failed to connect to github.com:443 over proxy`。

---

## 8. 关键文件地图

| 文件 | 作用 |
|---|---|
| `src/client/voice/engine.ts` | 引擎主体（进房/名册/呼叫/自愈/遥测/诊断），改动最多 |
| `src/client/voice/media-link.ts` | **自建媒体协商**（1.9.19 新增）：offer/answer/候选走数据通道 |
| `src/client/voice/signal-routes.ts` | 信令线路（现在只有一条：`5blong.site`） |
| `src/client/voice/ice.ts` | ICE 凭据获取 + 缓存 + `onIceUpgrade` 订阅 |
| `src/client/voice/protocol.ts` | 消息协议、`MAX_MEMBERS=13`、`isRoomCode` |
| `src/client/voice/screen-share.ts` | 屏幕采集/编码/降档/接收端抖动缓冲 |
| `server/src/signal.mjs` | **自建信令服务**（PeerJS 协议兼容，Node 版） |
| `server/src/peer.mjs` | 老的 npm `peer` 包服务（仍在线，作为回滚目标） |
| `server/src/rooms.mjs` | 房间遥测入库（`persistMembers`） |
| `server/src/admin.mjs` | 后台页面（`/rooms` 卡片面板） |
| `worker/signal/index.js` | CF 时代的 `SignalHub`（`signal.mjs` 的移植来源） |

---

## 9. 今天的时间线（关键节点）

```
上午   迁移后遗症：断线重连互相听不到（自愈计数不清零）、共享屏幕每 12 秒黑闪、
       偶发单测改 waitFor → 修，发 1.9.17
傍晚   凭据晚到自愈（coturn 实锤：兰州只有 STUN 探测、0 次带凭据分配）→ 发 1.9.18
下午   屏幕共享每 12 秒黑闪（僵尸判据）→ 修；档位记忆固化 30fps → 加 10 分钟过期
傍晚   业主朋友进不了房：先怀疑 NAT → 后证实是信令注册表（公共云兜底）
       coturn 实锤：兰州只有 STUN 探测、0 次带凭据分配 → 凭据晚到自愈
晚上   后台空白：成员只在收尾落库 + 上报被 socket 守卫拦住 + 定时器静默死
       21:36 自建信令服务切上线（9001），验证 5 项协议行为全过
       21:50 定性"协商只有一条命"，写 media-link.ts + ICE 探针
       22:00 删公共云兜底，发 1.9.19
       22:10 ★ coturn verbose 实锤 user-quota=12（30 分钟 622 次 486）→ 改 256
       22:12 配额修复立竿见影：relay 候选 1→22、486=0、重拨循环停止
       22:20 1.9.19 实测新问题"进房重连一两分钟"（链路 20s 已通但状态卡死）
       22:47 定性僵尸链路吞 offer + 状态覆盖 + 异常静默 → 发 1.9.20
```

---

## 10. 接手第一步该做什么

1. `npm run check` 跑一遍（应 397 项全绿），确认工作区干净；
2. 让业主和朋友都更到 **1.9.19**，复现一次"连不上"的组合；
3. 让他们**在房间里**提交一次反馈，读 `pairs` —— 这是区分"消息问题"和"路径问题"的唯一硬数据；
4. 若 `total: 0` → 继续修协商层（第 5 节 P0 的信令可靠中转）；
   若全 `failed` → 走 relay / 443 那条线；
   若 `succeeded > 0` 却没声音 → 查解码与播放，别再动协商。
