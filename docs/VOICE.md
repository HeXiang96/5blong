# 语音链路 · 现行事实源

> 状态：稳定（1.9.23 之后无未修故障）｜基准版本：1.9.26｜最后核实：2026-11-04
>
> 合并自两份原文（1.9.19 语音故障交接、丢包方案），它们只在 `archive/` 里作历史与证据链；
> **改语音前只读本文**。

---

## 0. 三层，务必分清

| 层 | 用什么 | 出问题时的表现 |
|---|---|---|
| 信令 | `wss://5blong.site/peerjs`（自建 peer 服务） | 进不了房、`peer-unavailable`、重拨 |
| 连接 | 自建 RTCPeerConnection（不是全靠 PeerJS 的 call） | "重连中/连接失败"、单向无声 |
| 语音 | `MediaConnection` / audio track | 有连接但没声、断续 |

**"界面写着连接失败，但声音是通的"** 是这一层的经典误判：ICE 已 connected、音频在流，
只是状态字段写错了。诊断包里的 `events` 才是判据。

---

## 1. 1.9.19–1.9.22 修掉的四个真 bug（别再犯）

1. **coturn `user-quota=12`**（1.9.20 真因）：第 13 个人静默连不上中继。
   已抬到 500，并写进 `turnserver.conf`。
2. **SDP 被设两次**（1.9.20）：第二次覆盖第一次，导致协商成功但方向错乱。
3. **"迟到的失败"护栏只护了 `"connected"`**（1.9.22）：
   实际健康值是 `"direct"` / `"relay"`，护栏从未生效 → 一个迟到的 failed 事件把好腿拆了。
4. **补拨巡检不认识自建协商腿**（1.9.22）：`ensureCalls` 每 3 秒对正在握手的腿重复发起，
   每次 18 秒超时后被迫回落 PeerJS（信令 trace 实锤 +20 秒精确回落）。
   另外 ICE 凭据进房后 1–2.5 秒才到，`onIceUpgrade` 无差别拆所有腿 → "连上→1 秒后重连中"闪断；
   已改为**只拆未连通的腿**。

配套：房主关房广播 `room-closed`（访客立刻退，不等 30 秒心跳）；后台幽灵成员
（一人两行）已修；快照带 `ended:true` 让后台立即收尾。

---

## 2. AI 降噪（DeepFilterNet3）

三级降级：**DFN3 → RNNoise → 直通**，任何一级失败都不挡通话。

- 引擎 `denoise-voice-clarity`（MIT），权重烧在 18MB wasm 里，全程本机处理。
- **模型不随安装包发布**（1.9.26 起）：构建期由 vite 插件把库里的
  `new URL(…, import.meta.url)` 改写成哨兵，运行时由 `ns-deepfilter.ts` 拦截 fetch；
  首次使用时**用户点「立即下载」**才从 `/models/denoise_voice_core_bg.wasm` 拉
  （桌面端走 `https://5blong.site/models/…`），存 Cache Storage。
- 缓存位置（桌面端）：`%LOCALAPPDATA%\com.5blong.app\EBWebView\Default\Service Worker\CacheStorage\`
  下那个 18,248,906 字节的文件。
- 判断有没有用上：**房间里没有**「AI 降噪用的是兜底模型（DeepFilterNet 加载失败）」这条提示
  = DFN3 在跑；也可以用 `caches.open('5blong-models')` 查 `dfn3-model-bytes-v1`。
- 关键参数：`attenuationLimitDb = 24`。无限制时模型误判会把人声压掉 50dB+（实测）。
- 闸门测试：`tests/deepfilter-model.test.ts` 在 Node 里跑真 wasm（噪声抑制/人声损耗/
  键盘脉冲/混合信噪比/纯静音），换模型或构建坏了直接爆。

---

## 3. 信令与中继（自建）

- 信令：`worker/signal/`（Cloudflare Worker，`5blong-signal`）。
  **不随 CI 更新**：改完 `npm run signal:deploy`，且顺序必须是**先部署 signal，再 bump**。
- STUN：`stun:5blong.site:3478`、`stun:stun.chat.bilibili.com:3478`。
- TURN：`/ice` 用本地 HMAC 签发（`TURN_SECRET` 与 `turnserver.conf` 的
  `static-auth-secret` 必须一致），3478/5349 + 中继 50000-50999。
- 端口黑名单时代已过（不再依赖 443 伪装），别再往 SNI 分流上想方案。

---

## 4. 排障工具箱

```bash
# 服务端
journalctl -u 5blong-peer --since '-10min' --no-pager | tail -50
journalctl -u coturn    --since '-10min' --no-pager | grep -E 'session .*: usage'
curl -s https://5blong.site/ice            # TURN 凭据是否签发成功

# 客户端
# 设置 → 诊断 → 导出诊断包：包含 events（协商/重拨/回落时间线）、ICE 状态、媒体统计
```

看到"重连中"先看两件事：**ICE 状态**（connected 还是 failed）和**有没有回落 PeerJS 的
`fallback` 事件**。前者健康就说明只是状态字段问题，后者说明自建协商被搅了。

---

## 5. 还没做的

**国内中继 / 丢包治理**（`VOICE-LOSS-PLAN` 的三个方案、成本与推荐路线）见
[ROADMAP.md](./ROADMAP.md) 第 3 节。现状是"能用，弱网下会抖"，不是故障。
