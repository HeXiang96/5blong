# 5blong

低延迟语音为核心的临时沟通工具。无需注册账号、无需选择服务器，**创建房间、复制邀请链接**即可开聊，适合朋友、团队和临时群组。

- 公网地址（任何网络可开）：<https://5blong.pages.dev>
- 源码仓库：<https://github.com/HeXiang96/5blong>
- 单房建议 2–6 人，最多 13 人（12 位访客 + 房主）；音频在参与者之间点对点（P2P）直连。
- **屏幕共享（围炉看投影）**：传输方式默认**自动**（**观众 ≤4 走 P2P 直连、5 位观众及以上  
  自动切 Cloudflare Realtime SFU 转发**，免费额度），全房同看一块大幕布，与语音链路物理隔离；  
  **可带系统声音**（观众点幕布开音量）。部分播放设备（7.1/虚拟声卡）会让浏览器拿不到系统  
  音频——桌面客户端内置 WASAPI 采集不受限；网页版会提示改用客户端或换成立体声设备。  
  详见归档文档 [SCREENSHARE-PLAN.md](./docs/archive/SCREENSHARE-PLAN.md)（设计）与 [SCREENSHARE-OPT-PLAN.md](./docs/archive/SCREENSHARE-OPT-PLAN.md)（优化决策记录）。
- 全程 0 成本：信令用免费公共 PeerJS 云，NAT 穿透用免费公共 STUN +  
  **Cloudflare Realtime TURN**（服务端 `/ice` 现签短期凭据，1000 GB/月免费额度），不需要任何付费服务。

> **✅ 前述缺陷已修复（2026-10-12）**：此前"访客用邀请链接能进房并看到房主，  
> 但房主看不到访客、访客约 12 秒后被断开"的问题，根因是 `onGuestData()` 里  
> `joined` 守卫顺序的死循环（catch-22），已修复并补充回归测试。
>
> **✅ 多人加入超时已修复（2026-10-12）**：针对"第 3、第 4 个人进不去、  
> 报房主没有响应"——welcome 超时改为自动整体重拨（最多 3 次）、访客间媒体  
> 协商错峰消除信令风暴、被呼应答改用处理后的发送流。线上 4 人顺序加入实测  
> 均在 5 秒内完成。
>
> 修复记录见 [KNOWN-ISSUES.md](./docs/archive/KNOWN-ISSUES.md)（已归档）顶部。

---

## 房间内「梗王对局」1v1（2026-11-04 · 1.9.26）

房间里的回合制卡牌对战：点对方的猪 → 成员卡「梗王对局」→ 对方接受 → 房间略暗、
双方开打，**语音全程不断**（边打牌边骂是这功能唯一值钱的地方）。规则是炉石式：
每回合法力 +1、随从站场、嘲讽/战吼/封号、30 血疲劳兜底；卡池是大东彦（爆发）
与 Renai（续航）两套 14 张等预算牌组，全部原梗可考。

### 架构：ECS HTTP 信使（方案 A），语音链路零接触

- **不改 `protocol.ts`，不改 `engine.ts`**。决定性原因：房间是星型拓扑
  （engine.ts 只有 handleHostMessage / handleGuestMessage 两个方向），
  **两个访客之间没有 DataConnection**——复用连接就得改房主转发链路，风险最高。
- 服务端 [server/src/duel.mjs](./server/src/duel.mjs) 只做收发不懂规则：
  `/api/duel/invite|poll|leave`，`duel_sessions` 一张表（随服务启动自动建）。
  房主跑引擎上传快照（version 单调），访客上传「意图」，双方 1.2s 轮询（出牌瞬间加速一轮）。
- **房间隔离（冒烟测试第 8 段真实跑过）**：覆盖层只在本机渲染，ab 打牌 cde 界面
  完全不变暗；语音走独立 MediaConnection，与对局物理隔离；ab 对战中 cd 可以再开
  一局互不干扰（busy 只挡已在局里的人）。
- **退出通知**：任一方点「退出对局」→ 服务端记 left 标记，对方下一轮轮询立刻收掉
  （人还在房间里也一样）；直接关页面 → 15 秒心跳判掉线。
- **快照版本保护**：`DUEL_SCHEMA_VERSION` 不一致时访客看到「版本不一致」安全退出，
  不渲染鬼状态。

### 模块化（改游戏看 [src/client/duel/README.md](./src/client/duel/README.md)）

依赖单向：**数据(duel-cards) ← 规则(duel-engine) ← 网络(duel-net) ← 界面(DuelOverlay/duel.css)**。
加卡/改数值只动 duel-cards.ts（字段示例在模块 README 里）；换联调方式只动 duel-net.ts
（实现一个新的三方法 Transport）；单卡特效写在卡的 `cast` 闭包里，全卡通用能力才进引擎。

### 联调挖出的三个真 bug（双标签页实测暴露）

1. **同浏览器两标签页共享 localStorage → 同一个 clientId** → 访客被识别成房主，
   邀请永远收不到、界面显示成发起人视角。修：clientId 改 **sessionStorage**（每标签页独立）。
2. **sessionRef 从不与 state 同步** → 轮询永远不带 gameId → 房主快照传不上去、
   访客动作发不回来（邀请阶段看不出来，一开局必死）。修：applySession() 同时动两处。
3. **心跳时间戳初始 0 被算成"掉线几十年"** → 刚发邀请就提示对方掉线。
   修：seen=0 不算掉线（服务端与本地同口径）。

### 测试与上线

- 引擎单测 + 网络状态机单测（LocalDuelTransport 的信箱就是 localStorage，
  两个实例=两个玩家）；全库 **420/420** 过；服务端冒烟 **24/24**（`server/scripts/duel-smoke.mjs`）。
- 上线顺序：`server/` 传 ECS 重启 `5blong-api`（表自动建）→ 前端随 bump 走 CI。
  生产冒烟：`BASE=https://5blong.site node server/scripts/duel-smoke.mjs`。
### 已知待修（2026-11-04 实测；第 1、2 条已在 1.9.26 修完）

1. **对局等待层"几秒消失"假象**：客户端把服务端 404/500 吞成"没有对局"直接清掉
   等待层——ECS 部署 `/api/duel` 之前实测：点了邀请没反应、等待层闪没、对方收不到、
   全程无提示。修法：poll 非 200 直接抛错，保留会话退避重试并弹「对局服务暂时不可用」。
   （服务端已排除：24 项冒烟打生产全绿。）
2. ~~**降噪模型从安装包摘出**~~ **（2026-11-04 已改完，只差服务器放文件）**：
   `?url` 导入让 18MB 的 DFN3 wasm 打进了产物（7.16→16.63MB 的主因，**不是**对局功能的体积）。
   现在构建期由 vite 插件把库里的 `new URL(…, import.meta.url)` 改写成哨兵
   `__dfn_model__.wasm`，`ns-deepfilter.ts` 拦截 fetch、从 Cache Storage 喂字节：
   **dist-web 从 24MB 降到 5.7MB**；模型只在用户点「立即下载」时才从
   `https://5blong.site/models/denoise_voice_core_bg.wasm` 拉，没下就自动用 RNNoise。
   上线还差一步（服务器侧）：把
   `node_modules/denoise-voice-clarity/dist/wasm/denoise_voice_core_bg.wasm`
   放到 `/var/www/5blong/models/`，nginx 给它加 `Access-Control-Allow-Origin: *`
   （桌面端是跨域取，缺这个头会一直降级到 RNNoise）。
