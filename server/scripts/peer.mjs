#!/usr/bin/env node
/**
 * 启动 PeerJS 信令服务（独立进程）。
 *
 * 用法：node scripts/peer.mjs
 * systemd 里就是这一行（见 deploy/5blong-peer.service）。
 */

import { startPeerServer } from "../src/peer.mjs";
import { CONFIG } from "../src/config.mjs";

try {
  startPeerServer();
  console.log(
    [
      "5blong-peer 已启动",
      `  信令    ws://127.0.0.1:${CONFIG.peerPort}/peerjs`,
      "  对外    由 nginx 转发 /peerjs（含 WebSocket 升级）",
    ].join("\n"),
  );
} catch (error) {
  console.error("信令服务启动失败：", error.message);
  process.exit(1);
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
