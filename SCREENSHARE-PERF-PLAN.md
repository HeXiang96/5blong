# 共享屏幕性能优化方案 v3

> 状态：**方案稿（只读分析产出，未改动任何源码）**
> 目标：解决两个可复现的真实症状——① 观众端卡顿；② **SFU 模式 1080p 开播画面糊成马赛克**。
> 约束：全程遵守 `SCREENSHARE-PLAN.md §H`——语音零影响，所有改动只落在共享链路内部。
> 本版新增：§3.4「能不能用 Oopz 的 NVENC」——含**推翻此前假设**的发现（Oopz 媒体栈实为腾讯云 TRTC）、NVENC 的编解码器门槛、以及"强制 H.264"必须实测的已知风险。
> v2 内容：§3 SFU 马赛克专项诊断、§4 修复项、§7 配置速查矩阵。

---

## 0. TL;DR

| 症状 | 一句话根因 | 先做哪件事 |
|---|---|---|
| 观众看着卡 | **上行被榨干 + 缓冲给多了 + 码率没真正下发** | P2P 码率下发 + 缓冲按链路分级 |
| SFU 1080p 马赛克 | **链路带宽 < 内容所需码率，而当前配置选择了"保帧率压质量"** | 降级策略改走 `contentHint` + 降级阶梯，别让量化器背锅 |

**两条反直觉但关键的结论**（这是本方案和"堆码率"思路的分水岭）：

1. **B站直播 1080p60 只有 2.64 Mbps 却丝滑**——证明流畅靠"码率匹配内容 + 硬件编码 + CDN 就近 + 大缓冲 + ABR"，不靠堆码率。
2. **SFU 模式下把档位从 20 Mbps 降到 8 Mbps 并不会让马赛克变清晰**——因为瓶颈是链路可达带宽，不是码率上限。真正决定观感的是"**带宽不足时降什么**"：降分辨率（画面小但干净）还是压质量（分辨率高但全是块）。**现在的配置恰好选了后者**，这才是马赛克的直接原因。

---

## 1. 先分清楚：两个症状、两条链路

```
症状 A：观众端卡顿（多见于 P2P 默认模式）
  共享者 ──(上行 ×N)──▶ 观众      问题：上行爆炸 + 缓冲 4s + 档位未下发

症状 B：SFU 模式 1080p 马赛克（本次截图）
  共享者 ──(上行 1 份，跨洋)──▶ Cloudflare SFU ──▶ 观众
                                  问题：跨洋上行带宽不足 → 编码器压质量
```

两者**根因不同、修法不同**，不能混为一谈。下文 §3 走 B，§4 的 P0 批次同时覆盖 A。

---

## 2. 参照系：B站链路 vs 5blong 链路

截图里的 B站实时数据（`sugar daddy` 播放器统计）：

| 项 | B站直播 | 说明 |
|---|---|---|
| Video | 1920×1080, 60FPS | 同样是 1080p60 |
| Download Bitrate | **2.64 Mbps** | **只用 2.64M 就流畅** |
| Codec | `avc1.64002a`（H.264 High / Level 4.2） | 高效编码档 |
| Encoder | `libbs/31.0.0 Live-Hime` | B站自建高效编码链（硬编） |
| Buffer | 1.796s / 5.938s | HLS 大缓冲吸收抖动 |
| Stream Host | `cn-hnld-ct-01-18.bilivideo.com` | 自建 CDN 就近分发 |

```
B站（HLS / TCP，延迟 3~6s）
  推流 ─▶ 服务端转码(高效编码器) ─▶ 自建 CDN 就近 ─▶ 播放器(大缓冲 + ABR)
  抗抖动做在服务端；码率 2.64Mbps 即够 1080p60

5blong（WebRTC / UDP，目标 <1s）
  P2P：共享者 ─(上行×N)─▶ 观众        SFU：共享者 ─(1 份, 跨洋)─▶ Cloudflare ─▶ 观众
  无 CDN / 无转码 / 无 ABR，抗抖动只能做在端侧（发送端码率 + 接收端缓冲）
```

**B站能给我们的两条经验**：码率跟随观感（不是分辨率）、编码器必须真硬编。
**B站不能照搬的一条**：堆缓冲 / 上 CDN 会牺牲实时性——那正是 5blong 的立身之本。

---

## 3. SFU 模式 1080p 马赛克 —— 专项诊断

### 3.0 数据条空白的**确切根因**（已定位：一行 prop 漏传）

**这是所有"看不见数据"现象的真正原因，共享者与观看者都受影响。**

