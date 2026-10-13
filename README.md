# 5blong

低延迟语音为核心的临时沟通工具。无需注册账号、无需选择服务器，**创建房间、复制邀请链接**即可开聊，适合朋友、团队和临时群组。

* 公网地址（任何网络可开）：[https://5blong.pages.dev](https://5blong.pages.dev)
* 单房建议 2–6 人，最多 8 人；音频在参与者之间点对点（P2P）直连。
* 全程 0 成本：信令用免费公共 PeerJS 云，NAT 穿透用免费公共 STUN，不需要任何付费服务。

> 上游 Piik 的原始说明保留在 [README.piik.md](./README.piik.md)；
> 上游源码已按你的要求从本目录清理，如需查阅请看上游仓库或 `README.piik.md`。
>
> **✅ 前述缺陷已修复（2026-10-12）**：此前"访客用邀请链接能进房并看到房主，
> 但房主看不到访客、访客约 12 秒后被断开"的问题，根因是 `onGuestData()` 里
> `joined` 守卫顺序的死循环（catch-22），已修复并补充回归测试。
>
> **✅ 多人加入超时已修复（2026-10-12）**：针对"第 3、第 4 个人进不去、
> 报房主没有响应"——welcome 超时改为自动整体重拨（最多 3 次）、访客间媒体
> 协商错峰消除信令风暴、被呼应答改用处理后的发送流。线上 4 人顺序加入实测
> 均在 5 秒内完成。
>
> 修复记录见 [KNOWN-ISSUES.md](./KNOWN-ISSUES.md) 顶部。

***

## 最近更新（2026-10-13）

**小猪互动与房间氛围**

* **8 种互动动作**：戳一戳、打招呼、投喂、摸一摸、挠痒痒、抱一抱、吓一跳、撒个花。
  点成员菜单里的动作，对应小猪会蹦跳、摇晃、扭摆或被吓到，头顶弹出气泡（！/你好~/♡/哼哼~/
  哈哈哈/抱抱/！！/耶~）；其中"投喂"会让被喂的小猪头顶冒爱心、走过去吃掉空中飞出的蔬菜。
* **闭听戴耳罩**：闭听后小猪闭眼侧躺睡觉、耳朵上戴上一副耳罩，名字牌出现"闭听"小徽章；
  该状态在**全房间同步**——别人那头也能看到你戴上了耳罩，不会再不知道你闭听。
* **房间背景美化**：冷灰底换成暖奶油天空 + 中间柔和隆起的草坡，小花小草降到低饱和、落在草坡上；
  撤掉四边栅栏，保留小猪与投喂，整体是顶部木牌 + 底部悬浮木托盘的简洁木牌风。
* **文字聊天木牌化**：聊天抽屉从通用白色面板改成与房间一致的木纹标题栏、暖木气泡、
  奶油色输入框（自己的消息是木牌棕色、别人的是淡奶油卡片），深色模式同步适配。

**房主管理（房主可见）**

* **禁言**：强制某成员静音，对方无法自行解除；**踢出**：立即移出房间；
* **锁房**：一键锁定，锁定后新访客进不来并收到"房间已锁"提示，已在房间的人不受影响；
* 成员点菜单一处搞定：本地收听音量、8 种互动、投喂次数、禁言 / 踢人。

**可靠性与状态提示**

* **信令断线自动重连**：掉线后以同一访客身份自动重连（最多 2 次，每次 7 秒内完成），
  短暂断网 / 刷新 / 网络抖动不再直接退房；
* **网络状态可视化**：每只小猪头顶有状态点（连接中 / 已连接 / 走中继 / 失败）；
* **修复窗口缩放时小猪跑出屏幕**：舞台尺寸变化会把小猪钳回新的活动范围并重新漫步；
* 加入 / 离开提示音；浏览器标签页标题随"谁在说话、房间几人"实时变化，切到别的标签也能留意。

**跨网连通增强**

* ICE 从单个 STUN 扩为 **4 个公共 STUN（Cloudflare / Google / 小米 / B站）+ 免费 OpenRelay
  TURN 中继（80 / 443 / 443-TCP）**，多数对称 NAT、公司网、校园网也能打通；
  OpenRelay 是公共免费服务、可能限流，若要 100% 连通建议自建 coturn（`iceServers()` 已预留位置）。

***

## 怎么用

### 方式一：网页（推荐，加入者零安装）

1. 打开 [https://5blong.pages.dev](https://5blong.pages.dev)，点击 **创建语音房**；
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

### 方式二：桌面端（免安装便携版）

打包产物在 `dist-desktop/5blong-win-x64/`，双击 `5blong.exe` 即可；整包压缩件是
`dist-desktop/5blong-win-x64.zip`。

开发时在 `piik` 目录运行：

```
npm run electron        # 加载本地构建的页面
npm run electron:dev    # 加载本地开发服务器（需先 npm run dev）
```

桌面端会自动授予麦克风权限，不弹系统授权框。点右上角 × 不会退出，而是最小化到系统托盘、语音继续；右键托盘图标可显示窗口或退出，再次启动会聚焦已开窗口（单实例）。

***

## 房间是怎么保护起来的

两种进房方式，私密程度不同：

* **邀请链接（更私密）**：链接额外带一个随机邀请密钥（只存在于 `#` 片段里，
  不会发给任何服务器）。访客连上后用 HMAC-SHA256 证明自己持有密钥，证明与自己的
  peer ID、房间码绑定、无法转借；房主再用同一密钥签名回证，访客校验通过才算见到
  真房主，占用了房间码的人也骗不过去。
* **房间码（图方便）**：房主直接注册在**由房间码推导的固定 ID** 上，访客在首页
  输入 4 位数字码就能定位房主、直接进房，不需要任何注册服务器。代价是“知道码就能进”
  ——码即门票，口头报码、屏幕显示时注意别让外人拿到。
* 未通过握手、伪造证明、房间满 8 人、房间已结束，都会收到明确原因，而不是一直转圈。

***

## 个人资料与设置

* 首次打开自动生成唯一的个人 ID（保存在本机，无需注册），可修改昵称、上传头像、选择头像颜色；
* 头像先压到 192px 再存本机，避免大图撑爆浏览器存储；
* 语音设备：选择麦克风 / 扬声器，并做麦克风测试（实时音量条）；切换扬声器失败会如实提示；
* 房间内语音控制（参考 Oopz 的快捷面板）：
  * 底部麦克风按钮右侧的小箭头打开快捷面板：麦克风音量/增强（0–200%，Web Audio 增益）、
    AI 智能降噪开关、回声消除、自动增益，以及"完整语音设置"入口；
  * 点击任意成员头像：调节 TA 的本地收听音量，或对 TA 本地静音（只影响自己）；
  * 点击自己的头像同样可快速调麦克风音量；
* 语音处理真正生效：智能降噪使用开源 RNNoise（`@sapphi-red/web-noise-suppressor`，MIT，
  WASM + AudioWorklet），**默认开启、进房即生效**，通话中也能实时开关；麦克风音量/增强拖动立即生效；
* 回声消除 / 自动增益会先尝试**通话中实时应用**（`applyConstraints` + 回读确认），
  浏览器或设备不支持时才显示"重进生效"——标签只在确实还没生效时出现；
* **所有语音设置改动都会立即写入本机存储**，刷新页面或重新进房都不会丢
  （快捷面板与设置页共用同一份持久化逻辑）；
* 静音不再把头像变灰，只在头像右下角显示小话筒角标；
* 无麦克风时可作为纯收听者加入，不阻断进房；
* 外观：跟随系统 / 深色 / 浅色。

***

## 常见问题

**Q：以前复制的链接为什么换个网络就打不开？**

A：早期链接里的地址是你电脑的地址（`localhost` 或局域网 `192.168.x`），只有本机能开 / 同一 WiFi 能开。现在邀请统一指向公网网页 `5blong.pages.dev`，任何网络都能打开前端；通话仍是 P2P，不经过网页服务器。

**Q：个别网络连不通 / 一直"连接中"？**

A：WebRTC 在大多数家庭宽带和手机热点可直连。本版本按 0 成本设计：配置了 4 个免费公共
STUN（Cloudflare / Google / 小米 / B站）**并接入免费的 OpenRelay TURN 中继**（80/443/TCP），
多数公司网、校园网、对称 NAT 也能打通。但 OpenRelay 是公共免费服务、可能被限流，
极端网络下仍可能连不通——这时界面会如实提示而不是假装还在连。若要做到几乎 100% 连通，
最稳妥是自建一台最便宜的 VPS 跑 coturn，把地址填进 `engine.ts` 的 `iceServers()`（已预留位置）。
小猪头顶的状态点会显示当前是"直连"还是"走中继"，方便判断通话质量。

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

***

## ✅ 已修复：邀请链接加入后房主侧看不到访客（2026-10-12）

### 根因

`src/client/voice/engine.ts` 的 `onGuestData()` 里，守卫顺序写反了，形成死循环：

```ts
const guest = this.guests.get(conn.peer);
if (!guest || !guest.joined) return; // 旧代码：joined=false 一律拦截
// ……
switch (message.t) {
  case "joined": this.announceJoin(conn.peer); // 唯一能把 joined 置 true 的分支
}
```

访客记录在 `handleHello()` 里创建时 `joined=false`；而把它翻成 `true` 的唯一消息
`t:"joined"` 恰恰在 `if (!guest.joined) return` 之后——于是 `case "joined"` 永远不可达。
这与实测日志里反复出现的 `HOST msg-dropped-not-joined` 完全对应，也连带解释了 12 秒断连：

* `announceJoin()` 不执行 → 房主名单停在 1 人；
* `broadcastHost()` 只发给 joined 访客 → 访客收不到房主 ping；
* 访客发出的 ping 也被同一守卫丢弃、拿不到 pong → `hostLastSeen` 冻结，
  10 秒后访客侧触发 `HOST_SILENCE_TIMEOUT_MS` 自行结束（实测约 12 秒）。

此前怀疑的“多条 DataConnection / `evictGuest` 误删 / Map 被清空”均**不是**根因。

### 修复

放行 `joined` 这一条消息，其余消息维持“未握手不服务”：

```ts
const guest = this.guests.get(conn.peer);
if (!guest) return;
if (!guest.joined && message.t !== "joined") return;
```

### 验证

* `npm run typecheck` 通过；
* 新增回归测试 `tests/engine-join-handshake.test.ts`：模拟 hello → welcome → joined，
  断言访客被标记 joined、房主侧名册变为 2 人、joined 后 ping 有 pong。
  该测试在旧代码上 2 条全失败、修复后全通过；
* 已重新构建 `dist-web/`，压缩产物中可见修复后的闸门
  `if(r&&!(!r.joined&&n.t!==`joined`))`。

> **尚未做**：KNOWN-ISSUES.md 第 7 节那种双窗口真机实测（含 60 秒保活、双向聊天、
> 离开后回落到 1/8）。本次以单元回归 + 产物核对交付，真机验收建议上线前补一次。

***

## 技术说明

* 在开源项目 **Piik（MIT）** 基础上二创，保留其版权声明；
* 信令使用 **PeerJS 公共云**，媒体层是 **WebRTC P2P（全互联 mesh）**；
* 前端：React 19 + Vite + TypeScript；桌面端：Electron；
* 网页通过 Cloudflare Pages（Wrangler）托管；
* 协议核心（房间码、握手证明、准入裁决、消息校验）是**不依赖 DOM 的纯函数**，有独立单元测试。

## 开发者命令（在 `piik` 目录）

```
npm install                 # 安装依赖
npm run dev                 # 本地开发服务器
npm run typecheck           # 类型检查
npm test                    # 单元测试
npm run build:web:pages     # 构建静态网页到 dist-web
npm run package:desktop     # 构建网页 + 打包 Windows 便携版
npm run verify:desktop      # 校验打包产物完整性
npm run smoke:desktop       # 启动打包产物做渲染自检（需要普通 Windows 会话）
npm run deploy:pages        # 部署到 Cloudflare Pages（复用本机 wrangler 凭据）
npm run status:pages        # 查看 Pages 部署状态
```

### 部署说明

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

> 打包脚本同样零依赖（没有 npm/npx/electron-builder 也能跑）：
> `scripts/package-desktop.mjs` 复刻 Electron 的 `resources/app` 应用形式，
> `scripts/zip-desktop.mjs` 用 `node:zlib` 手写 zip。

## 目录

* `src/client/voice/`：5blong 前端
  * `protocol.ts`：房间码 / 邀请解析 / 握手证明 / 准入裁决 / 线上消息校验（纯逻辑，可单测）
  * `engine.ts`：mesh 引擎（准入握手、心跳、媒体连接、RNNoise 降噪链、说话检测、资源回收）
  * `devices.ts`：麦克风采集、扬声器绑定、设备枚举、麦克风测试
  * `identity.ts` / `settings.ts` / `storage.ts`：本机身份与设置持久化
  * `use-voice.ts`：引擎与 React 之间的唯一桥接
  * `App.tsx` / `components/` / `styles.css`：界面
* `src/shared/blake3.ts`：BLAKE3（部署资源指纹用），由官方向量测试
* `tests/`：协议 / 握手 / 准入（`voice-protocol.test.ts`、`engine-join-handshake.test.ts`）、
  猪圈与小猪动画（`pen`）、说话检测（`voice-activity`）、定时器（`timers`）、
  `blake3.test.ts`（BLAKE3 5 项），当前合计 102 项
* `electron/`：Electron 主进程（含 `VOX_SMOKE=1` 启动自检）
* `scripts/`：`deploy-pages.mjs`（部署）、`package-desktop.mjs` / `zip-desktop.mjs` /
  `verify-desktop.mjs` / `smoke-desktop.mjs`（桌面端打包与验证）、`pages-status.mjs`、`lib/blake3.mjs`
* `public/`：图标与第三方许可（`index.html` 引用的 `/favicon.png`、`/icon-256.png` 来自这里）
* `dist-web/`：静态网页产物；`dist-desktop/`：桌面端产物

> 目录已清理：上游 Piik 的 Go 服务端、原生采集、官网、文档与 80 多个上游测试均已移除，
> 只保留 5blong 实际使用的代码。上游的 MIT 许可证原文保留在 `LICENSE`，
> 上游说明保留在 [README.piik.md](./README.piik.md)。