3. 对战特效（方案已定：快照里的战斗日志带 dmg/heal 分类、两端天然同步，挂 CSS 动画即可）。

---

## AI 智能降噪升级 + 语音"重连中"根治（2026-11-04 · 1.9.22 / 1.9.23）

### 语音重连问题（1.9.22 已发）：三个叠加的真 bug

"进房后卡「重连中/连接失败」"其实声音多半是通的——诊断包实锤（ICE connected、
音频在流、状态却写 failed）。三个根因全部修复：

1. **护栏失效**：1.9.20 的"迟到的失败不覆盖已连接"只护了 `"connected"` 一种值，
   而 PeerJS 腿写入的健康值是 `"direct"/"relay"`——护栏从未真正生效。已扩围。
2. **凭据晚到拆健康腿**：`/ice` 中继凭据进房 1~2.5 秒才到，`onIceUpgrade`
   无差别拆掉所有腿重拨（"连上→1 秒后重连中"的闪断）。已改为只拆未连通的腿。
3. **补拨巡检搅死自建协商**：`ensureCalls`（每 3 秒）不认识自建协商腿，
   反复对正在握手的腿重复发起 → 每次 18 秒超时被迫回落 PeerJS（信令 trace
   实锤回落精确在 +20 秒）。已修复；失败路径全部埋点进诊断包 `events`。
4. **房主关房广播 `room-closed`**：访客立刻退房，不再看 30 秒心跳超时 + 重拨。
5. **后台幽灵成员**：离开成员误用 peerId 当 key（一人两行）已修；快照带
   `ended:true` 让后台**立即**收尾（不再等 90~150 秒清扫）；在线卡片按人折叠
   历史行。

### AI 降噪升级（1.9.23）：RNNoise（2018）→ DeepFilterNet3（2023）

- **实测选型**：Node 里直接跑真模型对比——DFN3 稳态噪声抑制 **25.8 dB**、
  人声损耗 **1.6 dB**；RNNoise 对键盘/零食袋这类瞬态脉冲声天然乏力。
- **引擎**：`denoise-voice-clarity`（MIT，DFN3 权重烧在 18MB wasm 里，全程本机处理）。
  **wasm 不进安装包**（2026-11-04 起）：构建期改成运行时哨兵，用户点「立即下载」才
  从 `/models/denoise_voice_core_bg.wasm` 拉，缓存在 Cache Storage；没下载就降级 RNNoise。
  废案：`@lofcz/deepfilternet-web`（实测权重损坏输出全零）。
- **三级降级**：DFN3 → RNNoise → 直通，任何故障不挡通话。
- **首次使用**：弹下载对话框（Portal 挂 body 最外层 + z-index 顶格，不会被任何
  页面 UI 吞掉），进度条/重试/暂不；Cache Storage 登记，**下载一次永久有效**；
  点"暂不"也能正常进房（自动退回老模型）。降噪默认开启，用户零配置。
- **模型闸门测试**：`tests/deepfilter-model.test.ts` 在 Node 里直接跑真 wasm，
  四组断言（噪声抑制 >15dB / 人声损耗 <3dB / 键盘脉冲 >10dB / 语音+噪声混合
  信噪比改善 >6dB / 纯静音不注入底噪）——模型换版/构建坏了这里直接爆。
- **衰减限幅 = 24dB（多角度实测挖出的关键参数）**：引擎初始化限幅若无限制
  （100dB），模型一旦误判会把人声压掉 50dB+（实测）。限幅 24dB 下：
  类真实语音损 2.0dB / 白噪声压 19.5dB / 粉噪声 20.1dB / 键盘脉冲 18.4dB /
  语音+噪声混合信噪比改善 9.6dB（15.3→24.9dB）。
- **RTT 采样补自建协商腿**：房主↔访客的媒体走自建协商后，遥测的 RTT 列
  一直"采样中"——采样代码只看 PeerJS 呼叫。现在两条腿都看。
- **实测背书**：房间 078306（5 人，1.9.22）自建协商 8 次应答全部成功、零回落；
  ECS 服务端同日已部署（关房立即收尾 + 后台成员去重），方式为手动 scp +
  `systemctl restart 5blong-api`。

### 运维注意（2026-11-04）

- **5blong.pages.dev 的 worker 已被替换为"迁移提示页"**（业主安排，新站不再
  使用 CF worker；release.yml 已停发 Pages）。完整版 worker 存档于
  [worker/pages-migration-snapshot.20261104.js](./worker/pages-migration-snapshot.20261104.js)。
- **服务端（ECS 5blong.site）与客户端（5blong.site 自托管）是当前唯一线上**：
  部署方式见下节与 [docs/SERVER.md](./docs/SERVER.md)、
  [docs/VOICE.md](./docs/VOICE.md)。
- 房间 078306（5 人）实测：自建协商 8 次应答全部成功、零回落——1.9.19 以来
  "每次必 20 秒回落"已成为历史。

---

## 下载与版本显示（2026-11-03 · 1.9.16）：网页走加速、客户端走直连

> 这一轮的完整实测矩阵与坑，见 [SERVER.md](./docs/SERVER.md)（含下载分流那一轮的实测）。

**结论一句话**：阿里云 GA 全球加速的 IP 只对浏览器系 TLS 栈友好——网页端（BoringSSL）
和 Node/OpenSSL 能连（15~38MB/s），而客户端 updater 用的 rustls、系统 schannel 都连不上。
所以把下载拆成两条路，谁也不拖累谁：

| 通道 | 清单 | 下载地址 | 谁在用 |
|---|---|---|---|
| 客户端自动更新 | `/desktop/latest.json` | 主域直连 | 任何版本的桌面客户端 |
| 介绍页「下载安装包」 | `/desktop/latest-web.json` | `dl.5blong.site` 加速 | 浏览器（0.4 秒下完） |

- 两份清单都由 `sync-desktop.mjs` 生成，`DL_BASE` 环境变量控制加速那一份。
- 介绍页有「下载慢？换直连」的小字退路；`dl` 一旦抽风，用户不至于卡死。
- 别把两份清单合成一份、也别用 curl/浏览器的结果代替客户端验证——
  1.9.14→1.9.15 期间的全员更新失败就是这么来的（详见 HANDOVER 13.5）。

**版本号显示**：介绍页页脚（读清单）、应用首页字标旁徽章（桌面端 Tauri API /
网页端构建时注入 `__APP_VERSION__`）。发版后自动更新，不用手改。

**更新公告弹窗重做**：四条要点、品牌图标、跟随场景主题（雪原/万圣夜/春节补了面板配色）。

