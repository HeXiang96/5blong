# 围炉看投影：房间共享屏幕方案

> 状态：**已实现并通过本地验证 + 双端 E2E（2026-10-14）** · 设计（2026-10-14）
> 一句话：坡顶双绳吊一块内嵌大幕布，点「共享」后投影仪从天而降、光束打到幕布上；
> 小猪缩小了围到火堆边趴着看，停播后幕布收绳升起、投影仪飞走。点幕布可放大。
>
> 实现与验证记录：
> - 全部里程碑落地（除 macOS 桌面端采集，维持"仅观看"）；动画编排完整实现
>   （放绳降幕/投影仪坠落/围坐/散场/音效），三时段（昼/暮/夜）光照适配。
> - **SFU 全链路回环验证通过**：`tests/fixtures/sfu-loop.html` 用演示画面走真实
>   Cloudflare Realtime SFU（publish → subscribe → 画面逐帧变化），凭证走本地代理。
> - **双端 E2E 通过**：房主开播 → 观客裸码进房 → 观客幕布收到实时画面（≤6s）。
> - **防串流双保险**：SFU 点名订阅模型 + 发布登记表（本地代理内存账本 /
>   生产 Worker 用全局 Durable Object），未登记的订阅一律 403。
> - 画质档位落地：高清 HD 720p / 超清 1080p（均 60fps、10000 kbps），见共享菜单。
> - 分辨率适配：幕布 ≤ 舞台宽 44% 且 ≤ 舞台高 52%，四档窗口实测（1920/1280/1024/820）。
> - **生产接口已上线**：Pages 高级模式 `_worker.js` 提供同域 `/sfu/*`
>   （2026-10-14 部署验证：sessions/new=201、未登记订阅 403）；
>   桌面端 SFU_BASE 直连 `https://5blong.pages.dev/sfu`（v1.1.1 起）。
>
> 上线流程（**每次发版按此顺序**，全程自动）：
> 1. 本地验证（可选）：`node scripts/dev-sfu-server.mjs` + `npm run dev`
>    （凭证在 `.dev-secrets.json`，已 gitignore），浏览器开
>    `/tests/fixtures/member-menu.html?tv=1`（全套动画目检）、
>    `/tests/fixtures/sfu-loop.html`（SFU 回环）；
> 2. 冒烟闸门：`npm run check`（typecheck + 全部单测 + 构建）；
> 3. 发版一条命令：`npm run bump -- x.y.z`（版本号三处同步 + changelog 条目 +
>    提交 + 打标 + 推送）→ 推送即触发 GitHub Actions 云出包；
> 4. CI 出包成功后**自动**把网页 + 桌面更新源发布到 Cloudflare Pages
>    （`CLOUDFLARE_API_TOKEN` Secret 已配置）；
> 5. **/sfu 屏幕共享接口**由部署包里的 `_worker.js` 提供
>    （`worker/_worker.pages.js`，部署脚本自动附带），
>    SFU 凭证在 Pages 项目环境变量 `SFU_APP_ID` / `SFU_APP_SECRET`
>    （本机发部署时自动从 `.dev-secrets.json` 写入，一次配置长期生效）。
>    网页端（同域）与桌面端（`https://5blong.pages.dev/sfu`，见
>    `screen-share.ts` 的 SFU_BASE 环境解析）都走它；CI 里没有
>    `.dev-secrets.json` 也不影响——项目环境变量已持久化。
>
> 已知边界：macOS 桌面端采集未做（维持"仅观看"）；Pages 版登记表是
> isolate 级内存账本（尽力而为），最强加固版见 `worker/index.js`
> （Durable Object 账本，可部署到自定义域名）。

是的，这个设计初衷和 Piik 是同一类：**共享的内容不是浮在屏幕角落的一块tile，而是空间里的一个"东西"**。猪看电视 = 把远程协作放回场景本体，电视有没有亮着本身就是房间状态。

---

## 1. 总体架构

媒体走 **Cloudflare Realtime SFU**（无服务器 SFU，按量计费，无需部署 SFU 实例）；状态走**现有 PeerJS 房间数据通道**；密钥托管在一个**极小的 Cloudflare Worker** 里。

