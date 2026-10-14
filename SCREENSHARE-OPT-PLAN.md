# 共享屏幕优化方案

> **状态**：方案稿（只读分析产出，**源码未改动**）
> **取代**：`SCREENSHARE-PERF-PLAN.md`（v1~v3 逐版增补稿，已被本文件整体重写替换）
> **约束**：遵守 `SCREENSHARE-PLAN.md §H` —— 语音零影响，改动只落在共享链路内部
> **目标**：解决两个真实症状 —— ① 观众端看着卡／糊；② SFU 模式 1080p 开播糊成马赛克
> **2026-10-14 增补**：§4.1 重写为"NVENC／NVDEC 的四个前置条件"；新增 §4.5 落地清单与双端验收读数；批次 0 新增 O-4（观众端解码指标）

---

## 0. 一页速览

### 0.1 症状 → 根因 → 第一个动作

| 症状 | 直接根因 | 第一个动作 |
|---|---|---|
| 观众看着卡／糊（P2P） | 协商落到 **VP8** → 全球无硬件编码器 → 软编；且档位参数**从未下发** | 把协商拉回 H.264 + 真正下发档位 |
| SFU 1080p 马赛克 | 跨洋第一跳带宽 < 内容所需码率；且当前配置选择"保帧率、压质量" | `contentHint` 改 `detail` + 降级阶梯 |
| 看不出哪里不对 | 灯箱数据条**永远空白**（一行 prop 漏传） | **先补观测，再谈优化** |
| 人一多就炸 | 屏幕共享上行 = 码率 × 观众数（8 人 ≈ 56 Mbps） | 按人数分摊 + ≥3 人自动切 SFU |

### 0.2 三条反直觉结论（本方案与"堆码率"思路的分水岭）

1. **1080p60 只用 2.64 Mbps 就能丝滑**（B站链路实测）—— 流畅靠"硬件编码 + 码率匹配内容 + 就近中转 + 大缓冲"，**不靠堆码率**。
2. **把档位从 20 Mbps 降到 8 Mbps 不会让马赛克变清晰** —— 瓶颈是链路可达带宽。真正决定观感的是"**带宽不足时降什么**"：降分辨率（画面小但干净）还是压质量（分辨率高但全是块）。**当前配置恰好选了后者。**
3. **换编码器（H.265 / AV1）治不了当前的卡** —— 反而可能把 `bandwidth` 型问题换成 `cpu` 型。该做的是"确保走硬件编码 + 用对降级方向"。

### 0.3 起点状态（动手前必须先定）

工作区当前有**未提交的半成品改动**（4 个文件，+289／−48 行）：`App.tsx`、`engine.ts`、`screen-share.ts`、`use-voice.ts`。**未跑测试、未构建。**

- **A 继续完成**：以"P0 的一部分已落地"为起点，按本方案补齐并验证；
- **B 全部还原**：`git checkout --` 那 4 个文件，按本方案从零分批次实施。

> 本文件第 1、2 章的"现状"描述以**还原后的原始代码**为准；第 7 章标注哪些属于已改。

---

## 1. 事实基础：链路与拓扑

### 1.1 两条传输链路

| | **P2P（默认）** | **SFU（手动切换）** |
|---|---|---|
| 语音 | 全互联 mesh，不走 SFU | — |
| 屏幕 | 共享者 → 每个观众各一条独立连接 | 共享者 → Cloudflare Realtime → 各观众 |
| 媒体路径 | 直连（打不通时 TURN 兜底） | 经 Cloudflare **海外边缘** |
| 切换方式 | `settings.shareTransport` | 同上 |

### 1.2 拓扑（已对代码核实）

- **语音 = 全互联 mesh**：`engine.ts:2092 callPeers()` 遍历**所有**成员逐一拨号（不只是房主）；`shouldCall(peerId) { return this.myId < peerId }`（`engine.ts:1931`）按 ID 大小分工，保证每条边只建一次；访客间拨号错峰 `MEDIA_STAGGER_MS = 1200`。
- **屏幕 = 一推 N**：`startScreenCalls()` 对每个非本地成员各调一次 `callScreenPeer()`，共享者对**每个观众单独建一条连接推一份**。

