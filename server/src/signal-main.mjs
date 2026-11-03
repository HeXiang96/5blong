/**
 * 自建信令服务的启动入口（Node 版）。
 *
 * 与 CF 的 5blong-signal 是同一套协议，只是跑在 ECS 上：
 *   SIGNAL_PORT 默认 9001（9000 被 npm peer 包占着，切换前两者并存）
 *   SIGNAL_HOST 默认 127.0.0.1（只绑回环，对外一律走 nginx TLS）
 */
import { startSignalServer } from "./signal.mjs";

const port = Number(process.env.SIGNAL_PORT ?? 9001);
const host = process.env.SIGNAL_HOST ?? "127.0.0.1";

const server = startSignalServer({ port, host });
console.log(`[signal] listening on ${host}:${port}`);

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
