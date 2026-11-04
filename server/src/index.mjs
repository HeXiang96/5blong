/**
 * 5blong 自托管后端入口。
 *
 * 三个职责，一个进程：
 *   1. `/api/account/*` —— 账号、好友、邀请、敲门（SQLite）
 *   2. `/ice`           —— Cloudflare TURN 短期凭据
 *   3. `/healthz`       —— 存活与自检
 *
 * 信令（PeerJS）在**另一个进程**（`scripts/peer.mjs` 或同目录 peer 启动器），
 * 见 src/peer.mjs 里的说明。
 */

import express from "express";
import { CONFIG } from "./config.mjs";
import { closeDatabase, getDatabase } from "./db.mjs";
import { createApiRouter } from "./api.mjs";
import { createAdminRouter } from "./admin.mjs";
import { createIceHandler, iceStatus } from "./ice.mjs";
import { createGameRouter } from "./game.mjs";
import { createRoomsHarness } from "./rooms.mjs";
import { createSfuRouter, sfuStatus } from "./sfu.mjs";
import { createInboxHub } from "./inbox.mjs";
import { createFeedbackHandler } from "./feedback.mjs";
import { createDuelRouter } from "./duel.mjs";
import { corsHeaders } from "./http.mjs";

const db = getDatabase();
/*
 * 账号收件箱（推送）跑在这个进程里：推送的触发点就在邀请/好友的写入路径上，
 * 同进程是一次函数调用，跨进程还得多一条内部通道（见 inbox.mjs 文件头）。
 */
const inbox = createInboxHub(db);
/* 房间遥测：房主每 ~10 秒 POST 一次快照，这里合并进内存并落库 */
const rooms = createRoomsHarness(db);
const app = express();

app.disable("x-powered-by");
// nginx 在前面做 TLS，这里要信任 X-Forwarded-* 才能拿到真实协议与 IP
app.set("trust proxy", true);

/*
 * 请求体上限 1MB：头像是 dataURL，服务端自己限制 120000 字符（≈120KB），
 * 留到 1MB 是为了不让"稍微大一点就被框架拦掉"，错误由业务层给出更准确的提示。
 */
app.use(express.json({ limit: "1mb" }));
// 后台三个页面是传统表单提交（不是 fetch），要单独解析 x-www-form-urlencoded
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

/** 统一 CORS：与 worker 同口径（带 cookie 时回显 Origin，绝不回 *）。 */
app.use((req, res, next) => {
  for (const [key, value] of Object.entries(corsHeaders(req.headers.origin))) {
    res.setHeader(key, value);
  }
  next();
});

app.options("*", (req, res) => res.status(204).end());

app.get("/healthz", (req, res) => {
  let accounts = 0;
  try {
    accounts = Number(db.prepare("SELECT COUNT(*) AS n FROM accounts").first()?.n ?? 0);
  } catch {
    /* 表还没建好也不该让健康检查 500 */
  }
  res.status(200).json({
    ok: true,
    uptime: Math.round(process.uptime()),
    dbPath: CONFIG.dbPath,
    accounts,
    ...iceStatus(),
    ...sfuStatus(),
    ...inbox.stats(),
    ...rooms.stats(),
  });
});

app.get("/ice", createIceHandler());

/*
 * 反馈提交用 app.all：让非 POST 走到 handler 里返回 405（与 worker 一致），
 * 只用 app.post 的话 GET /feedback 会掉进 404，客户端拿到的错误码就不一样了。
 */
app.all("/feedback", createFeedbackHandler(db));

app.use("/api/account", createApiRouter(db, inbox));

/* 梗王对局信使：/api/duel/invite、/poll、/leave（docs/DUEL-NET-PLAN.md 方案 A） */
app.use("/api/duel", createDuelRouter(db));

/* 开黑圈：/game/entitle、/game/verify、/game-admin（后台页） */
app.use(createGameRouter(db));

/* 房间遥测：POST /api/rooms/snapshot */
app.use("/api", rooms.router);

/* 屏幕共享：/sfu/* → rtc.live.cloudflare.com（补 Bearer 密钥） */
app.use(createSfuRouter());

/*
 * 后台三页：/admin（反馈）、/accounts-admin（账号）、/rooms（在线房间），
 * 外加 /reset（用户凭管理员发的链接自助改密码）。
 * 全部由 `FEEDBACK_TOKEN` 保护（/reset 除外，它靠签名令牌）。
 */
app.use(createAdminRouter(db));

// 未命中任何路由
app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

/*
 * 兜底错误处理。
 * 对外只说 "internal"：数据库报错信息里可能带表名、字段名，
 * 那是给攻击者做减法用的，不该出现在响应里。真正的原因写服务端日志。
 */
app.use((error, req, res, next) => {
  console.error(`[api] ${req.method} ${req.originalUrl} →`, error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "internal" });
});

const server = app.listen(CONFIG.port, CONFIG.host, () => {
  const turn = iceStatus().turnConfigured
    ? `本机 coturn（${iceStatus().turnHost}）`
    : "未配置（客户端会退回纯 STUN）";
  console.log(
    [
      "5blong-server 已启动",
      `  接口    http://${CONFIG.host}:${CONFIG.port}`,
      `  数据库  ${CONFIG.dbPath}`,
      `  TURN    ${turn}`,
      `  收件箱  ws://${CONFIG.host}:${CONFIG.port}/peerjs/inbox`,
      `  cookie  ${CONFIG.cookieSecure ? "Secure（生产）" : "非 Secure（本地调试）"}`,
    ].join("\n"),
  );
});

/*
 * 收件箱走同一个 HTTP server 的 Upgrade 事件。
 * 不能挂到 express 路由上：express 不处理协议升级，挂上去只会 404。
 */
server.on("upgrade", (req, socket, head) => {
  if (inbox.handleUpgrade(req, socket, head)) return;
  // 其余路径的升级请求没人接，明确关掉，避免连接半开挂着
  socket.destroy();
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭…`);
  inbox.close();
  rooms.close();
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  // 10 秒还没关干净就强制退出，别让 systemd 一直等
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