### 1.3 中转只有 STUN / TURN，都不是 SFU

| 机制 | 地址 | 作用 | 能否省上行 |
|---|---|---|---|
| STUN | `stun.cloudflare.com` / google / miwifi / bilibili（`engine.ts:77`） | 仅做地址发现 | ❌ 不转发媒体 |
| TURN | `turn:openrelay.metered.ca`（免费公共） | 对称 NAT 打不通时兜底 | ❌ **1:1 中继**，边数不变、反多一跳 |
| SFU | Cloudflare Realtime | 选择性转发 | ✅ 但**仅屏幕共享、需手动切** |

> 代码注释自承：免费公共 TURN 可能限流、**在大陆未必能连上**；要彻底保证任何网络都能打通，建议自建 coturn（一台最便宜的 VPS）。

### 1.4 上行账本（决定人数上限的算术）

| 人数 | 语音连接/人 | 全房媒体边 n(n−1)/2 | 屏幕共享上行（1080p @ 8 Mbps） |
|---|---|---|---|
| 2 | 1 | 1 | 8 Mbps |
| 4 | 3 | 6 | 24 Mbps |
| 8（当前上限） | 7 | 28 | **56 Mbps** |

`MAX_MEMBERS = 8`（`protocol.ts:772`）的理由就写在注释里：*"全互联 mesh 的边数是 n(n-1)/2，8 人即 28 条媒体连接"*。

**结论：8 人上限是屏幕共享上行倒推出来的，不是语音。** 语音（约 40 kbps/路 × 7 ≈ 280 kbps）扛 8 人甚至 20 人都绰绰有余。即便切了 SFU，也**不建议**为了人数硬抬上限 —— SFU 第一跳在海外，那一段比家宽上行更紧。

---

## 2. 根因清单（每条指到代码）

| # | 根因 | 位置 | 性质 |
|---|---|---|---|
| **D1** | P2P 画面呼叫**完全没有下发码率／帧率**（`peer.call()` 之后无任何 `setParameters`）；档位只在 SFU 的 `publishScreen` 里生效 | `engine.ts` `callScreenPeer` | **缺陷** |
| **D2** | 协商落到 **VP8** → 无硬件编码器 → 软编。PeerJS 自建 RTCPeerConnection 并立即出 offer，我们没机会在协商前调 `setCodecPreferences` | `engine.ts`／`screen-share.ts` | **缺陷** |
| **D3** | `contentHint = "motion"`（保帧率、压质量），且配了一个**空转**的 `degradationPreference`（Chrome 已不支持该字段） | `screen-share.ts` | 配置错误 |
| **D4** | 抖动缓冲一律 **4000ms**，P2P 同城直连也白等 4 秒 | `screen-share.ts` + `engine.ts` | 配置错误 |
| **D5** | P2P 上行 **×N 无分摊** | `engine.ts` `startScreenCalls` | 设计缺口 |
| **D6** | 开播串行：ICE 收集与会话创建**无依赖却排队** | `screen-share.ts` `publishScreen` | 效率 |
| **D7** | SFU 第一跳在 Cloudflare **海外边缘**，跨洋带宽／抖动是环境性瓶颈 | 架构 | 环境 |
| **D8** | 灯箱数据条永远空白：`App.tsx` 的 `<RoomView>` **漏传 `sharePc`**，而该 prop 声明为可选属性（`?:`）→ TypeScript 静默不报错 | `App.tsx:107`／`RoomView.tsx:214`／`PenTV.tsx:263` | **缺陷** |
| **D9** | 断线无 ICE restart，抖一下就雪花 | `screen-share.ts` | 健壮性 |
| **D10** | `publishScreen` 的返回值**从未存入 `sharePubRef`** → 停播时发布对象被丢弃、连接不收口 | `use-voice.ts` | **缺陷** |

