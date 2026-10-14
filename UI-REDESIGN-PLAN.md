# 5blong 房间视觉全面重做 · 实施方案 V1

> **文档用途**：本文档是完整的重做需求与技术方案，自包含、可直接交给任何 AI / 开发者执行，无需额外上下文。
> **阅读顺序**：先读 §2 现状核查、§6 硬性约束，再按 §7 分期实施。
> **版本基准**：源码 1.0.3，工作区另含两处未发版改动（见 §1.4），重做在其之上进行。

---

## 1. 项目背景速览

### 1.1 产品与技术栈

- 产品：**5blong**——免注册临时 P2P 语音房，网页版 + Windows 桌面端（Tauri 2）。
- 前端：React 19 + Vite + TypeScript，无 UI 框架，全部手写组件，类名统一 `vx-` 前缀。
- 通信：PeerJS 公共云信令 + WebRTC mesh；房主权威（心跳、成员表、猪圈事件广播）。
- 桌面壳：Tauri 2（NSIS 安装包约 3.6 MiB，**重做后素材总体积必须控制在 +1.5 MiB 以内**）。
- 仓库：`github.com/HeXiang96/5blong`；本地目录 `E:/tv12/5blong/5blong`。

### 1.2 房间视觉相关的文件地图

| 文件 | 职责 |
|---|---|
| `src/client/voice/components/RoomView.tsx` | 房间主界面：顶栏公告牌、成员猪渲染循环、成员音量/互动菜单（`ViewportPopover`）、底部控制托盘、聊天侧栏 |
| `src/client/voice/components/PigPen.tsx` | `PigActor`（单头猪：漫步 Web Animations、说话/睡觉/动作状态、名字牌、网络点）、`PenFrame`（木栏）、`PenScatter`（地面散布物）、`useElementSize` |
| `src/client/voice/components/Pig.tsx` | 当前 SVG 猪形象（**将被替换**） |
| `src/client/voice/components/PenProps.tsx` | `PenPropsLayer`（蔬菜 + 那一坨道具层）、`NpcVisitor`/`DdyFigure`（NPC DDY，SVG 饲养员，**将重做**）、`Pile`（那一坨） |
| `src/client/voice/components/Vegetable.tsx` | 四种蔬菜 SVG |
| `src/client/voice/components/ViewportPopover.tsx` | 成员菜单浮层（**近期新增，勿动逻辑**） |
| `src/client/voice/pen.ts` | 猪圈"导演"纯逻辑：事件定义、时序参数、`phaseForActor` 阶段推算（有完整单测） |
| `src/client/voice/engine.ts` | 信令引擎：`handleInteract`、`feedPig`、DDY 定时丢菜、事件广播 |
| `src/client/main.tsx` | CSS 引入顺序（**重要**）：`styles.css` → `pen-scene.css` → `pen-life.css` → `pen-fence.css`，后者覆盖前者 |
| `src/client/voice/styles.css` | 主题变量、通用控件、房间布局、成员菜单样式 |
| `src/client/voice/pen-scene.css` | 猪圈场景：天空/草地渐变、猪的动画轨道 |
| `src/client/voice/pen-life.css` | 道具动画：蔬菜抛物线、那一坨落地、臭味虫 |
| `src/client/voice/pen-fence.css` | 木栏、公告牌木牌、DDY 出场动画 `vx-npc-visit` |

### 1.3 构建 / 测试命令（Windows，注意路径）

```bash
# 类型检查（必须用项目内 tsc，勿用 npx tsc）
"D:/tools/node-v24.21.0-win-x64/node.exe" "E:/tv12/5blong/5blong/node_modules/typescript/bin/tsc" -b "E:/tv12/5blong/5blong" --pretty false

# 全量测试（当前 110 项，7 个文件，node 环境）
"D:/tools/node-v24.21.0-win-x64/node.exe" "E:/tv12/5blong/5blong/node_modules/vitest/vitest.mjs" run --root "E:/tv12/5blong/5blong"

# 网页构建
"D:/tools/node-v24.21.0-win-x64/node.exe" "E:/tv12/5blong/5blong/node_modules/vite/bin/vite.js" build "E:/tv12/5blong/5blong" --base ./ --outDir dist-web --emptyOutDir

# 浏览器回归（本地 UI，不连信令不采麦克风；需先起 vite dev/preview 于 8787 端口）
BROWSER_CLI=<agent-browser.exe 路径> BROWSER_EXECUTABLE=<Edge/Chrome 路径> UI_OUTPUT_DIR=<输出目录> node scripts/check-ui-browser.mjs
```

