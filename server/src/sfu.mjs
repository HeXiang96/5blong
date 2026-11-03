/**
 * 屏幕共享的 SFU 反向代理（原来在 Pages Worker 里）。
 *
 * 为什么要自己代理一层，而不是让客户端直接调 Cloudflare：
 *   1. **密钥不能下发前端**。SFU 的 App Secret 是长期凭据，放前端等于公开。
 *      代理层负责补 `Authorization: Bearer <secret>`。
 *   2. 顺手做**路径白名单**：只放行发布/订阅需要的 5 个接口。
 *      SFU 本身没有"房间"概念，会话 ID 是 256 位随机串、只在房间内分发，
 *      代理层不开其他口子就少一类被刷的风险。
 *
 * 注意：这里只是把**入口**搬到自己的服务器，SFU 服务本身仍在
 * `rtc.live.cloudflare.com`。真要脱离 Cloudflare，得自己跑 mediasoup/Pion，
 * 那是另一个工程（见 README 的"仍未搬走"部分）。
 */

import express from "express";
import { Readable } from "node:stream";

const SFU_BASE = "https://rtc.live.cloudflare.com/v1";

/** 只放行这几条，别的一律 404（和原实现一致） */
const ROUTES = [
  { method: "POST", pattern: /^\/sessions\/new$/ },
  { method: "POST", pattern: /^\/sessions\/[\w-]+\/tracks\/new$/ },
  { method: "PUT", pattern: /^\/sessions\/[\w-]+\/renegotiate$/ },
  { method: "PUT", pattern: /^\/sessions\/[\w-]+\/tracks\/close$/ },
  { method: "GET", pattern: /^\/sessions\/[\w-]+$/ },
];

export function sfuStatus() {
  return {
    sfuConfigured: Boolean(process.env.SFU_APP_ID && process.env.SFU_APP_SECRET),
  };
}

export function createSfuRouter() {
  const router = express.Router();

  router.use("/sfu", async (req, res) => {
    /*
     * CORS 预检：桌面端从 tauri.localhost 跨域调用，浏览器必发 OPTIONS。
     * 不答它，桌面端发布会**静默失败**（网页端同源，看不到这个问题）。
     */
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Max-Age", "86400");
      return res.status(204).end();
    }

    const appId = process.env.SFU_APP_ID ?? "";
    const appSecret = process.env.SFU_APP_SECRET ?? "";
    if (!appId || !appSecret) {
      return res.status(500).json({ error: "sfu not configured" });
    }

    // /sfu/sessions/... 或旧的单数 /sfu/session/... → /sessions/...
    const sub = req.path.replace(/^\/sessions?\//, "/sessions/").replace(/^\//, "/");
    const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(sub));
    if (!route) return res.status(404).json({ error: "not found" });

    const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    const body =
      req.method === "GET" || req.body === undefined || req.body === null
        ? undefined
        : JSON.stringify(req.body);

    let upstream;
    try {
      upstream = await fetch(`${SFU_BASE}/apps/${appId}${sub}${query}`, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${appSecret}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (error) {
      return res.status(502).json({ error: `sfu unreachable: ${error.message}` });
    }

    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!upstream.body) return res.end();
    // 流式转发：SDP 可能不小，不要整段读进内存
    Readable.fromWeb(upstream.body).pipe(res);
  });

  return router;
}