---

## 3. 优化方案（四个批次）

### 批次 0 —— 观测（**先做**，其它一切的前提）

| 编号 | 内容 | 文件 |
|---|---|---|
| O-1 | 补 `sharePc={voice.sharePc}`（一行，修数据条空白） | `App.tsx` |
| O-2 | 灯箱对**共享者**显示发送端指标（与观众端区分） | `use-voice.ts` + `PenTV.tsx` |
| O-3 | 硬编预检：`VideoEncoder.isConfigSupported({ codec: "avc1.640028", …, hardwareAcceleration: "require-hardware" })` | `screen-share.ts` |
| O-4 | 灯箱对**观众**额外显示解码端指标（`decoderImplementation` / `powerEfficientDecoder`） | `PenTV.tsx` |

O-2／O-4 要读到的数字（**后面所有优化的判据**）：

| 读数 | 含义 | 期望 |
|---|---|---|
| `frameWidth × frameHeight` | 编码器**实际**输出分辨率 | = 档位值 |
| `outbound-rtp.bytesSent` 变化率 | 实际码率 | 接近档位值 |
| `qualityLimitationReason` | 限流原因 | `bandwidth`=链路不够／`cpu`=没吃到硬编／`none` 但码率低=**参数没生效** |
| `encoderImplementation` | 编码器实现 | 含 `MediaFoundation` / `Hardware` / NVIDIA |
| `powerEfficientEncoder` | 是否省电（即硬编） | `true` |
| `averageEncodeTime` | 单帧编码耗时 | 低而稳 |
| `availableOutgoingBitrate` | 链路可用带宽估计 | 与档位对比 |
| `inbound-rtp.decoderImplementation`（观众端） | 解码器实现 | 硬件解码器名（NVDEC 系） |
| `inbound-rtp.powerEfficientDecoder`（观众端） | 是否硬解 | `true` |

### 批次 1（P0）—— 直接治病：收益最大、风险最低

| 编号 | 改动 | 文件 × 函数 |
|---|---|---|
| P0-1 | 档位码率从"堆高"改"匹配"：720p60 **5 Mbps**、1080p60 **8 Mbps**（业主口径：基线 +2 Mbps） | `screen-share.ts` `SHARE_QUALITY_PRESETS` |
| P0-2 | **P2P 真正下发档位**（同步 + `signalingState === "stable"` + `connectionState === "connected"` + 2s 兜底，四重触发）；按观众数分摊 `maxBitrate`，下限 1.2 Mbps | `engine.ts` `callScreenPeer` + `screen-share.ts` `applyScreenSenderParams` / `perViewerBitrate` |
| P0-3 | 降级方向改走 `contentHint`（默认 `detail` 保清晰），删掉空转的 `degradationPreference` | `screen-share.ts` `publishScreen` + `engine.ts` `requestScreenShare` |
| P0-4 | 用 `scaleResolutionDownBy` 做 **1080p → 720p → 540p** 优雅降级阶梯 | `screen-share.ts` |
| P0-5 | 抖动缓冲按链路分级：**P2P 400~600ms** ／ **SFU 3000ms** | `screen-share.ts` `ontrack` + `engine.ts` `smoothScreenReceivers` |
| P0-6 | 把协商从 VP8 拉回 **H.264**（吃到 NVENC）：`sdpTransform: preferH264Sdp` 重排 `m=video` 载荷顺序 | `engine.ts` + `screen-share.ts` |
| P0-7 | `setParameters` 失败**不再静默吞掉**（打日志 + 界面提示） | `screen-share.ts` |
| P0-8 | 修 `sharePubRef` 从不赋值（停播泄漏） | `use-voice.ts` |

### 批次 2（P1）—— 结构性与体验