- git 一律 `git -C "E:/tv12/5blong/5blong" ...`；npm 一律 `--prefix`；shell cwd 不跨命令保持。
- 回归夹具：`tests/fixtures/member-menu.html` + `member-menu.tsx`（模拟两名成员渲染真实 `RoomView`）。

### 1.4 近期已完成、不要回退的改动（未发版）

1. **成员菜单视口避让**：`RoomView.tsx` 改用 `ViewportPopover`（portal 到 body、按实测尺寸定位、底部不足向上展开、内部滚动），配套 `popover.ts` + `tests/popover.test.ts`（8 项）。
2. **首页吉祥物已替换**：`pages.tsx` 的 `LandingView` 使用 `src/client/voice/assets/landing-pig.gif`（用户素材原样拷贝，512×512，透明底动画）。

---

## 2. 现状核查结论（已核对代码，实施时不必重复怀疑）

### 2.1 "拉屎"事件归属——逻辑正确，问题只在视觉

`pen.ts` / `engine.ts` 的真实规则：**DDY 只丢菜（toss）→ 最近的猪走过去吃（eat，actor=猪）→ 消化 14–40s → 同一头猪拉屎（poop，actor=猪）**。拉屎事件的 `actor` 字段永远是猪的成员 ID，`phaseForActor` 让该猪播「使劲(strain)→回头闻(sniff)」，那一坨渲染在该猪脚边（`xOf(event.actor)`）。

**结论：不存在"DDY 拉屎"的逻辑错误。** 用户觉得像 DDY 拉，是因为 SVG 猪的 strain 动画生硬、那一坨与猪的贴合度差。**事件引擎与协议不改**，只重做视觉表现。

### 2.2 "投喂"现状——确实是凭空刷菜

`engine.ts` 的 `feedPig(to)`：在目标猪面前 ±0.06 处生成一棵 `npc: ""` 的 toss（特意不召唤 DDY），3s 后生成 eat。用户需求是**点"投喂"时 DDY 应走到目标猪面前喂食**，"摸一摸"同理（DDY 走过来抚摸）。

实现要点：投喂的 toss 已走全房间广播，把 `npc` 从 `""` 改回 `"DDY"` 并把落点定在目标猪面前，前端据 `npc` + 目标位置播 DDY 走位即可；抚摸走 `InteractEvent`（kind=pat 已广播），纯前端加动画。**协议格式零改动。**

### 2.3 动画生硬的根因

- 猪是 SVG 硬件变换（缩放/位移/翻转），没有帧动画；
- 漫步用 Web Animations 位移 + 原地姿态，有滑步感；
- 用户提供的 6 个 GIF **全部是原地动画，无横向位移帧**——走路循环素材缺失，必须生成（见 §4）。

---

## 3. 重做范围总览（五层）

```
素材生产管线（P0）
    ↓ 供给
┌─ 渲染端四条并行线（引擎/语音/协议全部不动）─────────┐
│  ① 猪渲染层：精灵帧替代 SVG，走路不滑步            │
│  ② NPC 层：DDY 新形象 + 应召喂食/抚摸             │
│  ③ 场景道具层：泥土花草木栏整幅重绘，蔬菜/坨重做    │
│  ④ UI 控件层：托盘/菜单/聊天全部与新画风统一        │
└──────────────────────────────────────────────┘
    ↓ 分期上线
P1 先换猪 → P2 互动+NPC → P3 场景道具 → P4 UI 统一
```

---

## 4. P0 · 素材生产管线

