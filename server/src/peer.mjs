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
import { CONFIG } from "./config.mjs";

const require = createRequire(import.meta.url);

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

  return server;
}