| 编号 | 改动 | 说明 |
|---|---|---|
| P1-9 | 开播／开看**并行**：`gatherIce` 与会话创建并行，超时 1200 → 800ms | 少等约 1 秒 |
| P1-10 | 硬编真预检 + **编码器择优**：探到 AV1 硬编才把 AV1 提到 H.264 之前，否则维持 H.264 基线 | 见 §4.1 |
| P1-11 | 传输方式**按人数自动选择**：1~2 人 P2P、**≥3 人自动 SFU**；面板明示"当前模式 + 原因" | 直接治 D5 |
| P1-12 | **simulcast 多档**（结构性最优） | 见 §4.4 |

### 批次 3（P2）—— 自愈与自适应

| 编号 | 改动 |
|---|---|
| P2-13 | 短暂抖动走 **ICE restart** 自动恢复，而非直接雪花 |
| P2-14 | 按 `qualityLimitationReason` 做带宽自适应降档：`bandwidth` → 降档；`cpu` → 降分辨率／帧率 |

---

## 4. 编码器策略

### 4.1 能，但没有"开关"——NVENC／NVDEC 的四个前置条件

先分清两个东西（也叫对名字）：**NVENC 管编码，NVDEC 管解码**，两者都在 NVIDIA 显卡驱动里，任何程序都能调（OBS／Chrome／WebView2 一视同仁）。**不存在"某个软件独占的 NVENC"**，所以问题不是"能不能借"，而是"**怎么让浏览器真的选中它**"。

**① 编解码器必须是对的（最关键）**

| 硬件单元 | 支持格式（已核实） |
|---|---|
| **NVENC**（编码） | H.264 / HEVC / AV1 —— **只此三种** |
| **NVDEC**（解码） | MPEG-2 / VC-1 / H.264 / H.265 / VP8 / VP9 / AV1 |

**VP8／VP9 没有硬件编码器**（NVDEC 只能解不能编）。而 PeerJS 默认的 `m=video` 顺序是 **VP8 在前** → 协商到 VP8 → **libvpx 软编** → 1080p60 必糊。所以：

> **"用上 NVENC" 在 5blong 里就等于 "把协商改成 H.264"** —— 这就是 P0-6（`sdpTransform: preferH264Sdp`），不需要任何外部软件。解码侧同理：对端收到 H.264 后由 NVDEC 硬解（Chrome 走 Media Foundation/D3D11 硬解路径）。

**② Windows 上的实际路径（Chromium 已实现 `Enable H.264 hardware MFT encoder on Windows`）**

```
Chrome WebView2 WebRTC → Media Foundation 的 H.264 编解码 MFT → GPU 驱动 → NVENC / NVDEC
优先级：AsyncMFT（硬件） > LegacyMFT > OpenH264 / libvpx（软件兜底）
```

Tauri 桌面端与网页版**共用同一份产物**，所以这条路径、这处修复对两端都有效。

**③ 配置得"喂饱它"**：码率过低（低于几 Mbps）时 NVENC 可能干脆不被选中 —— 这也是"基线 +2 Mbps"的合理依据；分辨率也应在 NVENC 支持的常规档（1080p／720p）上，怪尺寸可能触发回落。

**④ 必须实测，不能假设**：Chromium 会在配置不被支持时**静默回落软编**。所以唯一可靠的判据是读数（见 §4.5）。

**结论：能，而且该用 —— 但它是"三个条件同时满足"的结果，不是一个开关。**

### 4.2 必须警惕的已知坑

- **AMD 全线 + 部分 Intel 的 Windows 设备**上，Chrome 的 H.264 硬编路径存在**发送码率上不去**的问题（即构、Flashphoner 均有记录）。症状恰好是"画面模糊、`webrtc-internals` 里码率不足 100 kbps"，根因在 **GPU 驱动层限制码率**。Chromium 的应对是 `MediaFoundationUseSWBRCForH264Desktop`（让 Chromium 自己的**码率控制器**接管 —— 注意 "Software" 指码率控制器，**不是**放弃硬编）。
- **码率设得太低（低于几 Mbps）时 NVENC 可能不被选中** —— 这也是"基线 +2 Mbps"的合理依据。
- **结论：NVIDIA 卡可以走、也应该走；但"设完就以为好了"是错的，必须看批次 0 的三个读数。**