---
## 自托管后端迁移（2026-11-03）：语音账号服务已搬离 Cloudflare

> **给后续维护者（含 AI）**：这一轮把后端从 Cloudflare 搬到了一台**自有的香港 ECS**，
> 全程零停机（新旧两套并行）。完整交接记录（给接手的 AI 读）：
> [SERVER.md](./docs/SERVER.md)。

### 为什么搬（实测数据，不是猜测）

- `5blong.pages.dev` 这条线路被 Cloudflare 路由到**洛杉矶**（`colo=LAX`、`loc=CN`）。
  抽样 85 个 CF IP，29 个有响应，**没有一个落在亚洲** —— 所谓"CF 优选"对这条线路无解。
- 到香港 20–41ms，到 CF 154–220ms；主包 654KB 实测 3.5–7.8 秒，迁后 **0.3–0.6 秒**。
- `/ice`（中继凭据）跨境时 8 次里 1 次超 6 秒，而客户端只等 2.5 秒 ——
  超时退回纯 STUN，打洞失败就没有中继可用，这就是"两个人都显示已连接却互相听不到"的上游成因之一。

### 现在的架构

```
5blong.site（香港 ECS，2核2G）
  ├─ 静态站（nginx 直出，/assets/* 长缓存）
  ├─ 账号/好友/邀请接口（Node 22 + node:sqlite，server/）
  ├─ 房间遥测（POST /api/rooms/snapshot）
  ├─ 开黑圈（/game/entitle、/game/verify、/game-admin）
  ├─ 屏幕共享代理（/sfu → Cloudflare Realtime，密钥只在服务端）
  ├─ 信令（PeerJS，server/src/peer.mjs）
  ├─ 收件箱推送（/peerjs/inbox，WebSocket，好友/邀请红点）
  ├─ TURN/STUN 中继（coturn，3478/5349 + 50000-50999）
  └─ SQLite（/data/5blong/app.db，WAL，每天 03:00 备份）
```

仍在 Cloudflare 的只剩两样：**屏幕共享的 SFU 服务本体**（入口已在我们这），以及
**旧客户端还在连的 pages.dev**（切完版本就能下线）。语音 64kbps 高音质已上线（未发版）。

### 部署与运维

- 服务器：香港 ECS，域名 `5blong.site`（未备案，走"全球不含中国大陆"线路）。
- 部署目录 `/opt/5blong/server`，静态产物 `/var/www/5blong`，数据库 `/data/5blong/app.db`。
- 令牌与密钥全在服务器 `/etc/5blong/env`（后台令牌、TURN 密钥、SFU 密钥），**仓库里没有**。
- 自检：`node /opt/5blong/server/scripts/turn-check.mjs`（中继完整分配测试，
  能同时验证 UDP 可达 / 凭据签名 / external-ip / 端口段四件事）。
- 桌面端更新源已双通道：`5blong.site` 优先、GitHub Releases 兜底
  （`/desktop/latest.json` + exe 已同步一份到 ECS）。

### ⚠️⚠️ 发版必检：server 端永远不在 CI 里（2026-11-04 血泪教训）

CI（release.yml）只发**网页 + 桌面安装包**。**`server/src`、`server/db/schema.sql`
永远不会跟着 Release 走** —— 每次改了服务端代码，必须手动部署，一次都不能漏：

```bash
# 1) 推 server 代码与表结构（src 全量覆盖最稳）
scp -i .deploy_key 5blong/server/src/*.mjs  root@8.210.198.140:/opt/5blong/server/src/
scp -i .deploy_key 5blong/server/db/schema.sql root@8.210.198.140:/opt/5blong/server/db/
# 2) 建表/迁移（幂等，重复跑没副作用）
ssh -i .deploy_key root@8.210.198.140 'node /opt/5blong/server/scripts/init-db.mjs'
# 3) 重启并自检
ssh -i .deploy_key root@8.210.198.140 'systemctl restart 5blong-api && systemctl is-active 5blong-api'
# 4) 线上验证新接口真的存在（比如新加了 /api/duel）
curl -s https://5blong.site/api/duel -o /dev/null -w "%{http_code}\n"   # ≠404 才算上线
```

> **1.9.24 事故记录**：v1.9.24 带了新的 `/api/duel` 服务端代码并发了 Release，
> 但没有任何人推 server —— 网页端上线了、接口 404，直到两天后才被发现。
> 原因：发版的人只看 CI 绿了就收工。**CI 绿 ≠ 全部上线。**

**发版自检口诀：改了什么端，就部署什么端，并 curl 验证那个端。**
（客户端 → 等 CI；server → 手动 scp + 建表 + 重启；介绍页 → 手动传
`/var/www/5blong/` 根目录；最后跑 sync-web.mjs / sync-desktop.mjs 让服务器拉 Release。）

### ⚠️ 并行期的硬规则

信令是**全局注册表**：网页端（5blong.site）和已安装的桌面客户端（pages.dev）
**不在一张注册表里，同一房号也互相看不见**。这批客户端改动**尚未发版**，
发版时必须同步抬高 `MIN_SUPPORTED`，把旧版赶上来，否则就是两个世界。

## 共享屏幕优化（2026-10-14 晚）：从根上解决"观众看着卡/糊"

> **本节专为后续维护者（含 AI）而写**：交代"共享屏幕为什么卡、改了什么、怎么验证、别踩哪些坑"。  
> 这一轮**只动共享链路，语音一行未碰**（语音零影响是硬约束）；四批次全部落地，  
> `npm run check` 全绿（typecheck + <!-- AUTO:TESTS -->421<!-- /AUTO:TESTS --> 单测 + 构建）。  
> 完整方案与逐条推理见 [SCREENSHARE-OPT-PLAN.md](./docs/archive/SCREENSHARE-OPT-PLAN.md)（已归档）；  
> 早期 v1~v3 草稿 [SCREENSHARE-PERF-PLAN.md](./docs/archive/SCREENSHARE-PERF-PLAN.md) 已被其取代（仅存档）。

### 一句话根因

"卡/糊"**不是码率不够**，而是四件事叠加：

1. **码率给错了**——P2P 画面呼叫（`peer.call()` 之后）**从不下发任何发送参数**，菜单里选的档位形同虚设；
2. **协商到软编**——PeerJS 默认把 VP8 排第一，而 **VP8 没有硬件编码器**，只能 libvpx 软编，1080p60 必糊；
3. **缓冲给多了**——P2P 同城直连也被强加 4000ms 抖动缓冲，glass-to-glass 白等 4 秒；
4. **上行被榨干**——共享者对**每个观众各推一份**，人多时家用上行直接打爆。

### 三条反直觉结论（后来者别走弯路）

1. **流畅不靠堆码率**：B 站 1080p60 实测只用 **2.64 Mbps** 就丝滑；码率上限设 20 Mbps 反而会让  
   P2P 按上限同时对多条上行推流，把家用上行打爆。
2. **把上限从 20M 降到 8M 并不会让马赛克变清晰**——瓶颈是**链路可达带宽**，不是上限。  
   真正决定观感的是"带宽不足时**降分辨率**还是**压质量**"；现在的配置选了前者（干净的小画面）。