```
共享者(猪)                          观看者(其他猪)
   │ getDisplayMedia 选窗口/进程          │
   ▼                                     │
 采集 screen stream                       │
   │ publish (WebRTC)                    │
   ▼                                     ▼
[Cloudflare Realtime SFU] ── 媒体转发 ──▶ subscribe (WebRTC)
   ▲                                     ▲
   │ HTTPS API(持 App Secret)            │
[Cloudflare Worker] ◀── 鉴权/发凭证 ──────┘
   ▲
   │ 签发 publish/subscribe 授权
   ▼
PeerJS 房间数据通道（已有）: 广播 "电视开播了，sessionId+trackName 是这个"
```

分工（官方定义的职责边界，已核实 developer.cloudflare.com/realtime/sfu）：
- **Realtime SFU**：只管 WebRTC 会话与媒体/DataChannel 转发，不提供房间概念。
- **我们的后端（Worker）**：持 App Secret、鉴权、房间状态（谁在共享）。
- **房间状态**：复用现有 host 权威的 PeerJS 星型协议，**不新造一套信令**。

为什么不继续 P2P：现有语音是 1 对 1 mesh 没问题，但屏幕共享是 **1 推 N**，P2P 下共享者要给每个人各推一份上行，家用宽带扛不住；SFU 下共享者永远只推 1 份。

---

## 2. 模块拆解

### A. 协议层（`protocol.ts` / `engine.ts`）

新增一条 host 权威广播消息，风格对齐现有 WireMessage：

```ts
export interface ScreenShareState {
  active: boolean;
  sharerId: string;        // 谁在共享（掉线/退出由 host 清理）
  sessionId: string;       // SFU 会话 id
  trackName: string;       // 媒体轨名（订阅方据此拉流）
  label: string;           // 屏幕上显示的来源名，如 "Visual Studio Code"
  hasAudio: boolean;       // 是否带系统/标签页声音
  startedAt: number;
}
```

- 开播：共享者先拿 SFU 授权 → publish 成功后 `send` 给 host → host 广播全员。
- 停播 / 共享者断线 / 窗口被关：host 检测到后广播 `active: false`，全员释放订阅。
- **同一时间只允许一个共享者（硬约束）**：一台电视，物理上就一台。三层保障：
  1. host 互斥——开播请求按到达顺序裁决，后来的直接拒绝；
  2. 采集端预检——点"共享屏幕"按钮时若电视已亮，按钮直接置灰/提示"电视被 XX 占着"（用本地已有的 ScreenShareState，不发无效请求）；
  3. 事件兜底——即使并发竞态双双 publish 成功，host 广播时只保留第一个，后到的强制停播退订。
- **动画编排不新增消息**：掉支架/猪聚集/散场全部由客户端对 `ScreenShareState` 的 `active` 翻转做出反应，各自本地播放（见 §D）。

### B. Cloudflare Worker（新后端，~100 行）

项目目前零后端，这是唯一需要新增的服务，但它是无服务的：

- **路由 1**：`POST /publish` — 校验房间码（复用现有房间邀请码机制）→ 调 Realtime SFU API 创建 session → 返回 SFU 签发的 SDP answer 所需凭证/会话信息。
- **路由 2**：`POST /subscribe` — 校验房间码 + `sessionId/trackName` 确实存在且在播 → 返回订阅所需凭证。
- App Secret 存 Worker Secrets，**永远不进前端包**。
- 部署：`wrangler deploy`，免费额度内的小房间场景基本够用；部署脚本挂到 `scripts/`，与 Pages 部署并列。

> 计费口径：SFU 按用量计费（连接分钟/轨数），实现前以官方 Pricing 页为准核对一次。

### C. 采集端：选择共享哪个进程

**v1 —— 系统 picker（先跑通）**：

```ts
const stream = await navigator.mediaDevices.getDisplayMedia({
  video: { frameRate: 15, width: { ideal: 1920 } },
  audio: { /* 可选：系统/标签页声音 */ },
});
```