### 4.3 为什么不换 H.265 / AV1

| 编码 | 同码率画质（离线 VMAF，1080p @ 1 Mbps） | WebRTC 现实 |
|---|---|---|
| AV1 | ≈82（+21%） | Chrome／Firefox 可编；**Safari 在 WebRTC 会话里不协商 AV1** |
| H.265 | ≈78（+15%） | **全员否决型**：Edge 从未启用、Firefox 不支持；一旦协商上而对方解不了 = **黑屏**；4 个专利池 |
| VP9 | ≈75（+10%） | **无硬件编码器**（NVENC 不支持） |
| **H.264** | ≈68（基准） | **唯一保底**：所有浏览器都能出画面 + 有硬件编码器 |

> **代码现状**：`setPreferredVideoCodecs` 的 `score()` 已经是 `H.264(0) > AV1(1) > VP9(2) > VP8(3)`。AV1 排在 H.264 之后 = 永远不会被选中；H.265 连列表里都没有。
> **结论**：H.264 保持协商基线；AV1 **只在"探到硬编"时**提前（并入 P1-10）。

### 4.4 simulcast（收益最大的一项）

- Cloudflare Realtime SFU **原生支持 simulcast**：发布端一次编多档（如 1080p／720p／360p），SFU 按**每个观众的网络**自动选层转发。这正是 B站 ABR 的思路，且**共享者上行只 ≈1.25× 单档**。
- **坑**：官方文档明确 `priorityOrdering`／`ridNotAvailable` **默认是 `none`** —— 不改的话，带宽不足时 SFU 仍死推最高层，**反而更卡**；必须显式设置。
- 代价：要动**发布／订阅／协议**三处，工作量最大、风险最高。**建议放在批次 0 拿到数据之后再评估。**

### 4.5 NVENC／NVDEC 落地清单（照这个顺序做）

| 步 | 动作 | 落在哪个批次 |
|---|---|---|
| 1 | **把协商改到 H.264**：P2P 用 `sdpTransform: preferH264Sdp`（重排 `m=video`，PeerJS 自己出 offer，我们没机会调 `setCodecPreferences`）；SFU 用 `setPreferredVideoCodecs` | P0-6 |
| 2 | **探针预检**：`VideoEncoder.isConfigSupported({ codec: "avc1.640028", width, height, bitrate, framerate, hardwareAcceleration: "require-hardware" })` —— 一句话问系统"这台机器到底有没有能编这个配置的硬件单元"，不必建连接、不必造假流 | 批次 0（O-3） |
| 3 | **喂饱参数**：码率 ≥ 5 Mbps、分辨率走 1080p／720p 常规档、`contentHint = "detail"` | P0-1～P0-4 |
| 4 | **实测确认**（见下表）；不达标就按 §4.2 排查，别硬扛 | 批次 0（O-2／O-4） |

**验收读数（发送端 = NVENC 有没有用上）**

| 读数 | 期望 |
|---|---|
| `outbound-rtp.encoderImplementation` | 含 `MediaFoundation` / `Hardware` / NVIDIA 字样 |
| `outbound-rtp.powerEfficientEncoder` | `true` |
| `outbound-rtp.averageEncodeTime`（= `totalEncodeTime`/`framesEncoded`） | 低而稳；持续上升 = CPU 瓶颈（未走硬编） |
| `outbound-rtp.qualityLimitationReason` | 出现 `cpu` = 编码器没吃到硬件 |

**验收读数（接收端 = NVDEC 有没有用上）** —— 与发送端对称，字段在 `inbound-rtp` 上（已核实存在于 WebRTC 统计规范）：

