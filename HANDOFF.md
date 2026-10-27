# 交接文档（2026-10-26）

> 给下一位接手的 AI / 开发者。先读「必读的坑」，再按待办顺序做。  
> 所有改动**都在本地、未推送**（业主未授权推送）。

---

## 一、项目速览

**5blong**：免注册语音房。WebRTC 全网状（P2P）+ 可选 SFU 转发；Tauri 桌面端（WebView2）与网页端共用同一套 React 代码。发版由 `npm run bump -- x.y.z` 统一改 4 处版本号 + commit + tag `app-vX.Y.Z` + push 触发 CI（桌面安装包 + Pages 更新源全自动）。

### 关键目录（都在 `src/client/`）

| 路径                                        | 内容                                           |
| ----------------------------------------- | -------------------------------------------- |
| `voice/engine.ts`                         | 核心（~4500 行）：PeerJS 组网、名册、语音链路、屏幕共享发布/订阅、降档调谐 |
| `voice/protocol.ts`                       | 信令消息定义 + 解析（**所有字段必须在这里校验**，容忍旧客户端缺字段）       |
| `voice/use-voice.ts`                      | React 绑定（App 只跟它打交道）                         |
| `voice/screen-share.ts`                   | 共享采集/发布/SFU/调谐器/双端编解码协商                      |
| `voice/game/game-mesh.ts`                 | 开黑圈语音（独立一套，与语音房并列）                           |
| `voice/account/*`                         | **账号/好友（本次新增）**：契约、本地适配器、React hook          |
| `voice/components/AccountPanels.tsx`      | 登录/注册/我的资料 + 好友抽屉                            |
| `voice/components/FriendRequestToast.tsx` | 房间内好友请求轻提示                                   |
| `voice/components/RoomView.tsx`           | 房间 UI（顶栏木牌、成员菜单、猪圈）                          |
| `voice/invite-text.ts`                    | 邀请文案（纯函数）                                    |

## 二、Git 状态（重要）

- **远端 main = v1.8.7**（tag `app-v1.8.7` 已推送，CI 已出包）。
- **本地领先远端**：v1.8.8（夜间主题修复，tag `app-v1.8.8` 仅本地）+ 全部账号/好友提交。
- 业主口径：**没让推就不推**。要发时：`git push origin main && git push origin app-v1.8.8`（先 `git pull --rebase`，README AUTO-LOG 冲突以 CI 版为准）。
- push 常失败：代理 7890 时好时坏。直连绕过：`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='http.https://github.com/.proxy' GIT_CONFIG_VALUE_0=''`。

## 三、本次修过的 bug（都已本地提交，别回退）

1. **语音链路被自己拆掉**（"刚说完话就连接不上"/"只有某个人连不上"）：
   - `isCallDead` 不再把 ICE `disconnected` 当死（engine.ts 与 game-mesh.ts 都改了，只认 closed/failed）；
   - 静音不再等于掉线：`ensureCalls` 需 ICE 未连通 + 15s 无包，或连通但非静音 45s（静音 120s）；
   - 无麦成员被 `shouldCall`（myId < peerId）指定为拨号方 → 死锁：`callPeer` 改为用空流发起（recvonly），`reconcileAudio` 不再因 `!localStream` 整体跳过。
2. **共享被砍到 2fps**：`screenHintFor` 原来默认返回 `detail`（保分辨率砍帧率）。现规则：有人要流畅→motion；全员明确要清晰→detail；否则**不设 hint**（平衡）。
3. **共享按需码率三档**：watch（灯箱开，满码率按在看人数分摊）/ preview（挂着，500k·15fps·半分辨率，不建 tuner）/ off（直接关掉那路呼叫）。P2P 与 SFU 都接了；协议新增 `screen-watch`。
4. **房主看不到访客共享**：接收端拿空 `sessionId` 与本地比较恒不等 → 误判过期会话直接 close。现在只有两边非空且不同才判过期。
5. **"浏览器拦截了自动播放"是误报**：原代码任何 `play()` 失败都写这句。实测 `--autoplay-policy=no-user-gesture-required` 在 WebView2 有效（别再质疑）。现按 `error.name` 分流：`AbortError` 静默重试；`NotAllowedError` 才走静音兜底 + `media-unlock.ts` 手势开声。
6. **夜间主题割裂**：10-22 的"压亮度"规则特异性高于 night 规则 → 天空不变暗；频道卡硬编码奶油色不跟夜色（已用 `:is(dark, light+night)` 统一）；`daypart` 60s 定时器在窗口最小化时被压 → 已加 visibilitychange/focus/pointerdown 补算。