| 环节 | 事实 |
|---|---|
| `use-voice.ts:1037` | 有把 `sharePc` 放进 hook 返回值 ✅ |
| `RoomView.tsx:871` | 有转发给灯箱：`pc={sharePc}` ✅ |
| **`App.tsx:107`** | **`<RoomView …/>` 的属性列表里没有 `sharePc={voice.sharePc}`** ❌ |
| `RoomView.tsx:214` | 声明为 `sharePc?: RTCPeerConnection \| null` —— **可选属性，TS 不报错**，漏传静默通过 |

⇒ 灯箱拿到的 `pc` 恒为 `undefined` → `PenTV.tsx:263` 的 `if (!pc) return` 直接退出 → `stats` 永远是 `""` → **数据条一片空白**。

**修复（一行，纯增量、不涉媒体链路）**：
```tsx
// App.tsx 的 <RoomView> 属性里补上
sharePc={voice.sharePc}
```

> 修好这一行，观众/共享者才能看到"分辨率 / 帧率 / 实际码率 / 编码器"——这是后面**所有优化的验证前提**，否则改完也看不出变化。
> 附带教训：**可选 prop 是"静默失败"的高发区**，这类跨三层传递的调试数据最好做成 required，或直接在灯箱内用 ref 直连。

### 3.1 为什么「SFU + 1080p」会糊成马赛克（按可能性排序）

| | 原因 | 证据 / 位置 |
|---|---|---|
| **A** | **码率目标与真实链路严重脱节（主因）**。SFU 在 Cloudflare 海外边缘，国内家宽上行到海外普遍只有 1~5 Mbps 且抖动大。档位 20 Mbps 只是"上限"，浏览器拥塞控制会把实际编码码率压到链路能承载的水平。**1080p60 的 LoL 画面在 1~2 Mbps 下必然块状** | `screen-share.ts:70`（20 Mbps）+ 跨洋链路 |
| **B** | **降级策略选错了方向**。当前 `contentHint = "motion"`（`screen-share.ts:245`）→ Chrome 采"**保帧率、降质量**"策略：带宽一紧就死保 60fps，把画质往死里压 → 观感就是"糊 + 块" | `screen-share.ts:245` |
| **C** | **`degradationPreference` 是空转**（已查证）：MDN 已标记该字段 **Deprecated**，且兼容表显示 Chrome 对 `RTCRtpSendParameters.degradationPreference` **不受支持**；写在 `encodings[0]` 里同样不生效。想"保清晰"不能靠它，得靠 `contentHint` | `screen-share.ts:104-113` |
| **D** | **`setParameters` 失败被静默吞掉，且只在协商后调一次**。若首次调用时协商未就绪而被拒绝，码率/帧率参数**压根没生效**，档位形同虚设 | `screen-share.ts:115` `.catch(() => {})` |
| **E** | **编码器可能不是硬编**。H264 协商失败会回落 VP8 软编；1080p60 软编在高负载机器上跑不动，编码器为保实时把质量压到极低 → 马赛克 + 卡。Piik 的 ADR-0007 就是为这个坑写的（能力表 ≠ 真能硬编） | `screen-share.ts:206` 只查 `getCapabilities()` |
| **F** | **`scaleResolutionDownBy: 1` 硬顶**：既禁止降分辨率，又把码率上限放得很高 → 全部压力交给量化器 → 块状伪影 | `screen-share.ts:112` |

### 3.2 症状对照口诀（补上 F4 之后就能自查）

```
看共享者灯箱的 outbound-rtp.qualityLimitationReason：
  = "bandwidth" → 链路带宽不足   → 走 F1 / F3 / F7（降码率、降级阶梯、simulcast）
  = "cpu"       → 编码器扛不住   → 走 F5（硬编预检）+ 降档
  = "none" 但实际码率很低        → 参数没生效 → 走 F6（失败可见化 + 重设时机）
再看 frameWidth×frameHeight：
  ≠ 1920×1080 → 说明已被降分辨率（此时"糊"是预期，要去调降级策略）
```

### 3.3 编码器选型评估：能不能换成 H.265 / AV1？（本次新增）

**结论：能换，但「换编码器」治不了你现在这个卡；真正该做的是「按硬件能力择优」，而不是「把 H.264 拿掉」。**

#### 3.3.1 先回答「是不是比 H.264 好」——是，但好在另一个维度

同码率下的客观画质（VMAF，1080p @ 1 Mbps，**离线编码**）：

