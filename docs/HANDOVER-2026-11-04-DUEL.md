# 交接：梗王对局上线收尾（2026-11-04 15:38）

> 交给下一个 AI / 维护者执行。**本文自包含**：不需要本会话的上下文。
> 项目根：`E:/5blongv1.6.5/5blong`（下称仓库根）。业主已知情并批准本文全部内容。

---

## 0. 一分钟速览

「房间内梗王对局 1v1」功能已开发完毕并随 **v1.9.24** 发布；ECS 上的 `/api/duel`
信使接口**已部署且体检全绿**（24 项冒烟打生产全过）。剩下的事只有两件：

1. **推送 v1.9.25**（已提交、已打 tag，卡在推送网络）→ 见第 2 节
2. **装上 1.9.25 后做双设备实测** → 见第 3 节

可选后续：降噪模型瘦身（安装包 16.6MB → ~7MB），方案已写在
[README「已知待修」](../README.md)与 [HANDOVER-2026-11-03-VOICE.md 第 5 节](./HANDOVER-2026-11-03-VOICE.md)。

---

## 1. 背景（30 秒）

- 对局架构：ECS HTTP 信使（`server/src/duel.mjs`，`/api/duel/invite|poll|leave`），
  房主权威 + 访客意图，1.2s 轮询。**语音链路零接触**（`protocol.ts` / `engine.ts` 未改动，
  这是硬约束，后面任何人都别碰）。
- AI 对战已按业主要求**全部删除**，只有真人 1v1。本地测试方式 = 同一浏览器开两个标签页
  （clientId 存 sessionStorage，每标签页独立）。
- 1.9.24 实测「邀请几秒消失、对方收不到」：服务端已排除（冒烟全绿），
  根因是客户端把 `/api/duel` 的 404/500 **吞成"没有对局"** 静默清掉等待层
  （业主测试时恰好撞上 ECS 部署窗口）。**修复已完成并提交**，就是待推送的 1.9.25。

---

## 2. 任务一：推送 v1.9.25（本地已就绪，只差 push）

**本地 git 现状**（截至 2026-11-04 15:30）：

```
main 领先 origin/main 3 个提交：
  73a7b7b release: v1.9.25          ← 版本号 4 处 + changelog
  68b1cf7 fix: 对局轮询非 200 抛错并提示连接状态（等待层不再无声消失）
  b2e50e7 docs: README 增加发版必检清单（server 不在 CI 里，1.9.24 /api/duel 404 事故记录）
tag app-v1.9.25 已打在 73a7b7b；工作树干净。
```

**推送**（业主代理端口 7890，时好时坏；两条路都试）：

```bash
cd /e/5blongv1.6.5/5blong
# 路 A：走代理（业主 15:38 前后代理似乎关了，先确认 7890 活着）
git push origin main && git push origin app-v1.9.25
# 路 B：直连（代理坏时用）
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.proxy" GIT_CONFIG_VALUE_0="" \
  git push origin main && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.proxy" GIT_CONFIG_VALUE_0="" \
  git push origin app-v1.9.25
```

推完 **GitHub Actions 的 `Release` 工作流自动构建发版**（约 3~8 分钟），
不用也不许手动 `npm run deploy:pages`。验证：

```bash
# CI 状态
node -e "fetch('https://api.github.com/repos/HeXiang96/5blong/actions/runs?per_page=1',{headers:{'User-Agent':'c'}}).then(r=>r.json()).then(d=>console.log(d.workflow_runs[0].name,d.workflow_runs[0].status,d.workflow_runs[0].conclusion))"
# 构建成功后核对更新源（version 应为 1.9.25）
curl -s https://5blong.site/desktop/latest.json | head -c 200
```

**注意**：
- `bump` 只在推送后由 CI 完成发布；**不要重跑 `npm run bump`**（tag 已存在会报错）。
- 如果 push 被 reject（远端又多了 CI 的 docs 提交），先 `git pull --rebase` 再推，
  tag 需要重打：`git tag -f app-v1.9.25 main && git push -f origin app-v1.9.25`。

---

## 3. 任务二：1.9.25 装好后的双设备实测（验收清单）

**前置**：两台设备**都重启客户端/刷新网页**（排掉 1.9.24 期间累积的旧状态）；
桌面端确认首页版本徽章 = 1.9.25。

| # | 步骤 | 期望 |
|---|---|---|
| 1 | A 创建/进入房间，B 加入 | 双方看到对方 |
| 2 | A 点 B 的猪 → 成员卡 → 梗王对局 | A 显示「等待对方接受」且**不再消失**（失败会显示原因） |
| 3 | B 弹「⚔️ A 邀你来一局」→ 接受 | 双方进入对局，各自的牌在下方（视角镜像） |
| 4 | A 出一张牌 / 打对方的猪 | B 在 ~1.5s 内看到同一结果 |
| 5 | 对局全程互说一句话 | **语音不断**（硬指标） |
| 6 | A 点「退出对局」（人留在房间） | B **立刻**看到「A 退出了对局」 |
| 7 | 四人房：ab 打牌，c/d 观察自己界面 | c、d 界面不变暗、可正常聊天；c 邀请 a 会提示「对方在另一局里」 |

**如果第 2/3 步失败**：1.9.25 的提示条会显示具体原因——
「对局服务暂时不可用，自动重试中…」= 服务端/网络问题（跑
`BASE=https://5blong.site node server/scripts/duel-smoke.mjs`，24 项全过则服务端无责）；
其他文案 = 客户端问题，把提示原文抄给业主。

---

## 4. 红线（历次事故总结，别踩）

1. **不碰 `src/client/voice/protocol.ts` / `engine.ts`**（语音链路）。
2. **发版只走 `npm run bump -- x.y.z` 推 GitHub**；`deploy:pages` 会把更新源盖坏
   （1.8.8 覆盖 1.8.9 事故），禁止手动跑。
3. **ECS 自动拉取**：静态站/桌面包有 sync 定时器（发版后 5/10 分钟内）；
   server 源码由业主安排部署（本次 /api/duel 已上线，勿重复部署）。
4. 版本号口径：新增功能默认 patch 位（1.9.x），不擅自升 minor。
5. 服务端问题先用冒烟定位：`BASE=https://5blong.site node server/scripts/duel-smoke.mjs`
   （会写测试局，2 小时自动清）。

---

## 5. 已知待办（非本次任务，别顺手做）

- **降噪模型瘦身**（P2）：18MB wasm 摘出安装包，方案见 README「已知待修」。
  动 CI 产物 + 客户端加载地址，需要服务器侧配合，单独一版做。
- **对战特效**：方案已定（快照日志分类驱动 CSS 动画），见 `src/client/duel/README.md`。
- 改对局任何内容（加卡/调数值/换 UI）前，先读 `src/client/duel/README.md` 的模块地图。