## 四、账号 / 好友功能（新架构，务必理解再动）

### 设计原则（不可破坏）

1. **登录只加功能，不加门禁**：进房路径（host/join/hello 校验）**零登录依赖**。验收项：未登录访客必须能进登录房主的房间。
2. 数字 ID（8 位）是主键，用户名唯一可搜可改。
3. 好友双向同意；单向只进"最近一起玩"（未实现）。
4. 房间里**只有房主能邀请**（`canInvite`，业主口径 2026-10-26）。
5. `accountId` 在协议里是**可选**字段：未登录/旧客户端没有，解析端正则校验（8 位数字）后丢弃非法值。

### 架构：适配器模式

```
UI（AccountPanels / App） → useAccount() → AccountAdapter 接口
                                            ├── LocalAccountAdapter（现在，localStorage + BroadcastChannel）
                                            └── [待写] WorkerAdapter（D1 + KV + R2）
```

换后端时**只写一个新 Adapter，UI 一行不改**。

### 已实现

- 注册/登录（PBKDF2-SHA256 12 万次迭代）、我的资料（改昵称/头像/复制 ID）、退出。
- 好友：搜索（ID/用户名）、请求/同意/拒绝、列表 + 在线状态（心跳 8s，12s 判离线）。
- 房间集成：hello/名册/peer-join 广播 `accountId`；成员菜单「加好友」（**仅双方登录且非好友时显示**）；进房后才登录 → `account` 消息向房主补报（协议已含可选 `name` 字段，**engine 尚未发送 name，属半成品**）。
- 房内好友请求轻提示（底部，8s 自动收起，可就地同意）。
- 房内好友面板（顶栏 Contact 图标 + "好友"文字）+ 邀请（复制邀请文案，仅房主）。
- 头像：客户端裁 256×256 WebP（~20KB），存 data URL；`avatarVersion` 做缓存失效；`avatar_status` 字段未建表但方案已定（机审暂不做）。

### 预览方式

- dev server：`npx vite --port 5178 --host 127.0.0.1`（后台跑）
- `http://127.0.0.1:5178/?account=demo` 会种两个演示账号：`duBu` / `tangxiaofei`，密码都是 `12345678`。
- **登录态存 sessionStorage**（每标签页独立）——这是预览技巧：两个窗口 = 两台设备。上线必须换 httpOnly cookie。

## 五、待办（按优先级）

1. **真实后端**：Cloudflare Worker + D1（账号/好友关系）+ KV（在线心跳）+ R2（头像，已开通 10GB/1000 万次）。写 `WorkerAdapter implements AccountAdapter` 即可。上线后登录态换 httpOnly cookie。
2. **固定房号**（"我的房间 235417 · 开始"）：需要把房码从 4 位扩到 **6 位**（4 位 9000 个，100 用户碰撞概率 ~40%）。动 `isRoomCode/normalizeCode/ROOM_CODE_LEN` + 首页输入框 maxLength + 邀请文案。固定码靠 roomKey 隔离（抢码进不了房，但会占位）。
3. **邀请推送**：`onInvite` 接口已留，接 Worker 轮询或长连接后从"复制文案"升级为"推送到对方屏幕"。
4. **进房后改名/改头像的传播**：`account` 消息协议已留 `name` 字段，engine 未发送——半成品，接手时补全。
5. **SFU 路径的 accountId**：P2P 已全通；SFU 发布/订阅的元数据里没带（低优先，好友加人主要走 P2P 场景）。
6. 发布：攒着的功能够发 **1.8.8**（夜间主题）+ 账号好友（建议 1.8.9）。