| 编码 | VMAF | 相对 H.264 |
|---|---|---|
| AV1 (speed 6) | ≈82 | **+21%** |
| H.265 / HEVC | ≈78 | +15% |
| VP9 (speed 4) | ≈75 | +10% |
| **H.264** | **≈68** | 基准 |

换算成直觉：**同等观感，AV1 约省 30~50% 码率，H.265 省 20~40%**。这是真实优势，不是营销话术。

但请注意表头——**这是"离线编码"的成绩**，编码器可以慢慢算。WebRTC 要求帧级延迟 <100ms，实时编码器（含 SVT-AV1）是为**吞吐**优化的、不是为**亚帧延迟**优化的，所以进 WebRTC 后这个优势要打折。

**更关键的一层**：B站那条链路 2.64 Mbps 就能 1080p60 流畅，靠的是「服务端高效编码器 + CDN 就近 + 大缓冲 ABR」三件套。**换编码器只动第一件，而第一件本来就不是你的瓶颈**——§3.1 已定位，你的瓶颈是**跨洋上行带宽**和**降级方向选反**。所以：**换 AV1 很可能让你的马赛克从 `bandwidth` 型变成 `cpu` 型**（软编跑不动），观感未必更好。

#### 3.3.2 再看「能不能换」——浏览器支持是碎的，这才是真卡点

WebRTC 里编码是**双方协商**的：发布端支持还不够，**每一个观众都必须能解码**。而且 **SFU 是「选择性转发」，不逐观众转码**——Cloudflare Realtime 官方支持列表里确实有 H.264 / H.265 / VP8 / VP9 / AV1，但那是"**接入能力**"，不是"它帮你把 H.265 转成大家都能收的格式"。**下限由房间里最弱的那个浏览器决定。**

| 编码 | Chrome | Edge(WebView2) | Firefox | Safari | 在 5blong 里能用吗 |
|---|---|---|---|---|---|
| **H.264** | ✅ | ✅ | ✅ | ✅ | **全平台基线**，硬编普及率最高 |
| VP8 | ✅ | ✅ | ✅ | ✅ | 全平台，纯软编保底 |
| VP9 | ✅ | ✅ | ✅ | ⚠️ 有限 | 主流可用，Safari 不稳 |
| **AV1** | ✅ 编码（屏幕共享已默认启用） | ✅ | ⚠️ 较新版本 | ❌ **WebRTC 会话不协商 AV1** | **半残**：Chrome↔Chrome 可用，Safari 收不到 |
| **H.265** | ✅ 136+（**仅硬编**） | ❌ **从未启用** | ❌ 无计划 | ✅ 18+ | **「全员否决」型**，见下 |

两个要害：

- **H.265 没有软件编码回退**（Chrome 只走硬件）。设备没有 HEVC 硬编时，SDP 里**根本不会出现 H.265**；更糟的是一旦协商上了而对面解不了，结果不是"降质"而是**黑屏**。再叠上 HEVC 有 4 家专利池、成本无法预估的合规问题——**免费项目不要碰**。
- **AV1 在 Safari 的 WebRTC 会话里不协商**（只有 M3+ / iPhone 15 Pro 以上的硬件解码，且 Safari 不在会话里谈 AV1）。而 5blong 是熟人小群，房间里出现一台 iPhone / iPad 是常态。P2P 模式下只要对面是 Safari，AV1 直接谈不成 → 回落 H.264。

#### 3.3.3 代码现状：作者其实已经给 AV1 留了席位

`screen-share.ts:206` 的 `setPreferredVideoCodecs()` 里，排序是：

```
H.264(0)  >  AV1(1)  >  VP9(2)  >  VP8(3)
```

**AV1 已经在第二位了——但它排在 H.264 之后，等于永远不会被选中**（双方都支持 H.264 时协商必然选 H.264）。H.265 连列表里都没有。所以"换编码"在代码上的动作，就是改这个 `score()` 排序函数（外加能力探测），**改动很小**——问题不在工程量，在于**该不该换**。

#### 3.3.4 真正的做法：不换基线，只做「硬编择优」（并入 P1-9）

不要在全局把 H.264 换掉，改成：

```
1. H.264 永远是协商基线（保底：任何房间、任何观众都能出画面）
2. 开播前跑一次硬编探针（P1-9 的 canvas 探针轨）
3. 仅当实测到 AV1 硬件编码（NVENC AV1 / Intel Arc / Apple M3+ / AMD RDNA3）
   → 才把 AV1 提到 H.264 之前
4. 探针结果按 session 缓存；拿不准就用 H.264
```

