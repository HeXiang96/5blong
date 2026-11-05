# 梗王对局（房间内 1v1 卡牌）· 现行事实源

> 状态：已上线（1.9.26）｜基准版本：1.9.26｜最后核实：2026-11-04
>
> 本文合并了原来的三份设计与施工记录（对局接入方案、联网方案、上线收尾交接）。
> 那三份只是过程，**要改对局代码只看本文**；原文在 `archive/` 里备查。

---

## 1. 一句话

点房间成员的猪 → 成员卡「梗王对局」→ 对方接受 → 两人开打，**语音全程不断**。
服务器只做收发（ECS `/api/duel/*`），**规则与结算全在发起方本机跑**。

---

## 2. 三条不能破的红线

1. **不碰 `src/client/voice/protocol.ts`**。
2. **不碰 `src/client/voice/engine.ts`** 的语音/名册/转发逻辑。
   （对局只用到 `members` 名册和 `personId`，不新增消息类型。）
3. **不碰语音链路**：对局是 HTTP 轮询，跟 `MediaConnection` 物理隔离。

原因不是"风险高"，而是**房间是星型拓扑**：`engine.ts` 只有 `handleHostMessage` /
`handleGuestMessage` 两个方向，访客之间根本没有连接。把对局挂在现有 DataConnection 上，
就必须让房主转发访客↔访客的消息——那是最不该动的一段。

---

## 3. 架构

```
发起方（= 这局的 host）          服务端                    接受方（guest）
  引擎在本机跑                                             只收快照、只发意图
  snapshot() ──poll(state)──▶  duel_sessions  ◀──poll()──  渲染
  applyAction() ◀──poll(action)──  一行/局     ──poll()──▶  intent
```

- **谁发起谁当 host**，跟"房间房主"无关：访客之间也能打（三窗口实测过，房间房主完全不参与）。
- 双方各 ~1.2 秒 POST 一次 `/poll`（出牌瞬间额外加速一轮），回合制对延迟无感。
- 快照带 `version` 单调递增；访客只拿比自己新的那份。
- 两端都要同一个 `DUEL_SCHEMA_VERSION`，不一致时访客看到「版本不一致」安全退出。

### 数据表 `duel_sessions`

`id / room_code / host_id / host_name / guest_id / guest_name / phase / version /
state / action / action_seq / host_seen_at / guest_seen_at / host_left / guest_left /
created_at / updated_at`（随服务启动自动建，见 `server/db/schema.sql`）。

`phase`：`invite | playing | over | cancelled`。

### 三个接口

| 接口 | 作用 |
|---|---|
| `POST /api/duel/invite` | 建一行 `invite`；先清自己的残留（换房/过期），再判忙 |
| `POST /api/duel/poll` | 一次往返完成拉+推；`cmd` = accept/decline/leave，`state`（host）、`action`（guest）、`since` |
| `POST /api/duel/leave` | 显式退出（`sendBeacon` / 关页面用） |

访问控制只有一条：**只有 `host_id` / `guest_id` 本人能读写这一行**，`gameId` 不可猜。

---

## 4. 生命周期清理（2026-11-04 定死，最容易写错的地方）

> 一条邀请/一局牌，**只能活在「这两个人 × 这一间房」里**。任一方离开这个前提，立刻作废。

| 场景 | 服务端 | 客户端 |
|---|---|---|
| 邀请过期 | **1 分钟**（`INVITE_TTL_MS`），按 `created_at` 算，**不能按 `updated_at`**（轮询会刷新它，等于永不过期） | 弹窗/等待卡到点消失 |
| 点「退出对局」 | 任何一方退出 → `phase='over'`（不是等两个人都退） | 立刻清本地、卸载牌桌 |
| 对方退出 | 对方下一次轮询看到 `opponentLeft` | **本端自动跟着退**（两边都退，行变 over），房间只留一条 toast |
| 有人退房 / 换房 | `invite` 时先把自己在**别的房号**的 invite/playing 置 cancelled | 轮询 effect 的 cleanup 立刻 `leave`；进房自检再兜一层 |
| 刷新 / 关页面 | — | `pagehide` 尽力发一次 `/leave` |
| 对局结束 | `state.over` → `phase='over'`，保留 60 秒结算画面 | 「回到语音房」→ 清空 |
| 判忙 | 只挡 `playing` + **1 分钟内**的 `invite`；以前挡 30 分钟，会导致"点了一次邀请，半小时内都开不了新局" | 收到 409 → 自动清残留 + 重试一次（用户无感） |