## 六、必读的坑（每条都真实踩过）

1. **protocol.ts 加字段必须**：定义 + 解析校验 + 用 spread 兼容缺省；旧客户端没有该字段时一切照常。
2. **`this.me` 与 `members` 必须一致**：房主自己那条记录忘了带新字段 → "别人看不到房主的 ID"（加不了房主的根因）。`setAccountId` 现在会同步 self 并由房主重播名册。
3. **App.tsx 有两条 return 分支**（房间分支提前 return）——**任何全局面板/浮层必须两条分支都挂**，否则"房间里点了没反应"。
4. **z-index**：房间内最高 120。好友面板 130、请求提示 125。低于 120 会被场景面板压住（表现为"点了没反应"）。
5. **JSX 三元分支里只能有一个根**：往 `? :` 分支里塞 `{/* 注释 */}` + 元素会直接编译错误。
6. **styles.css 是 CRLF**：python 写入必须 `open(path,'wb').write(text.replace('\n','\r\n').encode())`，且绝不能出现 `\r\r\n`（出现过一次 CSS 全炸）。
7. **写文件脚本区分 path 与 content 变量**（曾 `write(path)` 把夹具写坏，`git checkout --` 救回）。
8. **空状态别用 emoji**：用吉祥物 `../assets/landing-pig.webp`（`?url` 导入，首页已加载零成本）。
9. **表单弹窗不能点背景关闭**（丢输入）；只有 popover 才点外关。
10. **别把 WebAudio/loopback 的静音当成 bug**——先看是不是游戏走了非默认设备（Apex 独占音频）。
11. UI 有争议就**截图看**：无头 Edge + `Page.captureScreenshot`，脚本都在 `scripts/`（见下）。夹具必须引入 `account.css`（member-menu.tsx 曾漏，看到的是浏览器默认按钮）。
12. `npm run bump` 内部的 push 靠环境变量绕代理；失败会打印恢复 SOP，照做即可。

## 七、验证工具（scripts/，都依赖 vite 5178 + Edge headless 9223）

```
npx vite --port 5178 --host 127.0.0.1        # 后台跑
msedge --headless=new --remote-debugging-port=9223 --remote-allow-origins=* --user-data-dir=<临时目录>
```

| 脚本                                                             | 用途                  |
| -------------------------------------------------------------- | ------------------- |
| `probe-rejoin.mjs`                                             | 两客户端进/退/重进回归        |
| `verify-account-ui.mjs`                                        | 登录→换头像→资料→好友面板全流程截图 |
| `shot-friends.mjs` / `shot-toast.mjs` / `shot-member-menu.mjs` | 各 UI 截图             |
| `check-dialog-dismiss.mjs`                                     | 弹窗点外不关、Esc 关        |

测试：`npx vitest run`（259 个）；类型：`npx tsc -b --pretty false`；构建：`npm run build:web:pages`。

## 八、当前已知未修（接手前先看）

- 进房后改昵称：本地 identity 变了，但 engine 的 `me.name` 不更新、不广播（`account` 消息的 name 字段留了，未接）。
- 未登录访客体验：能进房能说话，但永远进不了好友体系（设计如此），引导文案只在成员菜单出现。
- 邀请推送未接；固定房号未做。
- `account.css` 与 `styles.css` 有部分选择器重复风险（都定义过 `.vx-friends-*`），改动时先 grep。

## 九、给接手者的一句话

这个代码库的 bug 大多不是"不会写"，而是**两套体系（房间身份 vs 账号、首页分支 vs 房间分支、P2P vs SFU）只改了一边**。动手前先问自己：另一边要不要同步改？改完用 `scripts/` 里的无头脚本跑一遍真实 DOM，别只看编译。
