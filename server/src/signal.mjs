/**
 * 自建信令服务（Node 版，PeerJS 协议兼容）。
 *
 * 移植自 `worker/signal/index.js`（Cloudflare Durable Object 版，生产跑过 1.5.0~1.9.5）。
 * 只替换**信令服务器**，不碰客户端：入口仍然是 nginx 的 `/peerjs`。
 *
 * 协议（与 peerjs 客户端逐条对齐）：
 *   连接：wss://<host>/peerjs?key=peerjs&id=<peerId>&token=..&version=..
 *   C→S：OFFER / ANSWER / CANDIDATE（带 dst）、HEARTBEAT、LEAVE
 *   S→C：OPEN、ID-TAKEN、EXPIRE、原样转发的 OFFER / ANSWER / CANDIDATE
 *
 * 相比 npm `peer` 包多做的三件事：
 *   1. **OFFER 暂存重投**：目标刚好在重连那 1~2 秒，OFFER 先压住，人回来了立刻投；
 *      压不住才回 EXPIRE（客户端据此报"房主不在线"）。
 *   2. **服务端知情**：谁在线、谁在向谁打，都能直接查（/health、/peers）。
 *   3. **判死时间自己定**：默认 180 秒（与 nginx 侧的原设置一致）。
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

/** 多久没收到任何消息就判死（客户端 5 秒一次心跳，180 秒 = 容 36 拍）。 */
const ALIVE_TIMEOUT_MS = 180_000;
/** 巡检间隔。 */
const SWEEP_MS = 5_000;
/** OFFER 最多压多久（给对面重连留的窗口）。 */
const PENDING_OFFER_MS = 2_500;
/** 同时最多压多少条，防止被打爆。 */
const PENDING_MAX = 200;

/**
 * @param {{ port: number, host: string, path?: string }} options
 */
export function startSignalServer(options) {
  const { port, host, path = "/peerjs" } = options;

  /** id → { ws, since, lastSeen } */
  const clients = new Map();
  /** dst → [{ msg, timer }]，只用于 OFFER */
  const pending = new Map();
  let pendingCount = 0;

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          clients: clients.size,
          rooms: [...clients.keys()].filter((id) => id.startsWith("5b-h-")).length,
          pending: pendingCount,
        }),
      );
      return;
    }
    // peerjs 客户端偶尔会来要一个随机 id（我们总是自带 id，但留着不影响）
    if (url.pathname === "/peerjs/id") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`5b-g-${randomUUID().replace(/-/g, "").slice(0, 10)}`);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const wss = new WebSocketServer({ server: http, path });

  const sendJson = (ws, payload) => {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    } catch {
      /* 对端已断，忽略 */
    }
  };

  const dropPending = (dst) => {
    const list = pending.get(dst);
    if (!list) return;
    pending.delete(dst);
    pendingCount -= list.length;
    for (const item of list) clearTimeout(item.timer);
  };

  const deliver = (dst, msg) => {
    const target = clients.get(dst);
    if (!target) return false;
    sendJson(target.ws, msg);
    return true;
  };

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", "http://internal");
    const id = (url.searchParams.get("id") ?? "").trim();
    if (!id) {
      sendJson(ws, { type: "ERROR", payload: "missing id" });
      ws.close();
      return;
    }

    const existing = clients.get(id);
    if (existing && existing.ws !== ws) {
      // 与 peerjs 服务端一致：新连接被拒，老连接保留（房主撞码时客户端会换 id 重试）
      sendJson(ws, { type: "ID-TAKEN", payload: { msg: `ID ${id} is taken` } });
      ws.close();
      return;
    }

    clients.set(id, { ws, since: Date.now(), lastSeen: Date.now() });
    sendJson(ws, { type: "OPEN" });

    // 有人回来了：把压着的 OFFER 立刻投出去
    const waiting = pending.get(id);
    if (waiting && waiting.length) {
      pending.delete(id);
      pendingCount -= waiting.length;
      for (const item of waiting) {
        clearTimeout(item.timer);
        deliver(id, item.msg);
      }
    }

    ws.on("message", (raw) => {
      const self = clients.get(id);
      if (self) self.lastSeen = Date.now();
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;
      // src 一律以服务端认定的 id 为准，防止伪造
      msg.src = id;

      switch (msg.type) {
        case "HEARTBEAT":
          sendJson(ws, { type: "HEARTBEAT" });
          return;
        case "LEAVE":
          clients.delete(id);
          ws.close();
          return;
        case "OFFER":
        case "ANSWER":
        case "CANDIDATE": {
          const dst = String(msg.dst ?? "");
          if (!dst) return;
          if (deliver(dst, msg)) return;

          // 目标不在：OFFER 先压住，给人一个重连窗口；其余直接告诉对方"他不在"
          if (msg.type === "OFFER" && pendingCount < PENDING_MAX) {
            const list = pending.get(dst) ?? [];
            const timer = setTimeout(() => {
              const after = pending.get(dst);
              if (after) {
                const idx = after.indexOf(entry);
                if (idx >= 0) after.splice(idx, 1);
                if (after.length === 0) pending.delete(dst);
                pendingCount -= 1;
              }
              // 压到最后还是没人：明确回 EXPIRE（客户端据此报"房主不在线"）
              sendJson(ws, { type: "EXPIRE", src: dst });
            }, PENDING_OFFER_MS);
            const entry = { msg, timer };
            list.push(entry);
            pending.set(dst, list);
            pendingCount += 1;
            return;
          }
          sendJson(ws, { type: "EXPIRE", src: dst });
          return;
        }
        default:
          // 未知类型一律忽略：老/新客户端发什么都不能让信令崩
          return;
      }
    });

    const cleanup = () => {
      const self = clients.get(id);
      if (self && self.ws === ws) clients.delete(id);
      dropPending(id);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, rec] of clients) {
      if (now - rec.lastSeen <= ALIVE_TIMEOUT_MS) continue;
      clients.delete(id);
      try {
        rec.ws.terminate();
      } catch {
        /* noop */
      }
    }
  }, SWEEP_MS);
  sweeper.unref?.();

  http.listen(port, host);

  return {
    stats: () => ({ clients: clients.size, pending: pendingCount }),
    close: () => {
      clearInterval(sweeper);
      for (const rec of clients.values()) {
        try {
          rec.ws.terminate();
        } catch {
          /* noop */
        }
      }
      clients.clear();
      wss.close();
      http.close();
    },
  };
}
