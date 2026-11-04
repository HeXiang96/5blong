# 梗王对局 · 联网方案对比与推荐（2026-11-04）

> 目标：把已经做好的单机对局接成真人对战，并且解决三个已经暴露的问题：
> 1. 邀请发不出去（现在点了只是自己开一层界面）；
> 2. 对方点「退出对局」，人还在房间里，我这边收不到；
> 3. 四个人在房里，两个人打牌，不能影响另外两个人。
>
> **前置结论：不碰 `protocol.ts`，也不碰 `engine.ts`。** 理由见第 4 节。

---

## 1. 一句话推荐

**走 ECS 上的 HTTP 信使（`/api/duel/*`）**，服务器只做收发、不懂规则；房主在自己机器上跑引擎并上传快照，访客上传意图。

这不是因为「服务器比较稳」，而是因为**你们的房间是星型拓扑**——这条决定性地排除了另外两个方案。

---

## 2. 三个方案

### 方案 A · ECS HTTP 信使（推荐）

新增 `server/src/duel.mjs`（Express 路由）+ `duel_sessions` 一张表；客户端加一个 `duel-net.ts`，1.2 秒轮询一次。

| 项 | 结果 |
|---|---|
| 改 `protocol.ts` | **不改** |
| 改 `engine.ts` | **不改** |
| 改语音链路 | 零（连 DataConnection 都不碰） |
| 拓扑限制 | 无（谁和谁打都行） |
| 「人还在房间但退出」 | 服务端记 `host_left` / `guest_left`，对方下一轮就收到 |
| 四人房隔离 | 天然（详见第 6 节） |
| 延迟 | 一次操作最坏 1.2 秒上屏（回合制无感） |
| 服务器成本 | 一局约 500 次小请求，自己的机器，可忽略 |

### 方案 B · 复用现有 DataConnection（要改 protocol + engine）

把 `duel:*` 消息挂在现在跑聊天/笔迹/roster 的那条连接上。

| 项 | 结果 |
|---|---|
| 改 `protocol.ts` | 追加消息类型 + 两个解析函数，约 40 行 |
| 改 `engine.ts` | 两个 `switch` 各加一个 case，约 40 行 |
| **致命问题** | **访客之间没有连接** |

第 4 节会展开：`engine.ts` 里是 `handleHostMessage` / `handleGuestMessage` 两个方向，说明这条连接是 **房主 ↔ 访客** 的星型，访客 A 和访客 B 之间根本不连通。所以「A 邀请 B」要么绕房主转发（得改 engine 的转发分支），要么另建连接（那就变成方案 C）。**看起来只改 80 行，实际要改的是拓扑。**

### 方案 C · 独立 Peer（像开黑圈那样）

每局另起一个 `5b-duel-*` 的 PeerJS 连接。

| 项 | 结果 |
|---|---|
| 改 `protocol.ts` / `engine.ts` | 不改 |
| 额外成本 | 每局一次信令握手；必须记得 `destroy()`，否则每局漏一条连接 |
| 断线行为 | 连接断了就断，没有「刚才那步」可补 |
| 谁跑引擎 | 还是房主权威，跟 A 一样需要自己写同步层 |

比 B 干净，但比 A 多一层连接生命周期要管，且失去「状态可回查」这个能力（A 的快照天然存在服务器上，对方刷新一下就能追上进度）。

---

## 3. 推荐方案怎么跑

```
① 房主点对方 → 成员卡「梗王对局」
   POST /api/duel/invite   { room, guestId, gameId }
   服务器写一行 phase='invite'，3 分钟有效

② 对方客户端轮询到 phase='invite' → 弹窗「XXX 邀你来一局」
   接受 → POST /api/duel/poll { gameId, cmd:'accept' } → phase='playing'
   拒绝 → cmd:'decline' → phase='cancelled'

③ 对局中：两端都每 1.2 秒 POST /api/duel/poll
   房主：带上自己的快照（version+1）       → 服务端存，别人取
   访客：带上自己的意图 { play: 3, target } → 服务端存，房主取走后执行
   轮询响应只带「比客户端手里新的」state，没变化就是几百字节

④ 任何一方退出（点按钮 / 关页面）
   点按钮  → cmd:'leave' → 置 left 标记 → 对方下一轮立刻收掉
   关页面  → 停止轮询 → 对方看到「对手已掉线 15 秒」，可以选择等或退
```