| 读数 | 期望 |
|---|---|
| `inbound-rtp.decoderImplementation` | 硬件解码器名字（NVDEC／Media Foundation 系） |
| `inbound-rtp.powerEfficientDecoder` | `true` |

> 这两个字段正好补齐"**观看者**为什么卡"的判据：如果观众端 `powerEfficientDecoder = true` 却仍卡，问题在**链路／缓冲**，不在解码；若为 `false`，则是软解在拖后腿（可能是分辨率／编码不匹配，按 §4.2 排查）。

**一句话**：NVENC／NVDEC 的落地＝ **① H.264 协商 → ② 预检确认硬件在位 → ③ 码率分辨率喂饱 → ④ getStats 双端实测**。四步走完，硬件编解码才真正"用上了"；前三步不做，第四步永远看不到 `powerEfficient* = true`。

---

## 5. 验收标准（可测）

| 指标 | 现状 | 目标 | 怎么测 |
|---|---|---|---|
| 端到端延迟（P2P） | ≥4s（缓冲 4000ms + 软编） | **<1s** | `?tv=demo` 演示流自带毫秒时钟，对面读秒 |
| 端到端延迟（SFU） | 视链路 | <2s | 同上 |
| 编码器 | VP8 软编 | `encoderImplementation` 含 MediaFoundation／NVIDIA，`powerEfficientEncoder = true` | 批次 0 面板 |
| 实际码率 | 未下发 | 接近档位值 | `bytesSent` 变化率 |
| P2P 上行 | 码率 × 观众数 | 分摊后 ≤ 档位值，下限 1.2 Mbps | 同一面板 |
| 1080p60 观感 | 块状 | 文字可读、无明显块状 | 共享文本密集窗口，人为限速 2 Mbps 对比 |
| **语音** | — | **零影响**（共享失败绝不断语音） | 共享中断／失败时语音通话不断 |

---

## 6. 配置速查矩阵（拍板用）

| 场景 | 传输 | 分辨率／帧率 | 码率上限 | contentHint | 抖动缓冲 |
|---|---|---|---|---|---|
| 2 人、同网 | P2P | 1080p60 | 8 Mbps | `detail` | 400~600ms |
| ≥3 人 | SFU（自动） | 1080p60 | 8 Mbps | `detail` | 3000ms |
| 跨洋、链路差 | SFU | **720p30** | 2.5~3 Mbps | `detail` | 3000ms |
| 看代码／文档 | 任一 | 按窗口 | 5 Mbps | `text` / `detail` | 同上 |
| 看游戏／视频 | 任一 | 1080p60 | 8 Mbps | `motion` | 同上 |

> 经验法则：跨洋场景下"**分辨率降下来、画面干净**"远比"1080p60 满屏马赛克"耐看。

---

## 7. 改动清单（文件 × 函数）

| 文件 | 位置 | 改动 | 批次 | 风险 |
|---|---|---|---|---|
| `App.tsx` | `<RoomView>` 属性 | 补 `sharePc={voice.sharePc}` | 0 | 极低（一行） |
| `use-voice.ts` + `PenTV.tsx` | `sharePubRef` / 灯箱 | 共享者发送端指标面板 | 0 | 低 |
| `screen-share.ts` | 新增 `probeHardwareEncoder()` | WebCodecs 硬编预检 | 0 | 低 |
| `screen-share.ts` | `SHARE_QUALITY_PRESETS` | 720p → 5M、1080p → 8M | 1 | 低 |
| `screen-share.ts` | `applySenderQuality` → `applyScreenSenderParams` | 导出 + 支持码率覆盖 + 删空转字段 + 失败可见 | 1 | 低 |
| `screen-share.ts` | `publishScreen` | 并行化（`Promise.all`）+ `gatherIce` 800ms + 返回 `pc` | 1 | 低 |
| `screen-share.ts` | `contentHint` / 降级阶梯 | 默认 `detail` + `scaleResolutionDownBy` | 1 | 中 |
| `screen-share.ts` | `ontrack` | 抖动缓冲 4000 → 3000（SFU） | 1 | 低 |
| `engine.ts` | `callScreenPeer` | 下发档位 + 人数分摊 + `sdpTransform: preferH264Sdp` | 1 | 中 |
| `engine.ts` | `smoothScreenReceivers` | 4000 → ~500（P2P） | 1 | 低 |
| `use-voice.ts` | 停播分支 | `sharePubRef.current = pub`（修泄漏） | 1 | 低 |
| `settings.ts` + `use-voice.ts` | 传输选择 | 按人数自动 P2P／SFU | 2 | 中 |
| `screen-share.ts` + `protocol.ts` + `use-voice.ts` | simulcast | 多档发布／订阅 + RID 广播 | 2 | **高** |
| `screen-share.ts` + `engine.ts` | 断线 | ICE restart | 3 | 中 |