3. **不能换 H.265**：Chrome 仅硬编、无软编回退，Edge 未启用，Firefox 不支持；一旦协商上而对端  
   解不了，结果是**黑屏**而非降质。**AV1** 只在探到硬件编码（Ada/RTX 40 及以后）时才提前，  
   且 Safari 在 WebRTC 里不协商 AV1，所以 **P2P 一律 H.264**。

### 关键事实：想吃 NVENC，编解码器必须是 H.264

NVENC/NVDEC 是 **NVIDIA 驱动内建的硬件编解码单元**，任何程序都能调用  
（OBS／Chrome／WebView2／Oopz 一视同仁）——**不存在"某个软件独占的 NVENC"**。

**NVENC 只能编 H.264 / HEVC / AV1；VP8 / VP9 没有硬件编码器**  
（只有 NVDEC 支持它们的**解码**）。PeerJS 默认协商 VP8，所以"用上 NVENC"在 5blong 里  
等同于"**把协商改成 H.264**"（→ `preferH264Sdp`）。Windows 上的路径：

```
Chrome / WebView2 WebRTC → Media Foundation 的 H.264 MFT → GPU 驱动 → 硬件编码单元
优先级：AsyncMFT（硬件） > LegacyMFT > OpenH264（软件兜底）
```

（顺带：Oopz 媒体栈实为腾讯云 TRTC，差距来自其**国内就近中继**，不是"自研编码器"。）

### 改了什么（文件 × 关键点 × 批次）

| 文件                        | 关键点                                                                                                                                                                                                                                                     | 批次  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `App.tsx`                 | `<RoomView>` 补 `sharePc={voice.sharePc}`——灯箱数据条此前对**所有人**恒为空白的直接原因（该 prop 声明为**可选**，漏传时 TS 不报错）                                                                                                                                                         | 0   |
| `components/PenTV.tsx`    | 灯箱读数**双向化**：共享者看发送端、观众看接收端                                                                                                                                                                                                                              | 0   |
| `pen-tv.css`              | 补上只被引用、**从未定义**过的 `.vx-tv-stats` 样式                                                                                                                                                                                                                     | 0   |
| `screen-share.ts`         | `SHARE_QUALITY_PRESETS` 码率 **720p 5M / 1080p 8M**；`RESOLUTION_LADDER` 1080p→720p→540p；`JITTER_BUFFER_MS` **P2P 600 / SFU 3000**；`preferH264Sdp()`；`createScreenSenderTuner()`；`healScreenConnection()`；`publishScreen` 的 ICE 收集与会话创建**并行**；simulcast 发布 | 0–3 |
| `engine.ts`               | P2P 画面连接挂**自适应调谐器**并真正下发档位（原 `peer.call()` 后无任何 `setParameters`）；`sdpTransform: preferH264Sdp`；抖动自愈                                                                                                                                                     | 1–3 |
| `protocol.ts`             | `ScreenSharePublication` 增 `simulcast` 字段（向后兼容解析）                                                                                                                                                                                                       | 2   |
| `settings.ts`             | 传输方式默认 `p2p` → **`auto`**；`settingsVersion = 2` 迁移旧配置                                                                                                                                                                                                   | 2   |
| `use-voice.ts`            | 传输决策（观众 ≤4 走 P2P / ≥5 位观众切 SFU）、simulcast 开关、把发布对象存入 `sharePubRef`（原来**被丢弃**，停播时 SFU 连接不收口）                                                                                                                                                             | 2   |
| `components/RoomView.tsx` | 传输选项加"自动"档 + 实时显示"本次将用 X：理由"                                                                                                                                                                                                                            | 2   |

### 四个批次

- **批次 0 观测**：先把"看不见"变成"看得见"——灯箱数据条 + WebCodecs 硬编预检  
  （`VideoEncoder.isConfigSupported({ codec: "avc1.640028", …, hardwareAcceleration: "require-hardware" })`）。  
  不看数据就优化等于闭眼调参，这是前几轮的教训。
- **批次 1 治病**：码率匹配、P2P 下发档位（按观众数分摊，下限 1.2 Mbps）、  
  降级方向改 `contentHint = "detail"`（原 `degradationPreference` 在 Chrome 已失效，是**空转**）、  
  抖动缓冲分级、`preferH264Sdp`。
- **批次 2 结构性**：传输默认 auto、**simulcast 多档**（rid `f`/`h`/`q`，订阅端 `preferredRid` +  
  `asciibetical` 降级——Cloudflare 官方这两个默认是 `none`，不改会死推最高层）、开播并行提速、  
  AV1 仅硬编择优。
- **批次 3 自愈**：抖动先 `restartIce()`（2.5s/6s 观察窗、最多 2 次），彻底断了才重拨；  
  按 `qualityLimitationReason` 带宽自适应降档，健康 18s 后回升。

### 怎么验收（看数字判断，不是猜）

开播后放大灯箱，底部数据条：

- **共享者（发送端）**：`发出 W×H · fps · 实际码率 · 编码器(硬编/软编) · 限流原因`
  - 显示 `硬编` = 吃到 NVENC 了；
  - 限流原因 `bandwidth` = 链路不够（考虑降档）；`cpu` = 没吃到硬编（查 SDP 是否被排回 VP8/VP9）；  
    `none` 但码率很低 = 参数没生效。
- **观众（接收端）**：`W×H · fps · 码率 · 解码器(硬解/软解) · 卡顿/丢包`
  - `硬解` 却仍卡 → 问题在**链路/缓冲**，与解码无关。

**已知坑（必须实测）**：AMD 全线 + 部分 Intel 的 Windows 上，Chrome 的 H.264 硬编存在  
"**发送码率上不去**"的已知问题（症状恰是画面糊、码率不足 100 kbps），根因在 GPU 驱动层；  
Chromium 用 `MediaFoundationUseSWBRCForH264Desktop` 让自带码率控制器接管。  
所以"设完就以为好了"是错的。  
**本地无法验证、必须现场测的还有三条**：① 真实 ≥3 人房间的 simulcast 挑层；  
② AMD/Intel 上 H.264 硬编的码率上限；③ NVENC 是否真被选中。

### 红线（改这里时不要破坏）

- **语音零影响是硬约束**：共享走独立 WebRTC 连接，与语音的 PeerJS 链路物理隔离；  
  共享失败只表现"幕布暗屏 + 轻提示"，**绝不断语音、不动成员列表**。
- `preferH264Sdp` 依赖 PeerJS `peer.call(id, stream, { sdpTransform })` 的调用时机  
  （在 `createOffer` 之后、`setLocalDescription` 之前；peerjs 1.5.5 已核对）。  
  **升级 peerjs 后必须重新确认这个插入点还在**，否则它会静默失效。
- README 里的 `AUTO-LOG` 区块由 CI 自动生成（提交信息带 `[skip ci]`），**不要手改**。

---

## 跨网进不去房间？先看这一节：打洞与 TURN 中继（2026-10-14 深夜）