### 4.1 现有素材盘点（`E:/tv12/pig/`，共约 1.1 MiB）

| 文件 | 尺寸/帧数/时长 | 推测用途（**待业主标注确认**） |
|---|---|---|
| `D9BDCDB10C55902F214FCA2D094AAE1C.gif` | 512×512 / 96 帧 / 3.2s | 主形象（已用作首页吉祥物），动画最丰富 |
| `EBD2B5C43F04CDD84AF26B643DF22793.gif` | 347×304 / 49 帧 / 4.35s | 待机或另一动作 |
| `BE9804AB905ED59FD189F97DD7CD4A34.gif` | 278×202 / 17 帧 / 0.85s | 短循环（说话类？） |
| `123213a.gif` | 311×203 / 2 帧 / 40ms | 几乎静态（站姿/睡觉类？） |
| `FD1B688E32FAAC976760234F1C6144DF.gif` | 512×512 / 10 帧 / 0.2s | 快速小循环（眨眼/尾巴？） |
| `19BC7AFD2849CFACFE9B9B77341ED085.gif` | 44×44 / 19 帧 / 0.38s | 太小，适合表情/头像 |

所有 GIF：透明底、主体居中无位移、平均色都在粉色系（rgb≈226–251, 181–224, 159–211）。

### 4.2 需要生产的动作集（状态 × 动画矩阵）

| 资产 | 用途 | 来源 |
|---|---|---|
| idle 待机循环 | 默认站姿 | 现有 GIF 或生成 |
| walk 走路循环（面右，面左用镜像） | 漫游、走向食物 | **必须生成**（现有素材无位移帧） |
| speak 说话循环 | 说话中（对应 `speaking` 状态） | 现有或生成 |
| sleep 睡觉循环 | 静音（`sleeping`） | 现有或生成 |
| deaf 闭听姿态 | 戴耳机（`deafened`），可用贴片叠加 | 生成小贴片 |
| eat-munch 进食循环 | 对应 phase=munch | 生成 |
| poop-strain / poop-sniff | 对应 phase=strain / sniff | 生成 |
| react-pat 被摸反应 | DDY 抚摸时 | 生成 |
| react-feed 被喂反应 | DDY 喂食时 | 生成 |
| react-poke 等被互动 | 戳一戳等 8 种互动的受击反应（可共用一个"晃动+表情"） | 生成 |
| DDY 全套：idle / walk / toss / feed / pat | NPC 新形象 | 生成 |
| 场景：天空 / 草地 / 泥地 / 木栏 / 花草散布 / 蔬菜×4 / 那一坨 | 静帧插画或分层图 | 生成或重绘 |

### 4.3 生产流程与规格

1. **定基准**：业主指定基准猪（建议 D9BDCDB 或另选）→ 抽 1–3 帧作参考图。
2. **AI 生成**：以参考图做 image-to-image 生成缺失动作的关键帧/序列帧；每批多生成几个候选，按与基准猪的一致性（配色、描边、比例、透视）挑选。**风格漂移是最大风险，宁缺毋滥。**
3. **统一后处理**（脚本化，Pillow）：透明底清理（半透明边杂点）、统一画布（角色类 256×256）、统一帧率（12fps）、裁剪到内容包围盒、调色板压缩（≤128 色）。
4. **格式选择**：优先 **sprite sheet（PNG 横条 + CSS `steps()` 播放）**——比 GIF 更可控（GIF 256 色易脏、无法部分暂停）；现有 GIF 可直接用 `<img>` 播，后续再逐步转 sprite sheet。
5. **体积预算**：全部新增素材 ≤ 1.5 MiB（安装包现在 3.6 MiB）。超预算时优先降帧率/降色数，不降分辨率到模糊。

### 4.4 多猪区分策略

现在每头猪按成员颜色着色（SVG）。换 GIF 后：**单一素材集 + CSS `filter: hue-rotate()` 按成员颜色偏移**，房主徽章/名字牌/闭听耳机保持独立 DOM 贴片叠加，不进素材。备选：少量配件（帽子/围巾）按成员区分。

---

## 5. P1–P4 · 各层详细规格

