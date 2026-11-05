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

## 2. AI 降噪：RNNoise 主力（DFN3 暂停，2026-11-05）

**2026-11-05 定稿：RNNoise 主力 → DFN3 兜底（40dB）→ 直通。**
业主实测 DFN3 24dB 压不住游戏声/键盘声（"别人能听见我游戏和键盘声音，很大很清楚"），
RNNoise 恢复主力；DFN3 降为兜底且按业主要求把衰减限幅提到 40dB（"兜底要有兜底的实力"）。

DFN3 基础设施全部保留，重开只改 `engine.ts` 顶部的 `DFN3_ENABLED` 开关：

- 引擎 `denoise-voice-clarity`（MIT），模型 18MB 不随安装包发布，按需从
  `/models/denoise_voice_core_bg.wasm` 下载（桌面端 `https://5blong.site/models/…`），
  存 Cache Storage（`dfn3-model-bytes-v1` + 登记簿 `df-model-ledger-v1`）。
- 服务端：nginx `/models/`（`/var/www/5blong-models/`，已部署，ACAO `*`）。
- 关键参数：`DFN3_ATTENUATION_DB = 40`（业主定的兜底档，原 24 压不住游戏声）。
- 下载对话框恢复弹出：没模型就提醒下载（兜底要有弹药）；没下载时 DFN3 兜底缺位，先直通。
- RNNoise 起不来且 DFN3 失败（没模型）→ 自动登记"模型就绪重试"，模型到位自动切换。
- 闸门测试：`tests/deepfilter-model.test.ts`（换模型/构建坏了直接爆）。

降噪引擎档位（dfn3/rnnoise/passthrough/off）由引擎经 `events.nsEngine` 实时推送，
设置页徽标与房内快速面板徽标据此显示当前模型。

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
