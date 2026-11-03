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
import { writeFileSync } from "node:fs";
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

  server.on("connection", (client) => {
    try {
      const id = String(client.getId?.() ?? "");
      if (id.startsWith("5b-h-")) {
        liveHosts.set(id, Date.now());
        scheduleFlush();
      }
    } catch {
      /* 事件处理绝不能让信令挂掉 */
    }
  });
  server.on("disconnect", (client) => {
    try {
      const id = String(client.getId?.() ?? "");
      if (id.startsWith("5b-h-") && liveHosts.delete(id)) scheduleFlush();
    } catch {
      /* 同上 */
    }
  });

  return server;
}