这正是 2026 年行业推荐的策略（"VP9 优先、VP8 兜底、H.264 保 Safari 通路、**AV1 只在能指纹识别出硬件能力的设备上启用**"）。**收益拿到，兼容性零风险。**

> 附一个真实收益点：AV1 / VP9 支持**空间可分层（SVC）**，而 H.264 在浏览器里只有时间层。这对 §P1-7 的 **simulcast** 有直接影响——如果将来走 simulcast，AV1 / VP9 才能给出真正的"多分辨率档"。这是**考虑 AV1 的正当理由**，但入口是 simulcast，不是"换个编码器"。

#### 3.3.5 一句话回答

- **H.265**：不要。兼容性自伤（Firefox / Edge 全废 + 无软编回退 + 专利不可控），且不治你的卡。
- **AV1**：现在不要全局换。可作为**硬编择优**的候选（探到硬编才用），或等走 simulcast 时再引入。
- **你的卡**：修在 §4 的 P0 批次（码率匹配 / 降级方向 / 缓冲分级 / 上行分摊），**跟编码器无关**。

---

### 3.4 能不能"用 Oopz 的 NVENC"？（本次新增，含一条推翻此前假设的发现）

**先纠正称谓**：NVENC = NVIDIA **En**coder（硬件编码器）；解码那个叫 **NVDEC**。所以问题实际是"共享端能不能用 NVENC 硬编"。

**结论一：不存在"Oopz 的 NVENC"可以借。**
NVENC 是 NVIDIA 显卡驱动内建的硬件编码单元，通过 Video Codec SDK / Windows Media Foundation 暴露给**任何**程序——OBS、Chrome、WebView2、Oopz 一视同仁。没有任何一方独占或需要授权。这条路上 5blong 与 Oopz **起点相同**。

**结论二（推翻此前假设）：Oopz 并没有自研媒体栈。**
公开资料（百度百科 Oopz 词条等）显示：Oopz 客户端为 **Flutter** 开发，音视频能力**采用腾讯云实时音视频 TRTC**。即屏幕共享的编码、拥塞控制、抗丢包、中继全部是**租 TRTC**，不是 Oopz 自己写的。

因此两者差距的真实来源要重新归因：

| 此前的推测 | 实际情况 |
|---|---|
| Oopz 用原生采集，所以更顺 | 采集层（WGC / Desktop Duplication）两者同一套系统 API，**无差距** |
| Oopz 有自研 NVENC | 没有；TRTC 同样使用系统 / GPU 编码单元 |
| — | **TRTC 有国内就近接入节点**；5blong 的 SFU 第一跳是 Cloudflare **海外边缘** ← 跨洋码率上不去的根本原因 |
| — | **TRTC 走服务端中转**；5blong 的 P2P 是共享者上行 ×观众数 |
| — | TRTC 十余年积累的拥塞控制与抗丢包 |

> **要抄 Oopz，该抄的是"换成国内中继"（见 §P1-11 的延伸议题），不是抄它的编码器。**

**结论三：NVENC 的门槛恰好落在 P2P 的伤口上。**
NVENC 官方支持列表只有 **H.264 / HEVC / AV1** 三种编码格式；**VP8、VP9 只有 NVDEC 支持解码，没有硬件编码器**。于是：

- PeerJS 默认协商到 **VP8** → 全世界没有 VP8 硬件编码器 → 只能 libvpx **软件编码** → 1080p60 软编必然保不住画质。**"P2P 也糊"因此在物理层面被锁死。**
- 反过来说，**"用上 NVENC" == "把协商的编解码器改成 H.264"**——正是工作区已改的 `preferH264Sdp`（把 m=video 里的 H264 载荷类型稳定排序到最前）。工作量是"改协商顺序"，不需要 Oopz 的任何东西。

**已核实的 Chrome / WebView2 硬编路径**（Chromium 提交 "Enable H.264 hardware MFT encoder on Windows"）：

```
Chrome WebRTC → Windows Media Foundation 的 H.264 编码器 MFT → GPU 驱动 → 硬件编码单元
优先级：AsyncMFT（硬件） > LegacyMFT > OpenH264（软件兜底）
```

NVIDIA 卡上落到 NVENC，`getStats` 中应出现 MediaFoundation 系实现 + `powerEfficientEncoder: true`。桌面端 Tauri / WebView2 与网页版共用同一份前端产物，**同一条路径、同一处修复**。