### 5.1 P1 猪渲染层（`PigPen.tsx` / `Pig.tsx` / `pen-scene.css`）

- `PigActor` 内部把 SVG 猪替换为精灵渲染（`<img>` 或 background sprite），对外 props **接口不变**（`speaking/sleeping/deafened/action/phase/onSelect...` 全保留）。
- 状态映射：`action=none` 时按 `speaking/sleeping` 选 speak/sleep/idle；`action=eat` 按 phase 切 approach（用 walk + 位移动画）/ munch；`action=poop` 切 strain / sniff。
- **消灭滑步**：位移动画速度与 walk 循环步频挂钩（按步长/帧周期换算），停下时切 idle 姿态而非冻结迈步帧。
- 保留机制：位置中断时的真实值记录（`clampToRange` + 采样上报 `onReportPenActor`）、说话打断漫步的 cancel 逻辑、深度跑道（laneRatio）。
- 名字牌、房主/我/闭听徽章、网络状态点：独立层，样式随 P4 统一。

### 5.2 P2 互动 + NPC 层（`PenProps.tsx` / `engine.ts` 局部 / `pen-life.css`）

- **DDY 新形象**：与猪同画风的 GIF/精灵角色（业主确认方向：延续"草帽饲养员"概念重画，或全新角色）。
- **应召喂食**：`feedPig` 的 toss 事件 `npc` 改为 `"DDY"`、落点=目标猪面前 → 前端检测到"带 npc 的 toss 且目标是某成员"时，DDY 从栏边走到该猪身边 → 播喂食动作 → 猪播 react-feed → 蔬菜消失 → DDY 退场。现有定时丢菜（55–150s 一次）的 DDY 出场保留，走位目标改为蔬菜落点。
- **应召抚摸**：`InteractEvent(kind=pat)` 到达时，DDY 走到目标猪身边播抚摸动作，猪播 react-pat。其余 6 种互动（戳/打招呼/挠痒/抱/吓/撒花）沿用气泡 + 猪受击反应动画。
- **吃/拉动画重做**：用新素材替换 SVG 硬变换，phase 推算机制（`phaseForActor`，全端时间戳同步）**原样保留**，只换表现层。
- 动画时长与新素材对齐：若素材帧长与 `EAT_APPROACH_MS=5000 / EAT_MUNCH_MS=3200 / POOP_STRAIN_MS=2600 / POOP_SNIFF_MS=2600` 不匹配，调素材剪辑而不是改这些常量（它们有测试与全端同步语义）。

### 5.3 P3 场景道具层（`pen-scene.css` / `pen-life.css` / `pen-fence.css` / `Vegetable.tsx` / `Pile`）

- 现状是 radial-gradient 拼贴，整体重绘为与新猪画风一致的**分层静帧插画**：远景天空 → 草地/泥地 → 围栏 → 前景花草散布。分层利于后续视差和主题切换。
- 深色主题不是"变灰"，而是同一场景的夜晚配色（天空、草地、光照全部有对应夜版）。
- 蔬菜×4、那一坨、DDY 的菜篮：同画风重绘；那一坨落地和臭味动画重做但保留 `PenPropsLayer` 的定位逻辑（按事件 x/lane）。
- `PenScatter`（地面散布物）改为新画风的小物件（小花/石子/草丛），数量与分布逻辑可保留。

### 5.4 P4 UI 控件层（`styles.css` 为主）

与新画风统一的控件（保持全部交互与 ARIA 不变）：底部控制托盘（麦克风胶囊/闭听/聊天/离开）、顶部公告牌（圈号/状态/人数/邀请/锁/设置）、聊天侧栏、语音快捷面板、成员菜单（刚修好的 `ViewportPopover`，只调皮肤）、音频被拦截提示条、空圈等待态、加入确认弹窗、设置页。业主另指出一处截图中的不协调 UI（位置待业主指认），一并处理。落地页（首页）已换新猪，控件色板向房间新画风靠拢。

---

## 6. 硬性约束（违反即返工）