**症状**：同一台机器 / 同一局域网里开两个窗口能互相进房，**跨网络怎么都进不去**；  
界面只转圈、不报错。

### 一句话根因

**进房握手本身也是一条 `RTCPeerConnection`**（PeerJS 的数据通道），和音视频一样要过 ICE。  
同机时两端走 `host` 候选（本机 / 局域网地址），不碰 STUN/TURN 所以必通；跨网就必须先靠  
STUN 拿到公网映射地址才有打洞资格，而**对称 NAT / 公司网 / 校园网 / 运营商 CGNAT 打不通，  
必须靠 TURN 中继兜底**——当时唯一的 TURN 兜底已经死了。

### 两条实测证据（别凭感觉，去看数字）

1. `openrelay.metered.ca` **解析到 `192.0.2.1`** —— RFC 5737 里专门留作文档示例的  
   **不可路由黑洞地址**。本机 DNS 与腾讯 DoH 两次独立解析结果一致。  
   所以它的问题不是"被限流"，是**服务已经关停**。
2. 换成 Cloudflare TURN 后，`turn.cloudflare.com` 的 3478 / 443 / 5349 / 80 四个端口  
   **全部可达**，`stun.cloudflare.com:3478` UDP 有响应。

### 现在的做法

- 服务端 `/ice` 现场签发 **Cloudflare Realtime TURN 短期凭据**（TTL 24 小时），  
  长密钥只存在 Worker 的 secret 里，**永不进前端**。
- 客户端 `src/client/voice/ice.ts` 负责拉取、结构校验、缓存（12 小时）与降级；  
  首页启动即预热，进房路径最多再等 2.5 秒。
- **铁律：拿不到 ICE 也必须能进房。** 拉取失败 / 超时一律退回纯 STUN 打洞，  
  绝不为中继把进房卡住。
- 静态兜底**只留实测活着的两家**（`stun.cloudflare.com` + `stun.chat.bilibili.com`）。  
  2026-10-14 UDP 实探：`stun.miwifi.com`（小米）已无响应、`stun.l.google.com` 大陆问不到。  
  STUN 只负责「问出自己的公网映射地址」，多配几家并不提升穿透率（那是 TURN 的活），  
  留着死地址只会误导日后排查。

### 需要配的两样（一次性）

TURN key 与 SFU 的 appId/secret **是两套**，分别创建：

1. Cloudflare 后台 → Realtime → **创建 TURN 服务器应用**，拿到 *Turn 令牌 ID* 与 *API 令牌*  
   （API 令牌只显示一次，务必当场复制）。
2. 写进本机 `.dev-secrets.json`（已在 `.gitignore`，不会入库）：
   ```json
   { "turnKeyId": "……", "turnKeyApiToken": "……" }
   ```
   之后 `npm run deploy:pages` 会把 `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` 自动写进  
   Pages 项目的环境变量（与 `SFU_APP_ID` 同一路径，日志里只打印键名、不打印值）。  
   只想同步密钥、不想重发站点时用 `npm run pages:env`（等价 `--env-only`）——  
   Pages 是**整站替换**，顺手跑一次普通部署会把线上的 `/desktop/` 更新源一起删掉。  
   环境变量在**部署时**注入运行环境，所以写完变量还得有一次部署才生效。

> **没配也能跑**：`/ice` 返回 501，客户端静默退回纯 STUN —— 同网可用、跨网打不通。  
> 这是**有意为之**的降级，不是 bug。

### 红线（改这里时不要破坏）

- `/ice` 的**状态码语义是契约**：`200` 有凭据 / `501` 没配 / `502` 签发失败。  
  客户端据此决定是否降级，改掉语义会静默破坏降级路径。
- 不要在前端写死任何 TURN 凭据。历史上就是这么干的，服务一关停就全线崩且毫无线索。
- `iceServers()` 必须**同步**返回——PeerJS 只在构造 `Peer` 那一刻读 `config`。

### 附：进房"没提示 / 看着没在连"（本轮已修）

这是同一现象里混着的**纯前端问题，与网络无关**，本轮一并修掉了。三处原因与修法：

- **失败原因压根没人渲染**。输 4 位房间码是**直接进房**（不经过确认页），而引擎写进  
  `voice.joinError` 的值，`App.tsx` 给 `LandingView` 的 props 里**没有它**——  
  `LandingView` 只用自己那份局部 state（只在"输入格式不对"时才赋值）。  
  → 表现：弹窗一关、屏幕上什么都不剩（这就是"自动回到首页、也没提示"）。  
  **修**：`LandingView` 新增 `error` / `joining` / `retrying` / `onCancelJoin` /  
  `onDismissError`，`App.tsx` 用 `voice.joinError` 与 `isJoinInFlight(status)` 喂进去；  
  首页现在直接显示"正在进入房间…"和失败原因，并带一个「知道了」收起。  
  （顺带：提交后**不再清空输入**，失败后一键即可重试；进房中把首页两个按钮**禁用**，  
  避免重复点"加入"再跑一次 `joinRoom` 把 12 秒超时重置掉。）
- **重拨期看着像没在连**。进房等待最长约 36 秒（welcome 12s 超时 × 最多 3 次整体重拨），  
  期间引擎置 `reconnecting`，而确认页的"正在进入…"只认 `preparing`/`connecting`  
  → 按钮变回"加入并开麦"，用户重复点击还会重置 12 秒超时，等于自己把进房拖更久。  
  **修**：判定抽成 `isJoinInFlight()`（`protocol.ts`：三种状态都算进行中），首页与确认页  
  共用一份；确认页补一行等待说明 `JOIN_WAIT_HINT`。
- **`peer-unavailable` 被吞掉**。信令服务器明确回答"目标 ID 不在注册表"时（PeerJS 的  
  Expire，消息里带目标 ID），`openPeer` 的 `finish()` 有 `settled` 守卫（peer 一 open  
  就为真），这条专用错误**永远报不出来**，只能等满 12s×3 才知道是"房主不在线"。  
  **修**：新增 `onLatePeerError()` 处理 "open 之后才到达的错误"——还有重拨机会就  
  **立刻**换新 ID 重拨（省掉 12 秒空等），机会用完就直说"房主不在线，邀请可能已失效"。  
  只认消息里带**房主 ID** 的那一类：访客之间的媒体呼叫失败不该把整个进房判死。

回归测试：`tests/engine-join-handshake.test.ts`「房主不在线 → 立刻报错，不空等超时」  
（实测过：摘掉修复该用例即失败，状态停在 `connecting`）、  
`tests/voice-protocol.test.ts`「isJoinInFlight」。

---

## 版本历史

> 逐版本的完整记录（2026-10-13 ~ 2026-11-03，共 19 个版本）已移到
> [docs/HISTORY.md](./docs/HISTORY.md)。这里只留最近三版的要点：