**⚠️ 必须警惕的坑（决定性影响 `preferH264Sdp` 的验收）**
"强制 H.264"不是免费午餐。多家 RTC 厂商（即构、Flashphoner）都有记录的已知问题：**AMD 全线 + 部分 Intel 的 Windows 设备上，Chrome 使用 H.264 硬编时发送码率上不去**，症状恰好是"画面模糊、webrtc-internals 里码率不足 100 kbps"，根因在 GPU 驱动层对编码码率做了限制。Chromium 的应对是新增 `MediaFoundationUseSWBRCForH264Desktop`（让 Chromium 自己的**码率控制器**接管；注意 "Software" 指码率控制器，**不是**放弃硬件编码）。测试数据：600 Kbps 上行约束下 2.01 fps，对比旧 OpenH264 路径的 0.91 fps。

补充：**码率设得过低（低于几 Mbps）时 NVENC 也可能不被选中** —— 这反向印证了"码率 +2 Mbps"的方向是对的，而不是多余。

结论：**NVIDIA 卡可以走也应该走；但"设完就以为好了"是错的，必须实测。**

**新增验收三读数**（并入 §5）：
1. `encoderImplementation`（或 `chrome://webrtc-internals` 的 `videoEncoderImplementationName`）→ 期望含 MediaFoundation / Hardware / NVIDIA；
2. `powerEfficientEncoder` → `true`；
3. `averageEncodeTime`（= `totalEncodeTime / framesEncoded`）→ 低而稳；升上去即为 CPU 瓶颈。
若三者仍为软件：按序排查 ① 码率是否低于几 Mbps；② 采集帧尺寸是否为 NVENC 不接受的"怪尺寸"；③ **SDP 中的编解码器是否被排回 VP8/VP9**（`preferH264Sdp` 需要验的就是这一点）。

**P1-9 的更好实现（替换原设计）**
原 P1-9 打算用 canvas 假轨道 + `getStats` 探测硬编。更干净的做法是 **WebCodecs**：

```js
await VideoEncoder.isConfigSupported({
  codec: "avc1.640028", width, height, bitrate, framerate,
  hardwareAcceleration: "require-hardware",
});
```

一句调用即可问系统"这台机器有没有 NVENC 能编这个配置"，**不必建连接、不必跑假流**，开播前几十毫秒拿到答案，再决定是否把 H.264 提到首位。

---

## 4. 修复方案

### 批次 1（P0）— 覆盖症状 A + B 的主因

#### P0-1 码率从"堆高"改成"匹配"（`screen-share.ts`）
```ts
export const SHARE_QUALITY_PRESETS = {
  hd720:  { width: 1280, height: 720,  fps: 60, maxBitrate: 5_000_000 },  // 原 8M
  fhd1080:{ width: 1920, height: 1080, fps: 60, maxBitrate: 8_000_000 },  // 原 20M
};
```
- 依据：B站 1080p60 实测 2.64 Mbps 流畅；屏幕共享以 UI/文字/视频为主，H.264 High 8 Mbps 已近肉眼无损。
- **取值口径（业主定）**：在"匹配链路"的基线上（3M / 6M）**统一上浮 2 Mbps** 留运动画质余量 → 5M / 8M。仍远低于原来的 8M / 20M，上行压力可控。
- **注意**：这一步**不会**让 SFU 马赛克变清晰（瓶颈是链路），它的作用是①避免上行过冲；②给编码器一个理性目标。真正治马赛克的是 P0-3 / P0-4。

#### P0-2 让 P2P 真正下发码率（`engine.ts`）—— 治症状 A
`callScreenPeer()` 里 `peer.call()` 之后**没有任何参数下发**（`engine.ts:1935-1946`），而 `applySenderQuality` 只在 SFU publish 调（`screen-share.ts:288`）→ P2P 模式走浏览器默认。
```ts
const call = this.peer.call(peerId, this.screenStream, { metadata: {...} });
const pc = (call as any).peerConnection as RTCPeerConnection | undefined;
const bitrate = shareBitrateFor(this.screenQuality, "p2p", this.members.size - 1);
if (pc) { applyScreenSenderParams(pc, bitrate, 60); call.on("open", () => applyScreenSenderParams(pc, bitrate, 60)); }
```
并在**成员人数变化**时重算重设（人变多 → 每路自动降码率）。
> `smoothScreenReceivers()` 已在用 `call.peerConnection`，说明这条通路可行。

#### P0-3 降级策略改走 `contentHint`（`screen-share.ts`）—— 治症状 B 的关键
`degradationPreference` 已失效（见 §3.1-C），**真正生效的开关是 `contentHint`**：