另有两个实现坑，改这块前先读：

- **在飞的一轮会"复活"牌桌**：退出后本地已清空，但上一轮请求回来还带着这局（over 保留 60 秒），
  会把刚卸载的牌桌装回去。用 `exitedRef` 记 gameId，这类回包一律当没有对局。
- **`room` 传空串 = 不限房间**：`/poll` 的 SQL 是 `? = '' OR room_code = ?`，
  客户端的"清残留"就是靠这个把自己的行捞出来的。

---

## 5. 客户端模块（改之前先看 `src/client/duel/README.md`）

```
duel-cards.ts     卡池（14×2 套，改数值只动这里）
duel-engine.ts    规则与结算（房主权威；只加 snapshot/restore，别动别的）
duel-net.ts       传输层：RemoteDuelTransport（生产）/ LocalDuelTransport（本地）
DuelOverlay.tsx   覆盖层 UI（Portal 到 body）
duel.css          皮肤（木桌 + 毡布 + 纸牌）
duel-icons.tsx    卡面矢量图标（替掉 emoji）
```

依赖单向：**数据 ← 规则 ← 网络 ← 界面**。

### 身份：必须用 `personId`

`duelClientId()` 返回 `loadIdentity().personId`（10 位数字，存 localStorage），
**和成员卡里传给 `inviteTo` 的 `member.id` 必须是同一个值**。
1.9.24 之所以"邀请永远送不到"，就是这里用了另一套 sessionStorage 随机串。

副作用：同一个浏览器开两个标签页 = 同一个人，联调要用**普通窗口 + 无痕窗口**（或两台设备）。

### 视角

房主快照里自己是 `players[0]`；访客 `mySide = 1`，渲染时镜像。
`isMyTurn()` 必须是 `cur === this.mySide`——1.9.24 写死成 `cur === 0`，访客永远出不了牌。

---

## 6. 房间隔离（为什么四个人里两个人打牌不影响另外两个）

1. 覆盖层只在**本机**按自己的 session 渲染，旁观者根本不渲染这一层；
2. 服务端那行只对两个人开放，旁人拿 `gameId` 查也是 403；
3. 邀请是定点的（`guest_id`），轮询只查自己的；
4. A 在打时别人邀 A → 409「对方已在另一局里」。

---

## 7. 部署与验收

**服务端不在 CI 里。** 改了 `server/src/duel.mjs` 必须手动部署：

```bash
scp -i .deploy_key server/src/duel.mjs root@5blong.site:/opt/5blong/server/src/
ssh -i .deploy_key root@5blong.site 'systemctl restart 5blong-api'
ssh -i .deploy_key root@5blong.site 'cd /opt/5blong/server && BASE=https://5blong.site node scripts/duel-smoke.mjs'
```

冒烟 24 项必须全过（`server/scripts/duel-smoke.mjs`）。客户端随 `npm run bump` 走 CI。

人工验收（两台设备，都升到最新版）：

- [ ] 邀请 → 对方弹窗 → 接受 → 双方进局
- [ ] 对方拒绝 → 发起方收到提示
- [ ] 出牌/攻击 1.5 秒内同步，回合提示只有一方是「你的回合」
- [ ] 中途点「退出对局」→ 对方牌桌立刻销毁，房间只留 toast
- [ ] 退出后立刻再邀请 → 能开（不被 409 挡）
- [ ] 旁观者界面不变暗、语音正常
- [ ] 全程语音不断

---

## 8. 已知代价 / 边界

1. **房主掉线 = 这局没了**（没有第二个执行者）。回合制下接受这个取舍。
2. 最坏 ~1.2 秒延迟。
3. 对局状态在服务端明文存（JSON 快照），管理员理论上可见；内容是公开梗，不敏感。
4. 房间不存在了（房主关房）→ 双方都会退房，对局随之作废（见第 4 节）。
5. 对战特效（伤害飘字/受击抖动）**还没做**，方案已定：快照的战斗日志带 `dmg/heal` 分类，两端天然同步，挂 CSS 动画即可。
