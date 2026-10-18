# 5blong 文档体系优化方案

> **状态**：✅ **已于 2026-10-18 全部执行**（业主批准"全部按照你的来"）——三步①归档②修事实③自动化均落地。本文档转为历史存档，现行规则见 `docs/README.md`。

> **日期**：2026-10-18
> **范围**：工作区全部 11 份 Markdown（工作区入口 README、仓库内 6 份、docs/ 1 份、`.workbuddy-ai/memory/` 2 份、`.workbuddy/memory/` 若干）
> **方法**：逐份通读 + 与源码/脚本/服务端实际状态**逐项核对**（测试数、路由、D1 表、文件存在性均实测验证）

---

## 0. 一页速览

**核心诊断：文档不缺，缺的是"哪份算数"。** 主要问题四个：

1. **同一件事写在三四个地方**（屏幕共享 3 份计划 + README 内嵌章节），没有"唯一事实源"，改一处忘三处；
2. **手写的事实性数字已腐化**：测试数在文档里出现 155 / 187 / 245 三个版本（实测 235）；根 README 的"当前状态"停在 1.5.1（实际线上 1.6.5）；
3. **已完成/已废弃的计划文档没有归档机制**，仍以"现状"姿态躺在仓库根，AI 和新人会拿旧方案当当前架构（SCREENSHARE-PLAN.md 头部仍写着已被推翻的 4000ms 缓冲 / 20Mbps 码率）；
4. **README 的 AUTO-LOG 区块已畸形**（两个"近期提交"列表并存，旧列表永远不被更新），且生成脚本恰好修不了它。

**方案三步走**（每步独立提交、可单独回滚）：

| 步 | 内容 | 风险 |
|---|---|---|
| ① 归档与合并 | 3 份过期计划/交接单移入 `docs/archive/`，README 相应改写 | 极低（只动 md） |
| ② 修事实错误 | 重写根 README 状态段、仓库 README 的技术说明/目录/测试数；修 AUTO-LOG 孤儿块 | 低 |
| ③ 防再腐化 | `docs:sync` 脚本统一注入版本/测试数/目录 + CI 校验 | 低（纯增量） |

---

## 1. 现状盘点（11 份文档逐一核对结果）

| 文档 | 性质 | 核对结论 | 处置建议 |
|---|---|---|---|
| `5blong/README.md`（工作区入口） | 维护者/AI 速查 | **状态段停在 1.5.1**（实际 1.6.5）；资源表 D1 只列 2 张表（实际 9 张）；路由清单缺 `/game/*`、`/game-admin`、`/rooms-live`、`/rooms/export` | 保留框架，重写过期段（§3.2） |
| `5blong/5blong/README.md` | 用户+开发主文档 | 结构好，但"技术说明"仍写 **"信令使用 PeerJS 公共云"**（1.5.0 起已是自建信令多线路）；**目录表缺 12+ 个新文件**；测试数 155/187 两处不一致（实测 **235**）；**AUTO-LOG 区块畸形**（§2.1） | 保留，分段更新 + 注入自动化 |
| `SCREENSHARE-PLAN.md` | 屏幕共享设计方案 v1.2.1 | 头部仍宣称"P2P 默认 / 缓冲统一 4000ms / 20Mbps / contentHint=motion"——**全部被 OPT-PLAN §10 推翻并已在 10-14 落地**；只有 §H 语音隔离约束仍被引用 | **归档**（保留 §H，其余成为历史） |
| `SCREENSHARE-PERF-PLAN.md` | 性能优化 v3 | 头部自认"已被 OPT-PLAN 整体重写替换"；独有留存价值：B站链路参照系、H.265/AV1 评估、Oopz=TRTC 归因 | **归档**（分析价值留在档案里可查） |
| `SCREENSHARE-OPT-PLAN.md` | 优化方案定稿 | **质量最高的文档**，§10 实施状态清晰；唯一问题：它实际是"已完成记录"，文件名还叫 PLAN | 改名为 `docs/screenshare-optimization.md` 或归档，README 引用同步 |
| `KNOWN-ISSUES.md` | 缺陷交接单 | 两份缺陷**均已于 10-12 修复**，全文是历史记录 | **归档** |
| `UI-REDESIGN-PLAN.md` | UI 重做方案 V1 | 基线过时：写"源码 1.0.3 / 110 测试"，且引用的 `Pig.tsx` **已不存在**（P1 精灵帧已落地为 `pig-sprite.ts`）；P2~P4 是否做完无状态 | 补状态头部（已完成到哪期），或归档 |
| `docs/2026-10-17-开黑圈上线记录.md` | 开发日志 | **范本级文档**，建议作为 docs/ 日志的格式标准 | 保留不动 |
| `.workbuddy-ai/memory/MEMORY.md` | 旧 AI 长期记忆 | **本地路径写错**（`E:/twest/5blong/piik`，实为 `E:/tv12/5blong/5blong`）；与 `.workbuddy/memory/` 双系统并存 | 合并进 `.workbuddy/memory/MEMORY.md` 后停用（§4） |
| `.workbuddy-ai/memory/2026-10-13.md` | 旧日记 | 历史价值高（更新源迁移、去 Piik 化、CI 发布全记录） | 迁入 `.workbuddy/memory/` 或 `docs/archive/` |
| `.workbuddy/memory/*` | 现行 AI 记忆 | 正常运作，根 README 已指向它 | 保留 |