1. **不许动的**：`engine.ts` 的信令/握手/心跳逻辑、`protocol.ts` 的线上格式、`pen.ts` 的事件定义与时序常量、全部 8 种互动回调、成员菜单的音量/本地静音/禁言/踢人、`ViewportPopover` 定位逻辑、创建/加入房间流程、主题键 `5blong:theme`。
2. **允许的最小引擎改动**：`feedPig` 的 `npc` 字段值与落点（数据级，非协议级）。
3. **测试基线**：110 项测试必须全绿；新增逻辑（如走位调度）配单测；每期结束跑 `tsc` + vitest + build + 浏览器回归脚本。
4. **体积红线**：新增素材 ≤ 1.5 MiB；构建产物 `dist-web` 中素材可懒加载则懒加载。
5. **性能**：8 头猪同时动画不掉帧（桌面 WebView2 与中端手机浏览器）；离屏猪暂停动画；`prefers-reduced-motion` 时降级为静帧。
6. **无障碍**：猪按钮的 aria-label、菜单 role/aria 保留；动画不承载唯一信息。
7. **环境**：不引入新框架；素材生成产物放 `src/client/voice/assets/`；不用 `npx`，命令见 §1.3。

---

## 7. 分期交付与验收标准

| 期 | 内容 | 验收标准 |
|---|---|---|
| P0 | 素材基准 + 全套资产生成 | 业主逐资产点头"像同一只猪"；体积预算内；循环无缝 |
| P1 | 猪替换 | 双人房漫游/说话/静音/吃/拉全部用新素材；无滑步；110 测试全绿 |
| P2 | 互动 + NPC | 点投喂/摸一摸，DDY 走到目标猪面前表演，全端同步一致；定时丢菜不回退 |
| P3 | 场景道具 | 整幅画面统一画风，深浅主题各一版；矮窗口/缩放不穿帮 |
| P4 | UI 统一 | 全控件过一遍；截图所指问题解决；跨页面（首页/房间/确认页/设置）风格连贯 |

每期一次 commit（可独立回退），不憋大招；每期结束浏览器回归截图交业主确认。

---

## 8. 待业主确认的开放问题（开工前必须回答）

1. §4.1 表中 6 个 GIF 各自是什么动作（一句话标注即可）。
2. 业主最新截图（未能查看）中"与主题不协调"的具体是哪个 UI 块。
3. 生成缺失素材以哪只猪为基准（建议 D9BDCDB）。
4. DDY 的形象方向：延续草帽饲养员概念重画，还是全新角色。
5. 按分期上线，还是一次性全换完再发版。

---

## 9. 附录：关键时序参数（`pen.ts`，改表现别改语义）

| 参数 | 值 | 含义 |
|---|---|---|
| TOSS_INTERVAL_MS | 55–150s | DDY 定时丢菜间隔 |
| EAT_DELAY_MS | 6–16s | 菜落地到被安排吃 |
| POOP_DELAY_MS | 14–40s | 吃完到拉（消化） |
| IDLE_POOP_MS | 90–260s | 猪偶尔自己拉一次 |
| EAT_APPROACH_MS / EAT_MUNCH_MS | 5000 / 3200ms | 走向菜 / 低头吃 |
| POOP_STRAIN_MS / POOP_SNIFF_MS | 2600 / 2600ms | 使劲 / 回头闻 |
| EVENT_TTL_MS | toss 40s / eat 2.4s / poop 26s | 事件留存 |
| MAX_POOP_PILES | 3 | 地上最多坨数 |

事件流（房主生成、全端广播、按时间戳推演阶段）：

```
DDY toss(npc="DDY", veg{x,lane}) ──► nearestActor 选猪 ──► eat(actor=猪)
                                                    └─ 14–40s ─► poop(actor=同一头猪)
成员点"投喂" ──► InteractEvent(kind=feed) 广播 + toss(npc=""→改为"DDY", 落点=猪面前) ──► 3s ─► eat
成员点"摸一摸" ──► InteractEvent(kind=pat) 广播 ──► 前端播 DDY 应召抚摸（无引擎事件）
```