- Web 版：浏览器自带 picker，Windows 下会按**应用窗口（即进程）**列出，满足"选哪个进程"。
- Tauri 桌面版（WebView2）：`getDisplayMedia` 由 WebView2 提供，会弹出 Edge 风格的窗口/屏幕选择器。⚠️ **这是最大的技术风险点**：Tauri v2 对 WebView2 的屏幕捕获权限默认行为需要 PoC 验证（可能要在 Rust 侧处理 PermissionRequested）；macOS WKWebView 不支持 getDisplayMedia，桌面版 mac 短期降级为"仅可观看"。
- 共享过程中监听 track `ended`（用户在 picker 里点"停止共享"），自动走停播流程。

**v2 —— 自定义窗口选择器（想做得像猪圈风格再做）**：
Rust 侧 `EnumWindows` 枚举窗口出列表（图标+标题）→ 自绘猪圈风格选择器 → 选中后用 Windows.Graphics.Capture 按窗口捕获。工作量大（原生帧如何注入 WebRTC track 是硬骨头），**仅在 v1 的系统 picker 体验被业主否决后才做**。

### D. 场景与动画编排（`PenProps.tsx` / 新组件 `PenTV.tsx`）

延续现有分层 DOM/SVG 插画路线（与蔬菜、装饰同套体系）。

#### D1. 总时间线：空草地 → 掉落 → 聚集 → 看电视

**核心观念：场景初始没有电视。** 有电视 = 有人在共享，电视的出现/消失本身就是房间事件。

```
t=0        ScreenShareState{active:true} 广播到达
           └─ 木支架 + 小电视从天上掉落（~700ms 重力加速）
              插进草地：下压回弹（squash & stretch）
              草屑/尘土溅开，火堆火星蹦一下，落地"咚"音效
t≈0.7s     电视开机：雪花噪点 0.5s → 共享画面淡入
t≈1.2s起   各猪从当前位置走向火堆前的观看位（随机 stagger 0~800ms）
           走路时长 4~6s（复用"走向蔬菜"的 approach 机制）
t≈5~7s     到位 → 进入 watch 姿态：面朝电视，偶尔点头/耳朵动
```

- **落点选位**：电视落点固定在火堆旁空地、避开猪的跑道；掉落期间落点半径内若有猪，猪先让开半步再落（避免"砸猪"穿模）。
- **音效**：`sounds.ts` 新增 `tv-land`（落地闷响）/ `tv-on`（开机电流声）/ `tv-off`（关机"啪"）。

#### D1.5 聚集动画的质感要求（重点打磨项）

"走到位"不难，"走得可爱"才难。以下是硬性打磨标准：

- **路线不走直线**：火堆是障碍物，每头猪沿贝塞尔弧线**绕过火堆**汇入观看位，多方向扇形汇入，像真实围拢而不是排队报数。实现：WAAPI 多关键帧（1~2 个中间 waypoint）模拟弧线，不依赖 offset-path，兼容性最稳。
- **节奏错落，不做百米赛跑**：出发延迟随机 0~800ms 之外，再按距离反调——近的猪慢悠悠（6s），远的猪小跑（4s），让**到位时间自然错开 0.3~1s**，人群是陆续坐定的，不是整点齐步走。
- **到位落座三拍**：减速滑入（ease-out）→ 小跳一下落座（squash & stretch）→ 脚边扬起 2~3 粒小尘土 + 轻微"噗"声。落座后 1s 内耳朵/尾巴轻晃一下（安顿感）。
- **走路姿态复用现有 walk 起伏**，加速时起伏频率略升（区分散步和小跑）。
- **彩蛋（M4，可选）**：最后一个到的猪先"伸头张望找位子"再坐下；找不着前排座的猪站后排时踮脚。

#### D2. 猪聚集机制（复用现有 approach 链路）

现有"吃蔬菜"已经是 **pen 事件驱动走位**：事件广播后 `EAT_APPROACH_MS`（5s）内 WAAPI 把猪从当前位置移到目标。电视围观原样复用：