| 内容类型 | contentHint | Chrome 行为 |
|---|---|---|
| 游戏 / 影视（要流畅） | `"motion"` | 带宽不足时保帧率、降分辨率 |
| 代码 / 文档 / PPT（要清晰） | `"detail"`（或 `"text"`） | 带宽不足时保分辨率、适度降帧 |

**建议：跨洋 SFU 场景默认"清晰优先"**。因为链路必然不够，保 60fps 只会把画面压成马赛克；保分辨率 + 降到 30fps 反而更耐看。做法：把 `contentHint` 提成用户可选档位（"流畅优先 / 清晰优先"），并让它在 `getDisplayMedia` 后、发布前设置。

#### P0-4 用 `scaleResolutionDownBy` 做"优雅降级阶梯"（`screen-share.ts`）—— 治症状 B
目标：带宽不足时按 `1080p → 900p → 720p → 540p` **降分辨率**，而不是把 1080p 压成马赛克。
```ts
// 依据 outbound-rtp.qualityLimitationReason === "bandwidth"
// 与 candidate-pair.availableOutgoingBitrate，动态调 scaleResolutionDownBy + maxBitrate
params.encodings[0].scaleResolutionDownBy = Math.max(captureH / targetH, 1);
await sender.setParameters(params);
// 兼容写法：scaleResolutionDownBy 为 1 时用 applyConstraints 兜住真实高度（MDN 推荐）
if (sender.getParameters().encodings[0].scaleResolutionDownBy === 1) await track.applyConstraints({ height: targetH });
```

#### P0-5 抖动缓冲按链路分级（`screen-share.ts` + `engine.ts`）—— 治症状 A
```
SFU（跨境，抗抖动）  → 3000ms（原 4000）
P2P（同网直连）      → 400~600ms   ← 关键改动，端到端打进 1s 内
```

#### P0-6 让数据条真正亮起来（`App.tsx` 一行 + 补共享者指标）—— 观测前提（见 §3.0）
- **第一件事（一行）**：`App.tsx` 的 `<RoomView>` 补 `sharePc={voice.sharePc}` —— 修好这一行，**观众端数据条立刻可用**。
- 第二件事：`publishScreen` 返回值增加 `pc`（或 `getStats` 句柄），`use-voice` 存进 `sharePubRef`，灯箱对**共享者**显示**发送端**指标：
  - `outbound-rtp`：实际码率、`frameWidth×frameHeight`（编码器真实输出）、`framesPerSecond`、`qualityLimitationReason`、`encoderImplementation`；
  - `candidate-pair`：`availableOutgoingBitrate`、RTT。
- 有了它，"卡/糊"才能从"感觉"变成"读数"。

### 批次 2（P1）

#### P1-7 SFU 模式改用 **simulcast 多档**（结构性最优解，官方已支持）
Cloudflare Realtime SFU 原生支持 simulcast（已核实官方文档）：
```ts
// 发布侧：改成带 sendEncodings 的 addTransceiver
peerConnection.addTransceiver(track, {
  direction: "sendonly",
  sendEncodings: [
    { rid: "f", scaleResolutionDownBy: 1 },
    { rid: "h", scaleResolutionDownBy: 2 },
    { rid: "q", scaleResolutionDownBy: 4 },
  ],
});
// 订阅侧：tracks/new 带 simulcast 对象
{ tracks: [{ location: "remote", sessionId, trackName: "screen",
  simulcast: { preferredRid: "f", priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" } }] }
```
- **收益**：共享者只推 1 组（上行上限约 1.25× 单档），**SFU 按每个观众的网络自动选层**——正是 B站 ABR 的思路，直接解决"别人看着卡/糊"，且不炸上行。
- **必须注意的坑（官方文档明确）**：`priorityOrdering` 与 `ridNotAvailable` **默认都是 `none`**，不改的话带宽不足时 SFU 仍死推最高层 → 反而更卡。**必须显式设成 `asciibetical`**。
- **代价**：改 `publishScreen` 的 transceiver 创建；`ScreenShareState` 增加 RID 字段随广播下发；订阅侧带上 simulcast 对象。属于本方案里最大的一次结构改动。

#### P1-8 开播/开看并行提速（`screen-share.ts`）
```ts
const [_, session] = await Promise.all([gatherIce(pc), postJson("/sessions/new", null)]);
```
`gatherIce` 超时 1200 → 800ms；订阅侧同样把 `/sessions/new` 提前。开播少等约 1s。