**谁说了算**：房主。引擎只在房主机器上跑，访客的操作是「申请」，房主执行完把结果发回去。好处是两端永远不可能算出两个不同的结果；坏处是房主掉线这局就没了——对回合制可以接受。

---

## 4. 为什么这次一行都不碰 `protocol.ts` / `engine.ts`

先正面回答你的担心：**就算改了也不会废语音**，因为音频走的是另一条链路：

| 链路 | 用什么 | 我们会碰吗 |
|---|---|---|
| 语音 | `MediaConnection`（RTCPeerConnection + audio track） | **不碰**，不重协商 SDP、不换 codec、不触发 ICE restart |
| 数据 | `DataConnection`（聊天 / 笔迹 / roster） | **不碰** |
| 信令 | 进房时握手一次 | **不碰** |

而且消息层本身是有兜底的：`protocol.ts` 的 `parseGuestMessage` / `parseHostMessage` 遇到不认识的类型返回 `null`，`engine.ts` 两处分发的 `default` 都是 `break`（我逐行看过，1964 和 3384 行）。所以「新增一个消息类型」对老客户端就是**静默忽略**，这也是你们之前加 `hoist` / `party` 时用过的路子。

**但这次不用改，是因为拓扑，不是因为风险低。**

`engine.ts` 里两个方向的方法名说明了结构：

```
handleHostMessage(...)   // 房主收到的消息
handleGuestMessage(...)  // 访客收到的消息
```

这是**星型**：所有访客只跟房主说话，访客之间没有任何连接。于是「A 和 B 对局」在 B 方案里会遇到一个绕不过去的问题——A 的消息到不了 B，必须**经房主转发**，而房主的转发链路（roster / 权限 / 房间态）恰好是最不该动的那部分。

回合制和 HTTP 反而是天生一对：回合一秒内不结算完全没感觉，而 HTTP 天然支持「重试、回查、断线重连后追进度」，这些用长连接都要额外写。

---

## 5. 接口契约

### 表（`server/db/schema.sql` 追加）

```sql
CREATE TABLE IF NOT EXISTS duel_sessions (
  id TEXT PRIMARY KEY,              -- 局 UUID，客户端生成（不可猜）
  room_code TEXT NOT NULL,          -- 限定房间：邀请只投给同房间的人
  host_id TEXT NOT NULL,            -- 都是客户端本地生成的 clientId（未登录也能玩）
  host_name TEXT NOT NULL,
  guest_id TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'invite',   -- invite | playing | over | cancelled
  version INTEGER NOT NULL DEFAULT 0,     -- 房主快照版本，每次 +1
  state TEXT,                       -- 房主上传的引擎快照（JSON）
  action TEXT,                      -- 访客上传的意图（JSON）
  action_seq INTEGER NOT NULL DEFAULT 0,
  host_seen_at INTEGER NOT NULL DEFAULT 0,  -- 心跳：判「对方是不是关了页面」
  guest_seen_at INTEGER NOT NULL DEFAULT 0,
  host_left INTEGER NOT NULL DEFAULT 0,
  guest_left INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 三个接口（都是 POST，都带 `clientId`）

| 接口 | 作用 |
|---|---|
| `/api/duel/invite` | 建一行 `phase='invite'`。先查双方是否已在别的局里，是就 409 |
| `/api/duel/poll` | **一次往返同时完成拉和推**：带 `cmd`（accept/decline/leave）、`state`（房主）、`action`（访客）、`sinceVersion`（只要更新的快照） |
| `/api/duel/leave` | 显式退出，给 `sendBeacon` 那种读不到响应的场景用 |

`poll` 的返回：

```json
{ "session": {
    "role": "host|guest", "phase": "playing", "version": 7,
    "state": { ... },            // 仅 guest 且 version 变新时才有
    "action": { ... },           // 仅 host 且有待办动作时才有
    "opponentName": "测", "opponentLeft": false, "opponentIdleMs": 800
} }
```

访问控制只有一条：**只有 `host_id` / `guest_id` 本人能读写自己那一行**，`gameId` 是不可猜的 UUID。

---

## 6. 四人房为什么不会互相影响

这一条要分两半看，因为「房间变暗」和「对局状态」是两件事。

**① 变暗只发生在本机。** 覆盖层是 React 组件，`duelTarget` 是每个客户端自己的 state：

```tsx
{duelTarget ? <DuelOverlay ... /> : null}
```

C 和 D 的 `duelTarget` 一直是 `null`，所以他们的页面**根本不会渲染这一层**，不存在「被别人打牌搞黑」的可能。他们照常说话、照常走动。

**② 状态只有两个人拿得到。** 服务端那一行只对 `host_id` / `guest_id` 开放，C 拿 `gameId` 去查也是 403。

**③ 邀请是定点的。** `invite` 写的是具体的 `guestId`，轮询时 `WHERE guest_id = 我`，C 收不到别人的邀请。

顺带一个边界：A 正在打时，C 邀请 A → 服务端返回 409「对方已在另一局里」，不会出现 A 同时被两局拉走。

---

## 7. 客户端怎么落

```
src/client/duel/
  duel-cards.ts     已有
  duel-engine.ts    已有（只加 snapshot / restore 两个方法，别的不动）
  duel-net.ts       新增：Transport 抽象 + 两个实现
  DuelOverlay.tsx   已有，加 role / perspective / 动作转发
  duel.css          已有