- `pen.ts` 新增事件 `tv-live`（停播对应 `tv-off`），走同一 phase 机制（`approach → watch`），新增 `WATCH_APPROACH_MS`；
- **观看位槽位**：火堆前弧形排位（前排坐 6~8 个 + 后排站立），槽位按 peerId 排序**确定性分配**，保证每个客户端渲染一致；超员的猪站后排/火堆对侧；
- **姿态优先级**：watch 期间暂停闲逛；说话的猪仍会跳（voice activity 优先级更高）；被摸/被戳等互动正常响应；
- 中途进房的猪：进场后直接补走到空余观看位。

#### D3. 散场编排（停播，掉落的镜像）

```
ScreenShareState{active:false}
├─ 电视画面雪花 2s →"啪"关机
├─ 关机瞬间：所有猪同步"抬头愣 0.3s"（统一反应，散场前的呼吸感）
├─ 猪随机 stagger 散开，各回跑道随机点，恢复闲逛
└─ 支架带着电视腾空飞走（掉落的反向动画），场景回到空草地
```

**散场质感要求（与聚集同等打磨标准）：**

- **集体愣神**：关机后 0.3s 全场静止、所有猪面朝电视不动——这是"节目结束了"的情绪拍，之后才动。
- **散开有情绪**：出发带 1~2 个欢快小跳（意犹未尽），落地扬尘；音效来两声轻快的"哼哼"（复用现有 pig 音效体系）。
- **路线同样是弧线**（绕过火堆散向各方向），不是原地四散直线弹开；走回自己区域后无缝接回现有闲逛逻辑。
- **支架飞走与猪散开并行**：支架缓入加速 + 轻微旋转 + 略微缩小升空消失，节奏比掉落略慢（回味感）；掉落约 0.7s，飞走约 1s。
- **彩蛋（M4，可选）**：~15% 的猪走出两步后回头望一眼空草地（电视没了的怅然感）再继续走。

> 备选：电视留在原地变待机道具。推荐飞走——场景干净，且"电视在 = 共享中"的信号更强，和你的"开播才掉下来"心智一致。

#### D4. 电视道具本体

- **外观**：两根斜撑木支架 + 横梁，木纹色对齐现有木头装饰色板（`ScatterArt` wood）；圆角电视外壳 + 内凹屏幕 + 天线旋钮，默认约占场景宽 12~15%；
- **屏幕是真正的 `<video>`**（`object-fit: contain`，圆角裁切）：待机雪花（CSS 噪点）/ 亮屏两态；
- **时段光效**：夜/傍晚电视发冷光照亮一圈（走 `data-daypart` 机制），火暖屏冷，画面情绪核心；
- 共享者中途换源：电视不重新掉落，雪花一瞬后换画面。

### E. 放大观看

- 点击电视 → **lightbox 层**（复用 `popover.ts` 的浮层机制或独立全屏层）：
  - 16:9 大画面，同一 `<video>` srcObject（不用第二个 video，直接挪 DOM 或复用 stream）；
  - 左上显示共享者名 + 来源 label；右上关闭（ESC 同效）；
  - 音量/静音控件（共享带声音时）。
- 场景里的小电视持续渲染低码率画面即可（SFU 有 simulcast 的话用低层；没有就直接同一轨，小电视上 `video` 收缩渲染本身开销很低）。

### F. 观看端订阅

- 收到 `ScreenShareState{active:true}` 后拉 Worker 授权 → 向 SFU 订阅该轨 → `video.srcObject = stream`。
- 懒订阅：页面不可见（切后台）时暂停订阅省流量，回来再拉。
- 延迟预期：SFU 转发 glass-to-glass 约 200~400ms（官方口径，实现后实测为准），对"看电视"场景完全无感。

### G. 容错清单