- **1.9.27**：降噪模型下载后立即生效（不用重进房）；设置与房内可实时看到当前降噪模型
- **1.9.26**：梗王对局上线（含 6 个致命修复）、降噪模型改为按需下载（安装包回 7MB 量级）
- **1.9.22 / 1.9.23**：语音“重连中”的三个真 bug 修完；降噪换 DeepFilterNet3（衰减限幅 24dB）
- **1.9.19 / 1.9.20**：自建协商四补丁；终极根因是中继配额（coturn user-quota=12）

<!-- AUTO-LOG:START -->
### 近期提交（自动生成）

- `4d8690e` release: v1.9.26（11-04 18:52）
- `932db36` docs: 梗王对局上线收尾交接（推送 1.9.25 + 双设备验收清单）（11-04 15:40）
- `73a7b7b` release: v1.9.25（11-04 15:18）
- `68b1cf7` fix: 对局轮询非 200 抛错并提示连接状态（等待层不再无声消失）（11-04 15:18）
- `b2e50e7` docs: README 增加发版必检清单（server 不在 CI 里，1.9.24 /api/duel 404 事故记录）（11-04 14:52）
- `dc3e7bd` release: v1.9.24（11-04 14:19）
- `717010c` feat: 成员客户端版本上报后台（hello 带 version → 名册 → 遥测）（11-04 11:35）
- `993e6e2` chore: sync-desktop 维护稳定下载别名 5blong_latest_x64-setup.exe（介绍页按钮依赖）（11-04 11:29）
- `3abad4e` chore: 强制更新闸门提到 1.9.22 + 同步脚本 minimum 只升不降（11-04 11:25）
<!-- AUTO-LOG:END -->

## 怎么用

### 方式一：网页（推荐，加入者零安装）

1. 打开 <https://5blong.pages.dev>，点击 **创建语音房**；
2. 进入房间后点击右上角 **复制邀请**，把链接发给朋友（也可口头告知 4 位数字房间码）；
3. 朋友打开链接会先看到确认页——写清“谁邀请你、你以什么名字进、要不要先静音”，  
   点一下才真正进房；若只知道房间码，在首页点 **加入语音房** 输入 4 位数字码即可直接进；
4. 房间内可：静音 / 开麦、闭听（小猪戴上耳罩，全房间可见）、文字聊天（关闭时有未读角标）、  
   发言高亮；点任意成员可对 TA 做 8 种互动（投喂 / 戳 / 抱抱等）、调本地收听音量，  
   房主还能禁言 / 踢人 / 锁房；随时可复制邀请或查看圈号。

邀请链接形如：

```
https://5blong.pages.dev/#c=<房间码>&h=<房主ID>&k=<邀请密钥>
```

`#` 之后的内容**不会随请求发给任何服务器**，邀请密钥只在你和拿到链接的人之间传递。

### 方式二：桌面端（安装包，带自动更新）