---

## 8. 需要你拍板的点

1. **起点**：继续完成工作区那 4 个半成品文件，还是先全部还原、按批次重来？
2. **默认分辨率**：跨洋场景接受"默认降到 720p30 + 清晰优先"吗？
3. **默认码率**：1080p60 = **8 Mbps**、720p60 = **5 Mbps**（+2 Mbps 口径）——是否定稿？
4. **传输自动选择**：改成"1~2 人 P2P、≥3 人自动 SFU"吗？
5. **simulcast**：要不要上？（收益最大、工作量最大）
6. **自动行为的提示方式**：人多切 SFU／硬编不可用降档／带宽不足降级 —— UI 提示还是静默？
7. **编码器**：确认"排除 H.265、AV1 只做硬编择优、H.264 保持基线"？
8. **SFU 换国内中继**：要不要排为下一阶段议题？（对 SFU 模式收益最大，也是同类商业软件真正的优势所在）

---

## 9. 实施与回滚

- **每批一次提交**，独立可回滚；
- 每批必须过 `npm run typecheck` + 单测 + 构建；
- **批次 0 单独提交**（纯观测、零行为变更），便于先拿数据再决策；
- **语音零影响是硬约束**：共享链路任何失败都不得影响语音。共享走独立 WebRTC 连接（天然隔离），改代码时**不要破坏这个隔离**。

---

## 10. 实施状态（2026-10-14 落地，源码已改）

**结论：§0~§9 的四个批次已全部实现**，`npm run typecheck` + 155 个单测 + 构建全绿。
下表是"计划 → 实际"的对照；**待现场验收的是读数，不是代码**。

### 10.1 落地清单