| 情况 | 处理 |
|---|---|
| 共享者直接关 App/断网 | host 检测 peer 离开 → 广播停播 → 订阅者释放 |
| 共享者点浏览器"停止共享" | track ended → 主动停播广播 |
| SFU 会话过期/出错 | 观看端 video 黑屏 >3s → 电视回到雪花待机态，toast 提示 |
| 两人同时抢着开播 | host 互斥（按钮预检 + 广播裁决双保险），后者收到"电视被 XX 占着"，不产生第二台电视 |
| 掉落动画播到一半共享者跑路 | 动画照播完（落地即待机雪花），随后走正常散场流程 |
| 房间没人了 | SFU session 由 Worker 侧 TTL 清理 |

### H. 语音零影响（硬性设计约束）

**开关共享屏幕绝不能碰语音链路。** 共享结束后房间照常在、语音照常说——这不是"尽量做到"，是实现结构决定的：

- **两条完全独立的连接**：语音仍走现有 PeerJS P2P（信令 + 音轨）；屏幕共享的 publish/subscribe 用**独立的 RTCPeerConnection 实例**（只连 SFU），两者不共享任何 PC、ICE 状态或回调。共享链路无论成功、超时还是崩溃，都碰不到语音的 PeerConnection。
- **房间状态与共享解耦**：`ScreenShareState` 只是房间状态上的一个可空字段，电视只是场景道具。成员表、加入/离开、语音通话的建立与销毁**完全不读也不写**这个字段；电视道具的挂载/卸载只影响渲染层。
- **生命周期单向**：停播只做三件事——关共享的 PC、释放订阅、清 ScreenShareState 字段。不做任何"重置/重建"动作，PeerJS 房间连接自始至终不动。
- **异常只降级、不上抛**：SFU 错误、Worker 不可达、订阅失败，全部收敛为"电视雪花 + toast"，**绝不触发语音的断线重连或错误弹窗**。
- **回归测试（进 M1/M2 验收）**：开播 → 停播 → 共享中途杀掉 SFU 会话，三个节点前后断言：语音通话不断、成员列表不变、互动（摸猪/扔蔬菜）正常。

---

## 3. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0 PoC**（先证明路通） | 纯 Web：两个浏览器 tab，getDisplayMedia → SFU publish → 另一 tab subscribe 显示。Worker 最小实现 | 第二个 tab 能看到第一个 tab 的屏幕，延迟体感 <0.5s |
| **M1 接入房间** | protocol 消息 + host 互斥三层保障 + 断线清理；电视静态出现在火堆旁（待机/雪花/亮屏三态） | 多人房间 A 共享、B 的电视亮起来；A 关掉所有人的电视回雪花 |
| **M2 动画编排** | 掉落开机（含音效/尘土/回弹）+ 猪聚集（approach 复用 + 确定性槽位）+ 散场飞走 | 空草地开播 → 掉落 → 猪围火看电视 → 停播散场，全链路动画验收 |
| **M3 桌面端** | Tauri/WebView2 getDisplayMedia PoC → 若权限不通做 Rust 侧权限处理；lightbox 放大 + 音量 | 桌面端能选到具体应用窗口并开播；点电视可放大 |
| **M4 氛围打磨** | 夜间屏光、点头/耳朵动、被抢座/超员后排、换源雪花一瞬 | 傍晚时段火光+屏光效果验收 |

---

## 4. 风险与待确认

1. **WebView2/Tauri 屏幕捕获权限** —— M2 第一件事做 PoC，不通再决定是否值得上原生捕获方案。
2. **Realtime SFU 计费** —— 上线前核对官方 Pricing，按房间规模估算月成本。
3. **首次引入后端（Worker）** —— 部署脚本、密钥管理（wrangler secrets）要进 README；App Secret 泄漏 = 别人能蹭 SFU，Worker 必须校验房间码。
4. **macOS 桌面端** 不支持 getDisplayMedia，桌面版 mac 首期"仅观看"。
5. **语音与共享双链路并存**：语音走 PeerJS P2P、屏幕共享走 SFU，两条链路物理隔离（见 §H），互不影响；实现中禁止任何共享代码路径触碰语音状态。

## 5. 不做的事

- 不做多人同时共享（一台电视，物理上就一台）。
- 不做录屏/回放。
- 不动现有语音链路。