---

## 2. 实测发现的事实性错误（每条附证据）

### 2.1 README 的 AUTO-LOG 区块畸形（结构性 bug）

`README.md` 第 570–593 行存在**两个「近期提交」列表**：

```
570  ### 近期提交（自动生成）        ← 孤儿块：只有内容+END，没有 START
…（1.4.4~1.5.0 的旧提交，永远停在这里）
579  <!-- AUTO-LOG:END -->
581  <!-- AUTO-LOG:START -->        ← 正常块：CI 只更新这一块
…（当前到 1.6.5）
593  <!-- AUTO-LOG:END -->
```

根因在 `scripts/readme-log.mjs:41`：正则是 `START[\s\S]*?END`（非贪婪，只匹配第一个 START 到其后第一个 END），**孤儿块永远匹配不到、永远不被清理**。后果：README 里永远挂着一份停在 1.5.0 的旧提交列表。

**修复**：① 手动删掉 570–579 孤儿块一次；② 脚本加固——替换前断言"START 与 END 各恰好出现一次"，否则先清理所有残留块再插入（3 行代码的事）。

### 2.2 测试数三个版本（实测 235）

| 出处 | 写的数 | 实测 |
|---|---|---|
| README「怎么用」`npm test` | 187 项 | grep `it(/test(` 计数 **235** |
| README「目录」tests/ 注释 | 155 项 | （同上） |
| docs/2026-10-17 日志 | 245 项 | 口径不同（含参数化展开？），但对外文档只能有一个数 |

**修复**：测试数**禁止手写**，由脚本从 `vitest run --reporter=json` 注入（见 §5）。

### 2.3 "信令使用 PeerJS 公共云"已过时

README「技术说明」第 2 条仍写公共云；而 `src/client/voice/signal-routes.ts` 实际是多线路（生产：自有域名 `/peerjs` → 公共云兜底；DEV 直连）。**建议口径**："自建信令（Cloudflare Worker + Durable Object，PeerJS 线协议兼容）+ 公共云兜底"。

### 2.4 目录表缺 12+ 个文件

README「目录」完全没提到以下**已存在**的文件/目录：

- `src/client/game/` 整个子系统（5 个文件，开黑圈——1.6.0 的核心功能！）
- 语音房新增：`changelog.ts`、`session-stats.ts`、`signal-routes.ts`、`pen-themes.css`、`scene-theme.ts`、`loopback.ts`、`feedback.ts`、`onboarding.ts`、`pen-registry.ts`、`pen-follow.ts`
- 组件新增：`FeedbackDialog.tsx`、`HealthCheck.tsx`、`OnboardingDialog.tsx`、`SettingsView.tsx`、`UpdateOverlay.tsx`、`ui.tsx`、`pages.tsx`

