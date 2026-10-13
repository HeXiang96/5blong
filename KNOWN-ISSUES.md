# 5blong 已知缺陷交接单

> ## ✅ 多人加入超时（"第 3、第 4 个人进不去"）已于 2026-10-12 修复
>
> **症状**：房间一开始能进人，访客确认页偶发/频发报"房主没有响应，请确认邀请
> 是否仍然有效"，人越多越容易出现。
>
> **根因**：应用使用免费公共 PeerJS 云（`0.peerjs.com`，Cloudflare 代理），
> 其信令延迟波动很大（浏览器实测 4~35 秒）。访客与房主的 DataConnection 必须在
> `WELCOME_TIMEOUT_MS = 12s` 内完成 offer→answer→ICE→hello→welcome，慢一次就被
> 超时判死；新人进房时若立即向所有成员发起媒体协商，几秒内几十条信令形成风暴，
> 进一步把后续访客的握手拖过超时。
> （排查中一度怀疑 Cloudflare 多源站不共享状态；已用"两浏览器实例分别强制解析到
> 两个 CF IP"的对照实验排除——跨 IP 10 秒可进、同 IP 4 秒可进。Node 裸 socket
> 探测 0/56 是被风控按非浏览器流量降级，与真实用户无关。）
>
> **修复**（`src/client/voice/engine.ts`）：
> 1. welcome 超时不再直接报错：自动**整体重拨**——销毁 Peer、保留麦克风与音频链、
>    以全新访客 ID 重新注册再拨号，最多 3 次（`MAX_DIAL_ATTEMPTS`），全部失败才
>    提示"房主没有响应"；
> 2. 媒体协商**错峰**：与房主的媒体立即建立，访客之间每路间隔 1.2s
>    （`MEDIA_STAGGER_MS`），消除信令风暴；
> 3. 顺带修复被呼应答使用原始流（`onIncomingCall` 改为
>    `answer(this.outgoingStream ?? this.localStream)`），房主/被呼方的 RNNoise
>    降噪与音量增益此前对这一路不生效。
>
> **验证**：typecheck 通过；`tests/engine-join-handshake.test.ts` 5 个测试
> （含超时自动重拨回归）全过；语音相关 98 个测试全过；线上 4 标签顺序加入实测
> 耗时 4.0s / 3.0s / 4.5s，全员 4/8 无超时。已部署 https://5blong.pages.dev
> （版本 https://27a3774c.5blong.pages.dev）。

---

> ## ✅ 本缺陷已于 2026-10-12 修复
>
> **根因（此前第 3 节的疑点全部排除）**：`src/client/voice/engine.ts` 的
> `onGuestData()` 守卫顺序死循环——记录创建时 `joined=false`，而把它置为 `true`
> 的唯一消息 `t:"joined"` 写在 `if (!guest.joined) return` 之后，`case "joined"`
> 永远不可达，访客后续消息全部被丢弃（即实测的 `HOST msg-dropped-not-joined`），
> 进而收不到房主 ping/pong，约 12 秒被访客侧静默超时拆掉。
>
> **修复**：`if (!guest.joined && message.t !== "joined") return;`——只放行
> `joined` 这一条，其余消息仍维持未握手不服务。
>
> **验证**：typecheck 通过；新增 `tests/engine-join-handshake.test.ts`
> （旧代码 2 条全失败、修复后全通过）；已重建 `dist-web/` 并在产物中核对到闸门逻辑。
> **第 7 节的双窗口真机验收尚未执行**，建议上线前补测。
>
> 以下为修复前的原始交接内容，作为历史记录保留。

---

> 本文件是 [README.md](./README.md) 中「⚠️ 待修复：邀请链接加入后，房主侧看不到访客」一节的独立副本，
> 方便直接交给接手修复的人或 AI。**两处内容如不一致，以 README.md 为准。**
>
> 所有"已验证事实"均为 Chromium 双窗口实测结论，不是读代码推测。

---

## 1. 症状

访客用邀请链接进入后：

| 观察点 | 实际表现 |
|---|---|
| 访客侧 | **正常**：显示"已连接 2/8"，能看到房主和自己（说明访客的握手、名册、进房全部成功） |
| 房主侧 | **异常**：人数仍是 `1/8`，看不到访客 |
| 约 12 秒后 | 访客被断开，回到首页并提示"长时间收不到房主响应，连接可能已中断" |

结果：**访客能进房、能看见房主，但房主看不见访客，且十几秒后连接被拆掉——双向通话不可用。**

---

## 2. 已验证的事实（按时间顺序）

1. **访客发得出 hello**：宿主收到 `hello`，`proofLen=43`，随后走通了准入裁决。
2. **宿主发得出 welcome**：宿主侧记录到
   `welcome-send path destroyed=false sameConn=true connOpen=true`，即连接是 open 的、也确实调用了发送。
3. **访客收得到 welcome 且校验通过**：
   `GUEST raw t=welcome keys=t|code|hostId|proof|you|roster`
   → `GUEST parsed=welcome`
   → `GUEST W proof-ok`
   → `GUEST W proceeding`
   即 `parseHostMessage` 成功、`verifyHostProof` 返回 true、`roomKey` 长度 32、nonce 一致。
4. **两侧 WebRTC 都连上了**：宿主侧 trace 有 `PC state=connected`、`CH(remote) OPEN`、`CH(remote) RECV`。
5. **问题出在宿主侧接收访客后续消息**：宿主日志多次出现
   `HOST msg-dropped-not-joined`（消息因"该 peer 未标记 joined"被丢弃）。