从 [GitHub Releases](https://github.com/HeXiang96/5blong/releases/latest) 下载  
`5blong_<版本>_x64-setup.exe` 双击安装（免管理员，装到当前用户目录）；  
GitHub 下载不通时用国内直链（与自动更新源同步，换成最新版本号即可）：  
`https://5blong.pages.dev/desktop/5blong_<版本>_x64-setup.exe`。

- 安装包约 7 MB（与网页版共用系统 WebView2，不内置浏览器内核）；
- 桌面快捷方式 + 开始菜单 + 系统托盘常驻；点右上角 × 隐藏到托盘、语音继续；
- **进房默认静音**：创建房间 / 输码进入默认静音，确认页可取消勾选直接开麦；
- **自动更新**：启动后台静默检查新版本，发现后弹**主题化确认框**，一键下载安装并自动重启；  
  下载时显示进度（小猪往前跑），下载/安装期间窗口置顶，安装完整结束后才重启  
  （更新包经 minisign 签名校验，更新源就是本仓库的 Releases）；
- 也可随时右键托盘图标点「检查更新」手动检查。

开发时在项目根目录运行：

```
npm run tauri dev      # 加载本地开发服务器（需先 npm run dev）
npm run tauri build    # 本地出安装包（需配置签名环境变量，一般直接用 CI）
```

桌面端会自动授予麦克风权限，不弹系统授权框。再次启动会聚焦已开窗口（单实例）。

---

## 房间是怎么保护起来的

两种进房方式，私密程度不同：

- **邀请链接（更私密）**：链接额外带一个随机邀请密钥（只存在于 `#` 片段里，  
  不会发给任何服务器）。访客连上后用 HMAC-SHA256 证明自己持有密钥，证明与自己的  
  peer ID、房间码绑定、无法转借；房主再用同一密钥签名回证，访客校验通过才算见到  
  真房主，占用了房间码的人也骗不过去。
- **房间码（图方便）**：房主直接注册在**由房间码推导的固定 ID** 上，访客在首页  
  输入 4 位数字码就能定位房主、直接进房，不需要任何注册服务器。代价是“知道码就能进”  
  ——码即门票，口头报码、屏幕显示时注意别让外人拿到。
- 未通过握手、伪造证明、房间满 8 人、房间已结束，都会收到明确原因，而不是一直转圈。

---

## 个人资料与设置

- 首次打开自动生成唯一的个人 ID（保存在本机，无需注册），可修改昵称、上传头像、选择头像颜色；
- 头像先压到 192px 再存本机，避免大图撑爆浏览器存储；
- 语音设备：选择麦克风 / 扬声器，并做麦克风测试（实时音量条）；切换扬声器失败会如实提示；
- 房间内语音控制（参考 Oopz 的快捷面板）：
  - 底部麦克风按钮右侧的小箭头打开快捷面板：麦克风音量/增强（0–200%，Web Audio 增益）、  
    AI 智能降噪开关、回声消除、自动增益，以及"完整语音设置"入口；
  - 点击任意成员头像：调节 TA 的本地收听音量，或对 TA 本地静音（只影响自己）；
  - 点击自己的头像同样可快速调麦克风音量；
- 语音处理真正生效：智能降噪使用开源 RNNoise（`@sapphi-red/web-noise-suppressor`，MIT，  
  WASM + AudioWorklet），**默认开启、进房即生效**，通话中也能实时开关；麦克风音量/增强拖动立即生效；
- 回声消除 / 自动增益会先尝试**通话中实时应用**（`applyConstraints` + 回读确认），  
  浏览器或设备不支持时才显示"重进生效"——标签只在确实还没生效时出现；
- **所有语音设置改动都会立即写入本机存储**，刷新页面或重新进房都不会丢  
  （快捷面板与设置页共用同一份持久化逻辑）；
- 静音不再把头像变灰，只在头像右下角显示小话筒角标；
- 无麦克风时可作为纯收听者加入，不阻断进房；
- 外观：跟随系统 / 深色 / 浅色。

---

## 常见问题

**Q：以前复制的链接为什么换个网络就打不开？**

A：早期链接里的地址是你电脑的地址（`localhost` 或局域网 `192.168.x`），只有本机能开 / 同一 WiFi 能开。现在邀请统一指向公网网页 `5blong.pages.dev`，任何网络都能打开前端；通话仍是 P2P，不经过网页服务器。

**Q：个别网络连不通 / 一直"连接中"？**

A：**先分清"进不去房间"和"进去了画质差"——它们走两条独立链路，别混着治。**

- **进不去**：走的是信令握手（自建信令服务，PeerJS 线协议兼容，多线路自动降级）＋ 数据通道的 ICE。同机 / 同网能进、  
  跨网进不去，说明**打洞失败且没有可用中继**。这正是 2026-10-14 定位到并修掉的问题：  
  当时唯一的 TURN 兜底（OpenRelay）已经关停（解析到 `192.0.2.1`）。现在改用服务端  
  `/ice` 签发的 Cloudflare Realtime TURN 短期凭据——**但前提是服务端配了  
  `TURN_KEY_ID` / `TURN_KEY_API_TOKEN`**（见「打洞与 TURN 中继」）。没配就自动退回纯  
  STUN，跨网仍然打不通；此时 `/ice` 返回 501，属预期降级而非故障。
- **画质差**：走媒体链路，才轮到带宽与中继限速。看灯箱数据条上的「直连 / 经中继」与  
  「可用 XXXX kbps」判断——够 8~~10 Mbps 就能稳 1080p，只有 1~~2 Mbps 就得治链路。
- 要做到国内几乎 100% 连通、且延迟最低，最稳妥仍是**自建一台国内 VPS 跑 coturn**，  
  地址与凭据挂在 `src/client/voice/ice.ts` 的 `FALLBACK` 旁边即可。
- 小猪头顶的状态点显示当前是"直连"还是"走中继"，方便判断通话质量。

**Q：房主离开会怎样？**

A：当前版本房主离开即结束房间，成员会收到提示。

**Q：对方没点离开、直接关网页 / 关软件，还显示在线？**

A：房主与访客**双向**每 2 秒心跳，超过 6 秒收不到即判定掉线并移出名单；访客侧超过 10 秒收不到房主响应也会明确结束，不会停在假连接上。

**Q：换个 WiFi / 电脑休眠之后呢？**

A：已建立的 P2P 音频不受信令断开影响。信令掉线会以同一访客身份自动重连（最多 2 次、  
每次 7 秒内完成），短暂断网 / 休眠唤醒后一般能自己回到房间，既保留原有的音频连接、也能继续接纳新成员；  
连续重连失败才会明确结束并提示，不会一直停在假连接上。

**Q：房间里改了降噪 / 音量 / 回声消除，为什么重进就没了？**

A：这是已修复的缺陷。修复前房间内的快捷开关只改内存、从不写盘，所以刷新或重新进房就回默认值。  
现在每次改动都会立刻写入本机存储；回声消除与自动增益还会先尝试通话中实时应用，  
只有浏览器/设备确实不支持时才会标注"重进生效"。

**Q：智能降噪需要手动开吗？**

A：不需要，**默认就是开的**，建好房间或进房那一刻就已经在处理链里生效。  
如果开关被自动拨回并弹出提示，说明当前浏览器无法加载降噪组件（WASM/AudioWorklet 不可用），  
此时界面如实告知而不是假装已开启。

## 技术说明

- 信令是**自建服务**（Cloudflare Worker `5blong-signal` + Durable Object，PeerJS 线协议兼容；  
  客户端优先走本站域名 `/peerjs` 中转、公共云兜底，见 `signal-routes.ts`），  
  媒体层是 **WebRTC P2P（全互联 mesh）**；
- 前端：React 19 + Vite + TypeScript；桌面端：**Tauri 2（Rust 壳 + 系统 WebView2）**，  
  安装包约 3.6 MB，与网页版共用同一份前端产物；
- 网页通过 Cloudflare Pages（Wrangler）托管；桌面端由 **GitHub Actions 云出包**，  
  **自动更新源托管在 Cloudflare Pages 的 /desktop/ 路径**（与网页同域，国内可直连），  
  GitHub Releases 作为备源；
- 协议核心（房间码、握手证明、准入裁决、消息校验）是**不依赖 DOM 的纯函数**，有独立单元测试。

## 开发者命令

```
npm install                 # 安装依赖
npm run dev                 # 本地开发服务器（网页）
npm run tauri dev           # 桌面端开发模式（自动起 dev 服务器 + Tauri 窗口）
npm run typecheck           # 类型检查
npm test                    # 单元测试（<!-- AUTO:TESTS -->421<!-- /AUTO:TESTS --> 项，由 docs:sync 注入）
npm run build:web:pages     # 构建静态网页到 dist-web
npm run tauri build         # 本地出桌面安装包（更新签名需要环境变量，一般直接用 CI）
npm run deploy:pages        # 手动部署网页到 Cloudflare Pages（复用本机 wrangler 凭据）
npm run pages:env           # 只把 .dev-secrets.json 的密钥写进 Pages 环境变量，不上传站点
npm run publish:desktop     # 手动发布桌面端更新源到 Pages（CI 通常自动做，此为兜底）
npm run status:pages        # 查看 Pages 部署状态
npm run bump -- 1.0.2       # 发新版本：改版本号 → 提交 → 打 tag 推送（CI 出包并自动发布到 Pages）

# 服务端（意见反馈 / 在线房间 / 自建信令；都在 Cloudflare 免费额度内，幂等可重跑）
npm run feedback:setup      # 建 D1 库 + 建表 + 绑定 Pages + 生成管理令牌（写 .dev-secrets.json）
npm run feedback:admin -- list 20   # 终端查看反馈（url 打印带令牌的管理页链接 / rm <id> 删一条）
npm run signal:deploy       # 部署自建信令 Worker（5blong-signal，PeerJS 协议兼容）
npm run signal:setup        # 绑定 Pages → 信令 Worker（service binding SIGNAL）
```

> 自建信令的两个关键点（改 `worker/signal/index.js` 前先读）：  
> ① 必须用 **WebSocket 休眠 API**（`state.acceptWebSocket`），否则一个常驻 Durable Object  
> 每天要烧 ~11,000 GB·s（免费额度 13,000/天，几乎吃满）；  
> ② 客户端每 5 秒发一条 `{"type":"HEARTBEAT"}`，必须用  
> `setWebSocketAutoResponse` 精确匹配自动应答，否则心跳会把请求额度烧掉一大半。

### 桌面端发布与自动更新

- **云出包 + 自动发布（一条命令）**：推 `app-v*` 标签（`npm run bump -- x.y.z` 一条命令搞定）触发  
  `.github/workflows/release.yml`，在 Windows runner 上构建 NSIS 安装包  
  （`5blong_x.y.z_x64-setup.exe`，免管理员）发布到  
  [Releases](https://github.com/HeXiang96/5blong/releases)，**随后 CI 自动把更新源  
  发布到 Pages**——runner 直连 GitHub 和 Cloudflare，全程不需要本机挂代理；
- **CI 自动发布的前置配置（一次性）**：GitHub 仓库 Secrets 里加 `CLOUDFLARE_API_TOKEN`，  
  取自 Cloudflare → My Profile → API Tokens → Create Custom Token，  
  权限选 **Account → Cloudflare Pages → Edit**；未配置时 CI 会跳过发布，  
  此时可本机手动跑 `npm run publish:desktop -- x.y.z`（需代理在线）；
- **更新源顺序**：主源 `https://5blong.pages.dev/desktop/latest.json`（国内可直连），  
  备源 GitHub Releases（主源连不上时自动尝试）；
- **自动更新**：安装包同时产出签名更新包（`.sig`）与 `latest.json` 清单。  
  已安装的桌面端启动后静默检查（也可托盘右键「检查更新」），发现新版本弹窗确认，  
  下载 → minisign 签名校验 → 安装 → 自动重启，全程不需要打开浏览器；  
  签名校验只针对安装包内容，与下载地址无关；
- **签名密钥**：更新包用 Tauri minisign 密钥签名，公钥写在 `src-tauri/tauri.conf.json`，  
  私钥保存在本机 `~/.tauri/5blong.key` 并存于仓库 Secrets（`TAURI_SIGNING_PRIVATE_KEY`）。  
  **私钥丢失将无法再发布可被旧版本识别的更新，请妥善备份**；
- 注意：更新源列表写在安装包里——**只有 1.0.2 起的版本才知道 Pages 主源**。  
  1.0.0 / 1.0.1 客户端升级到 1.0.2 仍需走 GitHub 备源（本机需代理在线）一次。

### 网页部署说明

`npm run deploy:pages` 直接调 Cloudflare API，不需要 wrangler/npm：

1. 读取本机 wrangler 的 OAuth 凭据，过期就用 refresh token 自动续期（PKCE，无需 client secret）；
2. `GET /accounts` → 账号 ID；`GET .../upload-token` → 上传用 JWT；
3. `POST /pages/assets/check-missing` 只上传缺失资源；
4. `POST /pages/assets/upload`（每批 ≤40 MiB）+ `upsert-hashes`；
5. `POST .../deployments` 提交 manifest 完成发布。

> **最关键的一点**：Pages 的资源指纹是  
> `hex(blake3(base64(文件内容) + 扩展名)).slice(0, 32)`，**不是** sha256、也**不含路径**。  
> 算错这个值，`check-missing` 永远认为全部缺失、上传也进不了库，部署记录显示 `success`  
> 但线上取不到任何资源，表现为**整站 500**。  
> 该算法由 `src/shared/blake3.ts` 实现（部署脚本用等价的 `scripts/lib/blake3.mjs`），  
> 两者都由官方 BLAKE3 测试向量验证，见 `tests/blake3.test.ts`。

## 目录

- `src/client/voice/`：语音房前端
  - `protocol.ts`：房间码 / 邀请解析 / 握手证明 / 准入裁决 / 线上消息校验（纯逻辑，可单测）
  - `engine.ts`：mesh 引擎（准入握手、心跳、媒体连接、RNNoise 降噪链、说话检测、资源回收、房间遥测快照）
  - `signal-routes.ts`：信令多线路（自有域名 `/peerjs` 中转优先、公共云兜底；DEV 直连）
  - `devices.ts`：麦克风采集、扬声器绑定、设备枚举、麦克风测试
  - `ice.ts`：ICE 配置（STUN + 拉取 `/ice` 的 Cloudflare TURN 短期凭据，带缓存与降级；桌面端用绝对地址）
  - `identity.ts` / `settings.ts` / `storage.ts`：本机身份与设置持久化（含 `settingsVersion` 迁移）
  - `screen-share.ts`：屏幕共享链路（采集约束、码率/降级/自适应调谐器、H264 协商重排
    `preferH264Sdp`、硬编预检、抖动缓冲分级、simulcast 发布、ICE 自愈、传输自动选择）
  - `feedback.ts` / `onboarding.ts`：应用内意见反馈 / 首次导览
  - `changelog.ts` / `session-stats.ts`：版本更新日志 / 会话统计（今晚小结）
  - `pen.ts` / `pen-registry.ts` / `pen-follow.ts`：猪圈"导演"纯逻辑（事件、时序、确定性槽位）
  - `scene-theme.ts` / `pen-themes.css`：房间主题（雪原 / 万圣夜，四时段配色与装扮）
  - `use-voice.ts`：引擎与 React 之间的唯一桥接
  - `App.tsx` / `components/` / 各 css：界面
  - `components/PenTV.tsx` / `pen-tv.css`：投影幕布与小猪围观的呈现 + 灯箱（含双向链路读数）
  - `components/` 其余：`SettingsView`（设置）、`OnboardingDialog`（导览）、`FeedbackDialog`（反馈）、
    `HealthCheck`（一键体检）、`UpdateOverlay`（更新弹层）、`ViewportPopover`（视口避让浮层）
- `src/client/game/`：**开黑圈**（5v5 分队内战）独立子系统，与语音房完全隔离——
  `game-mesh.ts`（独立引擎与 `g` 系列协议、分队连接拓扑）、`GameRoomView.tsx`（三栏编制板）、
  `use-game.ts`、`game-theme.css`（电竞深色主题）、`game-types.ts`
- `src/shared/blake3.ts`：BLAKE3（部署资源指纹用），由官方向量测试
- `worker/`：Cloudflare 侧——`_worker.pages.js`（Pages 高级模式，路由 `/ice` `/sfu/*` `/feedback`
  `/admin` `/rooms*` `/game*`）、`signal/`（自建信令 Worker + Durable Object `SignalHub`）、
  `feedback-schema.sql`（D1 建表，幂等）
- `src-tauri/`：桌面端 Tauri 壳（Rust）
  - `src/lib.rs`：托盘常驻、单实例、点 × 隐藏驻留、WebView2 麦克风权限自动放行、
    启动静默检查更新 + 托盘「检查更新」、WASAPI 系统音采集
  - `tauri.conf.json`：窗口 / NSIS 打包 / 自动更新源（Pages 主源 + GitHub 备源）与公钥
- `.github/workflows/`：`release.yml`（云出包，`app-v*` 标签触发）、
  `readme-log.yml`（自动更新 README 提交列表，`[skip ci]`）
- `tests/`：协议 / 握手 / 准入、屏幕共享（含调谐器与硬编预检）、猪圈、说话检测、定时器、
  ICE、反馈、会话统计、音量上限、blake3 等，当前合计 <!-- AUTO:TESTS -->421<!-- /AUTO:TESTS --> 项
- `scripts/`：`deploy-pages.mjs`（部署）、`publish-desktop.mjs`（桌面端更新源发布）、
  `pages-status.mjs`、`bump-version.mjs`（发版一键化）、`readme-log.mjs`（AUTO-LOG，含畸形自愈）、
  `docs-sync.mjs` / `check-docs.mjs`（文档数字注入与校验）、`lib/blake3.mjs`
- `docs/`：专题记录与历史档案（索引与治理规则见 `docs/README.md`）
- `public/`：图标与第三方许可（`index.html` 引用的 `/favicon.png`、`/icon-256.png` 来自这里）
- `dist-web/`：静态网页产物（桌面端与网页共用，构建时生成，不入库）