**修复**：目录表改由脚本生成（`docs:sync`），或至少删掉已过细的逐文件描述、只保留目录级说明（手写逐文件清单必然腐化，已验证）。

### 2.5 工作区入口 README 的状态段

- "当前进行中的状态"写 **"线上：1.5.1 发布中"**（实际 1.6.5，10-17 一天发了 6 个版）；
- D1 资源表只列 `feedback`、`rooms` 两张表，实际 9 张（实测 `feedback-schema.sql`：`feedback/rooms/room_sessions/room_members/room_events/room_samples/game_codes/staff_tokens/game_audit`）；
- 路由清单缺 `/game/entitle`、`/game/verify`、`/game-admin`、`/rooms-live`（实测在 `worker/_worker.pages.js` 与 `worker/signal/index.js`）。

**修复**：这类"状态快照"要么删除（让 git log 说话），要么头部加 `> 快照日期：YYYY-MM-DD，过期以代码为准` 的哨兵行。

### 2.6 SCREENSHARE-PLAN.md 头部误导

头部状态行仍写着 v1.2.1 时代的架构描述（"观众端抖动缓冲统一拉满 4000ms"、"1080p60→20Mbps"、"contentHint=motion"），**每一条都已被 OPT-PLAN §10 的实现推翻**（600ms/3000ms 分级、8Mbps、detail 优先）。该文件仍被 README 和 OPT-PLAN 引用，读者极易拿它当现行架构。

**修复**：归档；§H（语音零影响约束）是唯一仍被引用的活内容，并入 OPT-PLAN 或独立成 `docs/constraints.md`。

### 2.7 .workbuddy-ai 旧记忆路径错误

`MEMORY.md` 写"本地目录 E:/twest/5blong/piik"、"小猪素材在 E:/twest/pig"——路径均已不存在（现为 `E:/tv12/...`）。**旧记忆系统的错误事实比没有记忆更危险**（AI 会照着去操作不存在的路径）。

### 2.8 隐私口径分散三处

"遥测收集什么、不收集什么"分散在：README 隐私章节、根 README 遥测架构段、`worker/signal/index.js` 头注释。三处各自手写，将来必漂移。**建议**：隐私口径只保留在 README（面向用户的权威版本），其余两处用一行链接指过去。

---

## 3. 目标结构（重组后）

```
5blong/                        ← 工作区根
├─ README.md                   ← 唯一入口：产品一句话 + 资源速查表 + 红线 + 指向
└─ 5blong/                     ← 仓库根
   ├─ README.md                ← 用户文档 + 开发文档（三段式：怎么用 / 怎么改 / 怎么发版）
   ├─ DOCS-OPT-PLAN.md         ← 本文档（执行完后归档）
   └─ docs/
      ├─ README.md             ← docs 索引（一句话目录）
      ├─ architecture.md       ← 现行架构：信令/语音/共享/开黑圈/遥测（由 SCREENSHARE-OPT-PLAN §10 等提炼）
      ├─ constraints.md        ← 硬约束汇总：语音零影响、隐私口径、体积红线、协作守则
      ├─ 2026-10-17-开黑圈上线记录.md   ← 不动
      └─ archive/              ← 已完成/被取代的计划与交接单（只进不出）
         ├─ SCREENSHARE-PLAN.md
         ├─ SCREENSHARE-PERF-PLAN.md
         ├─ SCREENSHARE-OPT-PLAN.md
         ├─ KNOWN-ISSUES.md
         └─ UI-REDESIGN-PLAN.md（若确认不再继续）
```

**归档规则**（写进 docs/README.md）：

1. 计划文档完成后 **7 天内**移入 `archive/`，同时在 README 删除/改写引用；
2. `archive/` 内的文件**只读不改**，要改就拎出来立新文档；
3. 每份文档头部必须有元数据行：`状态（草稿/进行中/已定稿/已归档）｜基准版本｜最后核实日期`——没有这三行的文档，AI 不得据其动手。

---

## 4. 记忆系统合并

现状是**双系统并存**（`.workbuddy-ai/memory/` 旧 + `.workbuddy/memory/` 现行），且旧系统含错误路径。建议：

