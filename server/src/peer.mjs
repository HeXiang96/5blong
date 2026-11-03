/**
 * PeerJS 信令服务（独立进程、独立端口）。
 *
 * 为什么要独立而不是挂进 express：
 *   PeerJS 服务端自己接管 `/peerjs` 路径与 WebSocket 升级，挂到现有 express
 *   上要处理 path 重写（客户端会把 `peerjs` 拼在 path 后面），
 *   一旦拼错就是"连不上、但看不出为什么"。独立进程 + nginx 原样转发
 *   `/peerjs` 到本端口，路径完全不用改，出错也容易定位（单独看它的日志）。
 *
 * 为什么独立进程还有个好处：它崩了不影响账号接口（反之亦然）。
 */

import { createRequire } from "node:module";
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { CONFIG } from "./config.mjs";

const require = createRequire(import.meta.url);

/** 在线房号快照文件（后台面板读它，见下面的观测钩子）。 */
const LIVE_ROOMS_FILE = "/data/5blong/live-rooms.json";

export function startPeerServer() {
  const pkg = require("peer");
  // `peer` 是 CJS 包，导出形状随版本变过，这里两种都兜住
  const PeerServer = pkg.PeerServer ?? pkg.default?.PeerServer ?? pkg.default;
  if (typeof PeerServer !== "function") {
    throw new Error("peer 包导出里找不到 PeerServer，请检查 peer 版本");
  }

  const server = PeerServer({
    port: CONFIG.peerPort,
    // 只绑回环：9000 是内部端口，对外一律走 nginx（TLS）。
    // 绑 0.0.0.0 会让别人能直接连明文 ws://，绕过证书与限流。
    host: CONFIG.host,
    /*
     * path 必须留 '/'：PeerJS 客户端在拼接地址时会自动追加 `peerjs`，
     * 于是最终 URL 是 `wss://<host>/peerjs?...`。
     * 这正好和我们客户端 `SIGNAL_ROUTES` 里的用法一致（客户端不传 path，默认 '/'）。
     */
    path: "/",
    key: "peerjs",
    // 不对外暴露 peer 列表：谁在哪个 id 上是私事
    allow_discovery: false,
    /*
     * 判死时间：默认 60000ms，这里抬到 180000（2026-11-03）。
     *
     * 为什么必须抬：客户端心跳是 5 秒一次，但它跑在**主线程**——标签页切到后台时
     * 浏览器会把定时器压到约 1 分钟一次，正好卡在 60 秒的生死线上。
     * 一旦被判死，服务端就把 `5b-h-<房号>` 从注册表里摘掉，别人来加就是
     * "房主不在线"；房主自己界面上一切正常（他压根不知道）。
     * 实测证据：同一个人同一个房号 25 分钟里重新注册 6 次。
     *
     * 代价：断线的 peer 会多占 3 分钟同 ID 名额。对私有房号来说无所谓。
     */
    alive_timeout: 180_000,
    // 前面有 nginx 做 TLS 终止
    proxied: true,
    debug: false,
  });

  /*
   * ---- 在线房号观测（2026-11-03）----
   *
   * 后台面板原先只能看"客户端主动上报"的房间（/api/rooms/snapshot）。
   * 房主的网络连不上我们服务器时（正是他会掉到兜底线路的原因），上报也发不出去，
   * 面板就查无此房 —— CF 时代不会这样，因为那时信令是自己的 Worker，
   * 服务端自己数人头（面板向它要 /rooms-live）。
   *
   * 现在信令虽然换成了开源 `peer` 包，但它暴露了 connection / disconnect 事件，
   * 客户端 id 就是 `5b-h-<房号>`。这里把在线房号写成一个快照文件，
   * 后台读它就能知道"这个房号此刻确实有人挂着"，不依赖客户端上报。
   *
   * 只记房号与连接时刻，不记 IP、不记成员 —— 与后台原有的隐私口径一致。
   */
  const liveHosts = new Map();
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    try {
      const rooms = [...liveHosts.entries()].map(([id, since]) => ({
        id,
        code: id.replace(/^5b-h-/, ""),
        since,
      }));
      writeFileSync(LIVE_ROOMS_FILE, JSON.stringify({ at: Date.now(), rooms }));
    } catch {
      /* 写不进去不影响信令本身 */
    }
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 200);
  };

  /*
   * 周期性重写快照（2026-11-03 业主实测："房间明明在，面板显示 0"）。
   *
   * 只在连接/断开时写的话，房间稳定挂着时文件时间戳不再更新，
   * 后台的"超过 60 秒视为过期"会把它整份丢掉 —— 看起来就是"房号消失了"。
   * 这里每 20 秒重写一次，时间戳保持新鲜；unref 保证不影响进程退出。
   */
  const keepFresh = setInterval(flush, 20_000);
  keepFresh.unref?.();

  /*
   * client → id 的对照表（2026-11-03 修"幽灵房间"）。
   *
   * 断开时 `client.getId()` 可能已经取不到值，于是 `liveHosts` 里那条永远删不掉，
   * 面板就会一直显示已经关掉的房号（实测 702621 在房主离开后还挂在上面）。
   * 连上的时候把 id 记在 client 对象上（WeakMap，不阻止回收），断开时直接取。
   */
  const clientIds = new WeakMap();

  server.on("connection", (client) => {
    try {
      const id = String(client.getId?.() ?? "");
      if (id.startsWith("5b-h-")) {
        clientIds.set(client, id);
        liveHosts.set(id, Date.now());
        scheduleFlush();
      }
    } catch {
      /* 事件处理绝不能让信令挂掉 */
    }
  });
  server.on("disconnect", (client) => {
    try {
      const id = clientIds.get(client) ?? String(client.getId?.() ?? "");
      if (id.startsWith("5b-h-") && liveHosts.delete(id)) scheduleFlush();
    } catch {
      /* 同上 */
    }
  });

  /*
   * ---- 信令消息追踪（2026-11-03 临时诊断）----
   *
   * 现象："进房握手不上" / "某两个人语音永远 ice=new"，
   * 但服务器这边看不见到底是 OFFER 没到、还是 ANSWER 没回。
   * `peer` 包会为每条信令消息抛 message 事件（已带 src），这里只**记录**，
   * 不参与转发，出错也不会影响信令。
   *
   * 只记 type/src/dst，不记 SDP、不记候选内容（无隐私风险）。
   * 心跳（HEARTBEAT）太吵，直接跳过。
   */
  const TRACE_FILE = "/data/5blong/signal-trace.log";
  let traceBytes = 0;
  try {
    traceBytes = statSync(TRACE_FILE).size;
  } catch {
    traceBytes = 0;
  }
  const trace = (line) => {
    try {
      if (traceBytes > 5_000_000) {
        writeFileSync(TRACE_FILE, "");
        traceBytes = 0;
      }
      appendFileSync(TRACE_FILE, line + "\n");
      traceBytes += line.length + 1;
    } catch {
      /* 写不进就算了，绝不能影响信令 */
    }
  };

  server.on("message", (client, message) => {
    try {
      const type = String(message?.type ?? "");
      if (!type || type === "HEARTBEAT") return;
      const src = String(message?.src ?? client?.getId?.() ?? "");
      const dst = String(message?.dst ?? "");
      /*
       * 附带两个纯技术字段，用来区分"哪一类协商、什么候选"：
       *   kind  = data | media（这条 OFFER/ANSWER 是数据通道还是语音/画面）
       *   typ   = host | srflx | prflx | relay（候选类型，判断中继有没有被用上）
       *   proto = udp | tcp
       * 都是候选串里的标准字段，不含 IP、不含 SDP。
       */
      let extra = "";
      const kind = message?.payload?.type;
      if (kind === "data" || kind === "media") extra += ` kind=${kind}`;
      if (type === "CANDIDATE") {
        const raw = String(message?.payload?.candidate?.candidate ?? "");
        const proto = /(udp|tcp)/i.exec(raw);
        const typ = /typ\s+(\w+)/i.exec(raw);
        extra += ` typ=${typ ? typ[1] : "?"} proto=${proto ? proto[1].toLowerCase() : "?"}`;
      }
      trace(`${new Date().toISOString()} ${type} ${src} -> ${dst || "-"}${extra}`);
    } catch {
      /* 同上 */
    }
  });
  server.on("close", (client) => {
    try {
      trace(`${new Date().toISOString()} DISCONNECT ${String(client?.getId?.() ?? "?")}`);
    } catch {
      /* noop */
    }
  });

  return server;
}