#### P1-9 H264 硬编真预检（ADR-0007）
**推荐改用 WebCodecs 单次询问（见 §3.4，比假轨道探针干净得多）**：

```js
await VideoEncoder.isConfigSupported({
  codec: "avc1.640028", width, height, bitrate, framerate,
  hardwareAcceleration: "require-hardware",
});
```

备选（老办法）：canvas 探针轨实测 1~2s，读 `outbound-rtp.encoderImplementation`，含 `hardware`/`NVENCC`/`QSV`/`VTB`/`MediaFoundation` 才认定硬编；不达标就**别迷信 H264**，改走 VP8/VP9 或直接降档 720p。结果按 session 缓存。

**已知风险（见 §3.4）**：AMD 全线 + 部分 Intel 的 Windows 设备存在"Chrome H.264 硬编码率上不去"的历史问题；因此预检不能只看"支持硬编"，还要在开播后 5s 用 `getStats` 复核实际码率是否达到档位期望，达不到则降级。

**同一套探针顺带解决编码器择优（见 §3.3.4）**：探到 AV1 硬件编码（NVENC AV1 / Intel Arc / Apple M3+ / RDNA3）时，把 `setPreferredVideoCodecs()` 的 `score("video/av1")` 从 1 提到 -1（排在 H.264 之前）；否则维持现状。探针拿不准一律回落 H.264。

#### P1-10 参数下发失败可见化（`screen-share.ts`）
- `applySenderQuality` 改为：`connectionState === "connected"` 后再设一次；
- `setParameters` 失败**不再静默**（`screen-share.ts:115`）：debug 打日志，界面提示"画质参数未生效"。

#### P1-11 传输方式按人数/链路自动选择（`use-voice.ts` + `settings.ts`）
观众数 ≥ 3（或 `availableOutgoingBitrate` 不足）→ 建议/自动切 SFU；保留手动覆盖。回归 `SCREENSHARE-PLAN §1` 的本意。

### 批次 3（P2）

#### P2-12 断线自愈（`screen-share.ts` + `engine.ts`）
- SFU publish：`disconnected` → 先 `pc.restartIce()`（或重建 offer with `iceRestart: true`），等 2~3s 未恢复才雪花 + 重连；
- P2P：`disconnected` 给 3s 自愈窗口；`failed` → 该成员标记"回退 SFU"（混合模式）。

#### P2-13 发送端带宽反馈自适应
每 2~3s 读 `qualityLimitationReason`，持续 `bandwidth` → 自动下调档位/触发降级阶梯/提示切 SFU。

---

## 5. 验收标准（可测）

| 指标 | 现在 | 目标 | 怎么测 |
|---|---|---|---|
| 灯箱数据条 | **空白**（App.tsx 漏传 prop） | 有分辨率/帧率/实际码率/编码器 | P0-6（一行） |
| SFU 1080p 画面 | 块状马赛克 | 干净（链路差时是"降清晰度"不是"马赛克"） | 目检 + `frameWidth` |
| `qualityLimitationReason` | 未知 | 跨洋应为 `bandwidth`（若 `cpu` → 硬编没生效） | P0-6 |
| P2P 端到端延迟 | ≥4s | **<1s** | `?tv=demo` 演示流**自带毫秒时钟**（`screen-share.ts:476`），对面读秒 |
| 3 人房间共享上行 | 打满/丢包 | ≤ 可用上行 60% | `availableOutgoingBitrate` |
| 网络抖动 3s 恢复 | 永久雪花 | <5s 自动恢复 | 断网 3s 再恢复 |

冒烟闸门：`npm run check`（typecheck + 单测 + 构建）；发版 `npm run bump -- x.y.z`。

---

## 6. 改动清单（文件 × 函数）

