# 梗王对局 · 模块地图（改这游戏先看这里）

> 依赖方向是单向的：**数据 ← 引擎 ← 网络 ← 界面**。改上层不用懂下层，改下层不影响上层。
> 语音链路（`src/client/voice/`、`server/src/signal*.mjs`）与本模块零依赖。

```
src/client/duel/
  duel-cards.ts    ① 数据：卡牌、牌组、英雄技能（想改游戏内容 → 只看这个）
  duel-engine.ts   ② 规则：出牌/攻击/回合/伤害（纯 TS，不碰 DOM，可单测）
  duel-net.ts      ③ 网络：信箱 Transport + 轮询 hook（改联调方式 → 只看这个）
  DuelOverlay.tsx  ④ 界面：渲染 + 交互（改手感/特效 → 只看这个）
  duel.css         ⑤ 样式：全部视觉（调颜色/间距 → 只看这个）

server/src/duel.mjs        信使接口（只收发，不懂规则）
server/db/schema.sql       duel_sessions 表
server/scripts/duel-smoke.mjs  服务端冒烟（24 项）
tests/duel-engine.test.ts  引擎单测
tests/duel-net.test.ts     网络状态机单测（本地双标签页 = 两个玩家）
docs/DUEL.md      联网方案与取舍（为什么走 HTTP 信使）
```

---

## 数据流（30 秒版）

```
房主（host）                                访客（guest）
  DuelOverlay 点牌                            DuelOverlay 点牌
    → g.playCard()  本地执行                    → bridge.pushAction(意图)
    → onChange                                  → 下轮 poll 带上（≤1.2s）
    → bridge.registerState(快照)                    ↓
    → 下轮 poll 上传（version+1）          服务端 duel_sessions 行
        ↓                                       ↓
      服务端存行 ←────────────────────────  房主 poll 取到意图
                                                → g.applyAction() 执行
  访客 poll 拉到新快照                            → 新快照再上传
    → g.restore() 渲染（视角 mySide=1）
```

- **房主权威**：规则只在房主机器上执行，访客发的是「意图」，永远不可能算出两个不同结果。
- **服务器不懂规则**：只存快照和意图，改玩法不用动 `server/src/duel.mjs`。

---

## 常见改动看哪里

### 加一张卡 / 改数值

**只改 `duel-cards.ts`**。每张卡一个对象：

```ts
d15: {
  name: "新梗名", cost: 3, r: "sr", t: "aim", icon: "🎯",
  kind: "spell",            // spell = 技能牌；minion = 随从（还要 atk/hp）
  target: "enemy",          // none=无目标 / enemy=敌英雄或随从 / anyMinion / friendlyMinion…
  txt: "造成 3 点伤害。",    // 卡面文案，数字会自动标红
  f: "梗出处一句话",         // 悬停详情里的「梗味注释」
  dmg: 3,                   // AI 斩杀判断用（正式版无 AI，可省）
  cast: (g, p, t) => g.dealDamage(t, 3, p),   // 效果本体，g 是引擎
},
```

然后把卡 id 加进 `DECKS[0]`（大东彦）或 `DECKS[1]`（Renai）。两套牌按费用预算配平（口径写在文件头）。
`target` 决定玩家要不要选目标；合法性由引擎的 `isTargetable` 统一判断，不用在 UI 里写。

### 调平衡 / 加关键词（嘲讽、封号这类）

引擎的通用规则在 `duel-engine.ts`（伤害/回合/疲劳/召唤上限）。
单卡特效全在卡牌的 `cast` 闭包里——**加新机制优先写成 cast 里的表达式**，只有「所有卡都要用」的能力才进引擎（先例：`spellBonus` 法术加成）。

### 加对战特效

特效数据已经现成：快照里的 `logs` 每条带分类（`dmg` 伤害 / `heal` 治疗 / `sys` 系统），**随快照天然同步到两端**——同一份日志两端渲染同一组动画，不需要额外的特效通道。
做法：`DuelOverlay.tsx` 里对比前后快照（logs 头部新增条目 / 某随从 hp 变化 / 随从消失），给对应元素挂一个 CSS 动画 class（`duel.css` 里写 keyframes，参考 `.duel-mini` 的现有结构）。

### 改联调方式（比如以后想换 WebSocket 推送）

**只改 `duel-net.ts`**：实现一个新的 `DuelTransport`（三个方法：invite / poll / leave），`pickDuelTransport` 里加选择条件。UI 和引擎一行不用动——本地测试的 `LocalDuelTransport` 就是第二个实现，照抄它即可。

### 改界面 / 换卡面

`DuelOverlay.tsx` 只懂「快照怎么画」，不懂规则；`duel.css` 是全部视觉，且所有类名带 `duel-` 前缀，不会和房间的样式串。视角逻辑只认引擎的 `mySide`，渲染代码里**不要写死 side 0/1**。

---

## 接口契约（动引擎前必读）

| 契约 | 内容 |
|---|---|
| `DuelSnapshot` | 引擎全量状态。**改字段必须 `DUEL_SCHEMA_VERSION +1`**：新旧两端版本不一致时访客会看到「版本不一致」提示并安全退出，不会渲染出鬼状态 |
| `DuelAction` | 访客意图，四种：`play(手牌下标+目标) / attack(uid+目标) / power / end`。target 里的 side 一律是**引擎视角**（0=房主），因为访客的引擎实例 `mySide=1`，UI 给的 target 已经是引擎坐标 |
| `duel_sessions` 行 | 服务器只认 `version` 单调递增；`cancelled` 立即收、`over` 保留 60s 给胜负画面；`*_left` 解决「人还在房间但退出对局」；`*_seen_at` 心跳，15s 判掉线 |

## 测试怎么跑

```bash
npx vitest run tests/duel-engine.test.ts tests/duel-net.test.ts   # 单测
node server/scripts/duel-smoke.mjs                                # 服务端 24 项（默认 127.0.0.1:8791）
BASE=https://5blong.site node server/scripts/duel-smoke.mjs       # 打生产（会写测试局，2 小时自动清）
```

本地双标签页实测：`npm run dev` → 两个标签页进同一房间 → 点对方的猪 → 梗王对局。

## 上线顺序

1. `server/` 传 ECS 重启 `5blong-api`（`duel_sessions` 表随启动自动建）
2. 前端随 `bump` 走 CI（网页 + 桌面更新源一起发）
3. **两端版本要一起更新**：快照带 schema 版本保护，不一致时安全退出，但最好同版本玩