| 编号 | 计划项 | 实际实现（文件） |
|---|---|---|
| O-1 | 补 `sharePc` prop | `App.tsx`（一行） |
| O-2 | 发送端自检面板 | `PenTV.tsx` 灯箱数据条改为双向：共享者看**发送端**（编码分辨率/实际码率/限流原因/编码器/单帧耗时/可用带宽），观众看**接收端**（解码器/软硬解/卡顿/丢包） |
| O-3 | 硬编预检 | `probeHardwareEncoders()`（WebCodecs `isConfigSupported({ hardwareAcceleration: "require-hardware" })`，进程内缓存） |
| O-4 | 观众端解码指标 | `summarizeScreenStats()` 输出 `decoderImplementation` / `powerEfficientDecoder` |
| P0-1 | 码率匹配 + 2 Mbps | 720p60 **5 Mbps**、1080p60 **8 Mbps** |
| P0-2 | P2P 真正下发档位 | `engine.screenTuners`：每条画面连接一个调谐器，按观众数分摊（下限 1.2 Mbps），名单变化即时重算 |
| P0-3 | 降级方向走 `contentHint` | 默认 `"detail"`（保清晰），空转的 `degradationPreference` 已删除 |
| P0-4 | 优雅降级阶梯 | `RESOLUTION_LADDER = [1, 1.5, 2, 2.85]`（1080p→720p→540p→380p），540p 以下同时把帧率降到 30 |
| P0-5 | 抖动缓冲分级 | P2P **600ms** / SFU **3000ms**（原为一刀切 4000ms） |
| P0-6 | P2P 拉回 H.264 | `preferH264Sdp` 挂在 `peer.call({ sdpTransform })` |
| P0-7 | 失败不再静默 | `applyScreenSenderParams` 返回 boolean；SFU 发布失败 warn，P2P 2.5s 内一次都没成功则 warn |
| P0-8 | `sharePubRef` 泄漏 | 已赋值；开播失败/被抢占时一并 `stop()` |
| P1-9 | 开播提速 | `gatherIce` 与会话创建 `Promise.all` 并行；ICE 超时 1200 → **800ms** |
| P1-10 | 硬编真预检 + 编码器择优 | 仅当探到 **AV1 硬件编码**才把 AV1 提到 H.264 之前；否则 H.264 基线 |
| P1-11 | 传输自动选择 | `autoTransportFor()`：`auto` 时 1~2 位观众直连、**≥3 人自动 SFU**；菜单里实时显示"本次将用 X：理由" |
| P1-12 | simulcast | 发布端 `sendEncodings`（rid `f`/`h`/`q`，按 1/2/4 缩放）；订阅端声明 `preferredRid: "f"` + `priorityOrdering/ridNotAvailable: "asciibetical"`；`simulcast` 标记随房主广播透传。**发布失败自动回落单档**，整条 SFU 失败再回落 P2P |
| P2-13 | ICE restart 自愈 | `healScreenConnection()`：`disconnected` 等 2.5s → `restartIce()`，`failed` 立即重启，6s 观察窗、最多 2 次；共享者侧超过上限自动**重拨**该成员 |
| P2-14 | 带宽自适应 | 调谐器按 `qualityLimitationReason` 决策：`bandwidth`/`cpu` 连续 2 次受限 → 降一档；连续 6 次健康（≈18s）→ 回升一档 |

### 10.2 与计划的偏差（需你确认）

1. **传输方式默认值改成 `auto`**（原默认是 `p2p`）。旧配置里的 `p2p` 是**当年的默认值**而非用户选择，所以按 `settingsVersion` 迁移到 `auto`；此后再手动选过 `p2p`/`sfu` 就永久保留。→ 如果你希望**保持不变**（旧用户继续走 p2p），把 `loadSettings` 里那段的迁移去掉即可。
2. **AV1 择优只在 SFU 链路生效**。P2P 走的是 SDP 重排（只能把 H.264 提前），没有 `setCodecPreferences` 的插入点；且 P2P 的对端可能是 Safari/iOS。→ P2P 一律 H.264。
3. **simulcast 与自适应阶梯共存时**：simulcast 由 SFU 挑层，`scaleResolutionDownBy` 交给 SFU 的层策略，调谐器只调各层码率与帧率。
4. **新增设置字段 `settingsVersion`**（用于上面的迁移），随设置一起落盘。

### 10.3 验证方式（现场三步）

1. **界面读数**：开播 → 点幕布放大 → 底部数据条应显示
   `[发送端] 发出 1920×1080 · 60 fps · 6000 kbps · H264 MediaFoundation 硬编 · 不受限`。
   - 出现 `CPU 受限` 或 `软编` → 没吃到 NVENC，按 §4.2 排查（先看码率是否低于几 Mbps）；
   - 出现 `带宽受限` → 链路问题，此时应看到分辨率**自动降档**（阶梯生效）。
2. **端到端延迟**：`?tv=demo`（真 SFU 链路）或对共享窗口，用演示流自带的毫秒时钟对表——目标是 P2P < 1s。
3. **人数切换**：3 人以上开播，菜单提示应显示"自动 → SFU"，且共享者上行不再 ×N。

> 仍未做现场实测的部分：真实 3 人以上房间的 simulcast 挑层效果、AMD/Intel 机器上 H.264 硬编的码率上限（§4.2 已知坑）。这两条只能靠上面第 1、3 步的读数判断。