1. `.workbuddy-ai/memory/MEMORY.md` 中仍有效的事实（更新源架构、签名密钥位置、cargo 可用）合并进 `.workbuddy/memory/MEMORY.md`；
2. `2026-10-13.md` 整篇移入 `docs/archive/`（它是高质量的发版史）；
3. `.workbuddy-ai/` 目录删除或留一个 `README.md` 写"已迁至 ../.workbuddy/memory/"；
4. 工作区入口 README 的指针已经是 `.workbuddy/memory/`，无需改。

---

## 5. 防再腐化：单一事实源 + 脚本注入

**原则：凡是代码里查得到的，文档里不许手写。**

新增 `scripts/docs-sync.mjs`（挂 `npm run docs:sync`，并在 `bump` 流程末尾自动跑）：

| 注入点 | 来源 | 写入位置 |
|---|---|---|
| 版本号 | `package.json` | README 标题旁徽标行 |
| 测试数 | `vitest run --reporter=json` 的 `numTotalTests` | README「怎么用」与「目录」 |
| 目录表 | `ls src/client/voice src/client/game worker scripts` | README「目录」的 `AUTO-TREE` 区块 |
| 路由清单 | 解析 `worker/_worker.pages.js` 的 `pathname ===` | 工作区 README 资源表 |
| 提交列表 | 现有 readme-log.mjs | 不动（先修 §2.1 的 bug） |

CI 侧加一道轻量校验（可并入现有 readme-log.yml 或单独 workflow）：

- README 中 AUTO-LOG 标记恰好一对（防 §2.1 复发）；
- 文档内链接的本地文件存在（防 UI-REDESIGN-PLAN 引用已删的 `Pig.tsx` 这类）；
- `archive/` 外的文档不含"已于 … 修复""已被取代"字样（该字样 = 该归档了）。

---

## 6. 落地顺序（三步，每步一个 commit）

**第 ① 步 · 归档（零风险）**
- 建 `docs/archive/`，移入 4 份过期文档；README 中相应链接改为指向 `docs/architecture.md`（先建骨架）；
- `KNOWN-ISSUES.md` 直接归档（无任何活引用）；
- 验收：`npm run check` 全绿（纯 md 移动，不应有任何影响），grep 确认无死链。

**第 ② 步 · 修事实（低风险）**
- 删 AUTO-LOG 孤儿块 + 加固 readme-log.mjs；
- 重写仓库 README 的「技术说明」「目录」、工作区 README 的资源表/状态段；
- 合并记忆系统（§4）；
- 验收：diff 逐条过，业主确认口径。

**第 ③ 步 · 自动化（增量）**
- `docs-sync.mjs` + CI 校验；
- 验收：手动改测试数 → 跑脚本 → 数字自动回正；CI 对畸形标记报错。

---

## 7. 顺带发现（非文档类，仅记录不展开）

读文档过程中暴露的项目层面问题，供以后单独立项：

1. **AUTO-LOG 生成脚本 bug**（§2.1）——这是代码 bug，不只是文档问题；
2. **SFU 第一跳在海外**（OPT-PLAN §8-8 已提出"国内中继"议题，至今未立项）；
3. **发版 SOP 靠文档约束人**——`bump` 后 main 漏推的事故（10-16）本质是脚本可以自检的：`bump-version.mjs` 末尾加 `ls-remote` 双确认即可机器化；
4. **`/rooms/beat`、`/rooms/bye` 已是死端点**（1.6.0 起无人调用），代码和文档都该清理。

---

## 8. 待业主拍板

1. **归档目录位置**：`docs/archive/` 还是仓库根的 `_archive/`？
2. **UI-REDESIGN-PLAN.md 的去留**：P2~P4（互动/场景/控件）还做吗？做→补状态头部留仓库根；不做→归档。
3. **屏幕共享三件套**：确认只留 OPT-PLAN 为唯一事实源（另两份归档）？
4. **记忆合并**：`.workbuddy-ai/` 确认停用删除？
5. **自动化力度**：第 ③ 步的 `docs:sync` 要做全（版本/测试数/目录/路由四项注入），还是先做最低成本的两项（测试数 + AUTO-LOG 修复）？