```

`duel-net.ts` 里按你们**账号那套现成惯例**做两份实现：

| | 生产 | 本地 dev |
|---|---|---|
| 实现 | `RemoteDuel`：`fetch('/api/duel/*')`，桌面端走 `https://5blong.site/api/duel` | `LocalDuel`：`localStorage` + `BroadcastChannel` |
| 怎么测 | 真机两人 | **开两个标签页等于两台设备** |

跟 `WorkerAccountAdapter` / `LocalAccountAdapter` 的取舍完全一致，不需要新概念。

**视角翻转**：房主视角是 `players[0]`，访客看到的是同一份快照但要镜像（自己的手牌在下方）。做法是在渲染层加一个 `perspective`，`side === perspective` 就是「我」。引擎里加一个 `mySide` 字段给 `isMyTurn()` 用，卡牌结算逻辑一行不动。

---

## 8. 落地顺序

| 阶段 | 做什么 | 能不能单独验收 |
|---|---|---|
| P0 | `server/src/duel.mjs` + 表 + 三个接口；`server/scripts/selftest.mjs` 加用例 | 能（curl 打一遍） |
| P1 | `duel-net.ts` + `LocalDuel`；房主/访客模式接进 `DuelOverlay` | 能（两个标签页打一局） |
| P2 | 邀请弹窗 / 等待中 / 拒绝 / 掉线提示 | 能 |
| P3 | 换成 `RemoteDuel`，在 ECS 上跑通 | 能（两台设备） |

P0 和 P1 可以并行做，互不依赖。

---

## 9. 验收清单（每条都要能当场演）

- [ ] 两个标签页：A 邀请 B → B 弹出邀请 → 接受 → 双方进入同一局
- [ ] B 拒绝 → A 立刻看到「对方拒绝了」
- [ ] A 出牌 → B 在 1.5 秒内看到同一张牌、同一血线
- [ ] **A 点「退出对局」但人还在房间 → B 立刻看到对局结束**（这次要修的就是这条）
- [ ] A 直接关标签页 → B 15 秒内看到「对手已掉线」
- [ ] 四人房：A、B 打牌，C、D 的页面**完全不变暗**，语音正常，且 C 邀请 A 会被告知「对方在另一局里」
- [ ] 对局全程：双方语音不断、不卡、没有回声
- [ ] 一局结束后 `duel_sessions` 那行在 2 小时内被清掉

---

## 10. 已知代价（提前说，别到时候觉得是 bug）

1. **房主掉线 = 这局没了**。房主是权威，没有第二个执行者。回合制下接受这个取舍，比做双端一致性便宜得多。
2. **最坏 1.2 秒延迟**。轮询间隔就是这个数。想更快可以压到 0.6 秒，代价是请求翻倍（自己的机器，其实扛得住）。
3. **本地 dev 的 `/api/duel` 是假的**（BroadcastChannel）。它能验流程和交互，验不了真实网络抖动 —— 那部分要到 ECS 上用两台设备测。
4. **对局状态存在服务端**，理论上服务器管理员能看到两个人在打什么牌。内容本身就是公开梗，不算敏感数据；如果介意，快照可以只存双方可见字段。