6. **零异常**：两个页面的 `window.onerror` / `unhandledrejection` 都是空数组，所以**不是抛异常**，是逻辑分支走错。
7. 访客侧 `status("connected")` 确实触发（这是访客界面正确的直接原因）。

---

## 3. 尚存的疑点（排查入口，均未确认）

> 以下**不是结论**，是还没验证的方向。

* **`joined` 消息是否真的到达宿主？**
  访客在 welcome 分支里紧接着执行 `this.send(e, {t:"joined"})`，
  宿主应通过 `case "joined"` → `announceJoin(conn.peer)` 把访客标记为 joined 并广播 `peer-join`。
  若这条消息没到，或到了但 `peerId` 匹配不上，访客永远不会被标记，宿主名单自然停在 1 人。
* **宿主记录的 `conn` 与收到后续消息的 `conn` 是否同一个对象？**
  `announceJoin` 依赖 `this.guests.get(peerId)` 取到记录。若宿主为同一 peer 建了不止一条
  DataConnection（例如媒体协商过程又开了一条），任一 `conn.on("close")` 触发 `evictGuest`
  就会把刚标记好的记录删掉。**建议优先验证这一点。**
* **`guests` / `members` 是否被误清空？** `evictGuest` 同时删 `guests` 与 `members`，
  一旦被误触发，宿主就会从 2 人退回 1 人。
* 访客 12 秒被断开与宿主侧同步失败**很可能是同一个根因**（宿主不把访客当成员，
  心跳/存活判定便把它当幽灵连接清掉）。

---

## 4. 相关代码位置

| 文件 | 位置 | 作用 |
|---|---|---|
| `src/client/voice/engine.ts` | `onGuestData()` 的 `case "joined"` | 宿主把访客标记为 joined 的唯一入口 |
| `src/client/voice/engine.ts` | `announceJoin()` | 标记 joined 并广播 `peer-join` |
| `src/client/voice/engine.ts` | `evictGuest()` | 删除 `guests` + `members`，**最可疑** |
| `src/client/voice/engine.ts` | `onIncomingConnection()` | 绑定 `data` / `close` / `error` 回调 |
| `src/client/voice/engine.ts` | `tickLiveness()` | 6 秒无 ping 即 `evictGuest` |
| `src/client/voice/engine.ts` | `send()` | 只在 `conn.open` 为真时真正发送（否则静默丢弃） |
| `src/client/voice/use-voice.ts` | `joined` 副作用 | 引擎事件驱动切到房间视图 |

---

## 5. 建议的排查手法

**不要靠读代码猜。** 这个缺陷只能靠运行时打点定位（我用这套方法已经定位了三个前置 bug）：

1. 起一个本地静态服务器伺服 `dist-web/`（不要用 `file://`）。
2. 用 Chrome/Edge 开**两个真窗口**（宿主 + 访客）。
   在同一窗口里导航会把宿主的 peer 一起销毁，**测出来的是假象**。
3. 通过 CDP 驱动：
   * 点「创建语音房」；
   * 拦截 `navigator.clipboard.writeText` 拿邀请链接
     ——**不要用 `readText`**，窗口失焦会被浏览器拒绝；
   * 访客窗口 `location.replace(邀请链接)` 之后**必须再 `location.reload()`**：
     只改 hash 不会重新加载，React 不会重新挂载，确认页根本不会出现。
4. 在**压缩产物**上做字符串替换插桩（`dist-web/assets/index-*.js`），
   把中间值 push 到 `window.__engine`，再用 CDP 读出来。
   注意压缩后变量名会变（例如 `if(n.t===\`joined\`)`），
   插桩前先 `indexOf` 确认真实写法，**不要照抄源码里的文本**。

---

## 6. 已修复的前置缺陷（避免重复排查）

以下三个是本次已修复并已上线的，**它们不是当前症状的原因**；但若回退代码会重现：

1. **PeerJS ID 非法**
   `randomToken` 曾用 base64url，会产出 `-` / `_`；而 PeerJS 的 ID 校验是
   `^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$`，`_` 只能当**单个分隔符**。
   于是 `5b-h-HX4evyEA0_Dm086Y` 这类 ID 会让房主 peer 直接建不起来。
   现已只用字母数字，并有 2000 次抽样的回归测试（`tests/voice-protocol.test.ts`）。
2. **访客卡在确认页**
   切页曾依赖 `join()` 的 promise 返回，而心跳超时可能先拆掉房间，视图就永远停在确认页。
   现已改为由引擎的 `connected` 事件驱动（`use-voice.ts` 的 `joined` 副作用）。
3. **类字段声明顺序**
   `nonces` 曾声明在方法之后；`tsconfig` 开了 `useDefineForClassFields`，
   字段按声明顺序初始化，方法里访问会得到 `undefined`，抛出的 TypeError 又会被
   `void this.sendHello(conn)` 吞掉。现已与其他字段一起声明在类顶部。

---

## 7. 验收标准

用第 5 节的双窗口方法实测，修好后应当看到：

- [ ] 访客：`已连接 2/8`，名单里同时有房主和自己；
- [ ] 房主：`已连接 2/8`，名单里同时有自己和访客；
- [ ] 保持 **60 秒以上**不被断开（当前约 12 秒就断）；
- [ ] 双方互发一条聊天消息，两侧都能看到；
- [ ] 一方点「离开」后，另一方人数在 10 秒内回到 `1/8`。