| 文件 | 位置 | 改动 | 优先级 | 风险 |
|---|---|---|---|---|
| `screen-share.ts` | `SHARE_QUALITY_PRESETS` | 码率 8M/5M | P0 | 低 |
| `screen-share.ts` | `applySenderQuality` | 导出 + 删失效的 `degradationPreference` + 重设时机 + 失败可见 | P0 | 低 |
| `screen-share.ts` | `publishScreen` | 暴露 `pc`；`Promise.all` 并行；gatherIce 800ms | P0 | 低 |
| `screen-share.ts` | `contentHint` / 新增降级阶梯 | 清晰优先档 + `scaleResolutionDownBy` 阶梯 | P0 | 中 |
| `screen-share.ts` | 订阅 `ontrack` | jitterBufferTarget 4000→3000 | P0 | 低 |
| `engine.ts` | `callScreenPeer` | 下发码率 + 人数变化重算 + `sdpTransform: preferH264Sdp`（把协商从 VP8 拉回 H.264，才可能吃到 NVENC，见 §3.4） | P0 | 中 |
| `engine.ts` | `smoothScreenReceivers` | 4000 → ~500（P2P） | P0 | 低 |
| **`App.tsx`** | `<RoomView>` 属性 | **补 `sharePc={voice.sharePc}`（修复数据条空白）** | **P0** | **极低（一行）** |
| `use-voice.ts` + `PenTV.tsx` | `sharePubRef` / 灯箱 | 共享者侧发送端指标 | P0 | 低 |
| `screen-share.ts` + `protocol.ts` + `use-voice.ts` | simulcast | 多档发布/订阅 + RID 广播 | P1 | **高** |
| `screen-share.ts` | `setPreferredVideoCodecs` | 硬编探针 | P1 | 中 |
| `use-voice.ts` + `settings.ts` | `shareTransport` | 人数阈值自动选 SFU | P1 | 中 |
| `screen-share.ts` / `engine.ts` | `onLost` / P2P call | ICE restart + 自愈窗口 | P2 | 中 |

> 全程不触碰语音链路（PeerJS PC、成员表、通话生命周期），符合 §H。

---

## 7. 配置速查矩阵（拍板用）

| 场景 | 传输 | 分辨率/帧率 | 码率上限 | contentHint | 缓冲 |
|---|---|---|---|---|---|
| 2~3 人、同网 | P2P | 1080p60 | 8 Mbps（按观众数分摊） | 按内容选 | 600ms |
| 3 人以上 | SFU | 1080p60 | 8 Mbps | 按内容选 | 3000ms |
| 跨洋 SFU、链路差 | SFU | **720p30**（或 900p30） | **1.5~2.5 Mbps** | `detail` | 3000ms |
| 看代码/文档 | 任一 | 按窗口 | 8 Mbps（`text` 下实际远低于此） | `text` / `detail` | 同上 |
| 看游戏/视频 | 任一 | 1080p60 | 8 Mbps / 720p60 5 Mbps | `motion` | 同上 |

> 经验值：**跨洋链路下 "720p30 @ 1.5 Mbps" 的观感远好于 "1080p60 @ 1.5 Mbps"**——分辨率降下来、画面干净，比高分辨率满屏马赛克耐看得多。

---

## 8. 分阶段落地

- **批次 1（P0）**：码率匹配 + P2P 下发码率 + 缓冲分级 + **降级策略改 contentHint + 降级阶梯 + 发送端自检面板**。一次发版，覆盖两个症状的主因。
- **批次 2（P1）**：simulcast 多档（结构性最优，改动最大，建议单独发版验证）、并行提速、硬编预检、传输自动选择。
- **批次 3（P2）**：断线自愈 + 带宽自适应。

每批次独立可验证、可回滚（都是共享链路内部改动，回滚 = `git revert` 该批次提交）。

---

## 9. 需要你拍板的点

1. **SFU 马赛克**：接受"跨洋场景默认降到 720p30 + 清晰优先"吗？（链路不够时死守 1080p60 必然马赛克）
2. **simulcast**：要不要上？（收益最大但要改发布/订阅/协议三处，工作量最大）
3. **默认码率**：1080p60 默认 **8 Mbps**、720p60 默认 **5 Mbps**（业主口径：基线统一上浮 2 Mbps）——是否足够？
4. **P2P 是否仍作默认**：改成"1~2 人 P2P、3 人以上自动 SFU"更稳——是否采纳？
5. **自动行为**：人多自动切 SFU / 硬编不可用自动降档 / 带宽不足自动降级——需要 UI 提示还是静默处理？
6. **编码器（见 §3.3）**：确认按「H.265 排除、AV1 只做硬编择优（并入 P1-9）、H.264 保持协商基线」执行？
7. **NVENC / Oopz 那条线（见 §3.4）**：确认这三句——① "Oopz 的 NVENC"不存在（NVENC 属 NVIDIA，人人可用）；② Oopz 的真实优势来自 **TRTC 的国内就近中继**，而非编码器；③ 因此近期动作是"把协商改成 H.264 + 用 getStats 实测确认真的落到硬编"，**而不是**自研采集。另需决策：**要不要把"SFU 换国内中继/自建 TURN"排为下一阶段议题**（这才是对 SFU 模式收益最大的一项）。
