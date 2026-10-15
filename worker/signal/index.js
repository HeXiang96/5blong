/**
 * 5blong 自建信令服务（PeerJS 协议兼容）。
 *
 * 为什么要自建：公共 PeerJS 云（0.peerjs.com）**会对我们的 WebSocket 握手返回
 * Cloudflare 1020**（按浏览器签名封禁），部分用户完全进不去房间；借自家域名中转
 * 也没用（它连我们 Worker 的服务器请求一起拦）。所以自己实现服务端那一半。
 *
 * 保留的是 **PeerJS 客户端库**（浏览器里的 WebRTC 管道），只换掉服务器：
 * 协议是 WebSocket 上的几条 JSON 消息，客户端不必改（见 worker/signal/README 的推导）。
 *
 * 协议（从 node_modules/peerjs/dist/peerjs.js 逐条核对）：
 *   连接：wss://<host>/peerjs?key=<key>&id=<peerId>&token=..&version=..
 *  ↑ 客户端 → 服务端：
 *     { type:"OFFER"|"ANSWER"|"CANDIDATE", payload:{ sdp|candidate, type, connectionId }, dst }
 *     { type:"HEARTBEAT" }                         ← 每 5 秒一次，精确字符串
 *  ↓ 服务端 → 客户端：
 *     { type:"OPEN" }                              ← 注册成功
 *     { type:"ID-TAKEN", payload:{ msg } }         ← id 被占用（房主撞码 → 换码重试）
 *     { type:"EXPIRE", src:<dst> }                 ← 目标不存在 → 客户端报"房主不在线"
 *     { type:"LEAVE", src:<id> }                   ← 对端断开
 *     { type:"OFFER"|"ANSWER"|"CANDIDATE", src:<发送者>, payload }  ← 原样转发
 *
 * 成本控制（Workers 免费额度：10 万请求/天，13,000 GB·s/天）：
 *   - 用 **WebSocket 休眠 API**：空闲时不占计算时长（否则一个常驻 DO 每天要烧
 *     ~11,000 GB·s，几乎吃满免费额度）；
 *   - 心跳用 **setWebSocketAutoResponse** 精确匹配自动应答：不唤醒、不计费
 *     （否则每人每 5 秒一条心跳，几十人就能把请求额度烧掉一半）；
 *   - **出站消息不计费**，所以断开时广播 LEAVE 不必省。
 */
export class SignalHub {
  constructor(state) {
    this.state = state;
    /*
     * 心跳自动应答：客户端每隔 5 秒发一条 `{"type":"HEARTBEAT"}`（JSON.stringify
     * 无空格），这里按精确字符串匹配直接回一条，**不唤醒对象、不计入请求**。
     */
    try {
      this.state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair('{"type":"HEARTBEAT"}', '{"type":"HEARTBEAT"}'),
      );
    } catch {
      /* 老运行时没有这个 API：心跳会走 webSocketMessage（仅计算量增加，功能不受影响） */
    }
  }

  /** 当前在线的 id → WebSocket。休眠唤醒后内存会丢，所以每次从会话列表重建。 */
  #peers() {
    const map = new Map();
    for (const ws of this.state.getWebSockets()) {
      let id = null;
      try {
        id = ws.deserializeAttachment()?.id ?? null;
      } catch {
        id = null;
      }
      if (id) map.set(id, ws);
    }
    return map;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 非升级请求：只提供 /id 取号端点（客户端没指定 id 时才会用），其余给个健康检查
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      if (url.pathname.endsWith("/id")) {
        return new Response(crypto.randomUUID(), {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
        });
      }
      return new Response("5blong signal hub", { status: 200 });
    }

    const id = (url.searchParams.get("id") ?? "").trim();
    if (!id) return new Response("missing id", { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // 同 id 已有活跃连接 → ID-TAKEN（房主撞码时引擎会换一个新码整体重试）
    for (const ws of this.state.getWebSockets()) {
      let taken = null;
      try {
        taken = ws.deserializeAttachment()?.id ?? null;
      } catch {
        taken = null;
      }
      if (taken === id) {
        this.state.acceptWebSocket(server);
        server.send(JSON.stringify({ type: "ID-TAKEN", payload: { msg: `ID "${id}" is taken` } }));
        server.close(1000, "id taken");
        return new Response(null, { status: 101, webSocket: client });
      }
    }

    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id });
    server.send(JSON.stringify({ type: "OPEN" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 收到客户端消息：转发给对方，或者回 EXPIRE（目标不在线）。 */
  async webSocketMessage(ws, raw) {
    const id = this.#idOf(ws);
    if (!id) return;
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const type = message?.type;
    if (type === "HEARTBEAT") {
      // 正常由自动应答处理；走到这里说明运行时没有该 API，回一条保持客户端心跳逻辑
      try {
        ws.send('{"type":"HEARTBEAT"}');
      } catch {
        /* 已断开 */
      }
      return;
    }
    if (type !== "OFFER" && type !== "ANSWER" && type !== "CANDIDATE") return;

    const dst = message?.dst;
    if (typeof dst !== "string" || !dst) return;
    const target = this.#peers().get(dst);
    if (!target) {
      // 目标不在线：回 EXPIRE + src，客户端据此报 "peer-unavailable"（房主不在线/邀请失效）
      try {
        ws.send(JSON.stringify({ type: "EXPIRE", src: dst }));
      } catch {
        /* 已断开 */
      }
      return;
    }
    try {
      target.send(JSON.stringify({ type, src: id, payload: message.payload }));
    } catch {
      /* 目标刚断开：让它自己超时重试 */
    }
  }

  /** 连接关闭：广播 LEAVE（出站消息不计费，广播最省心也最不容易漏）。 */
  async webSocketClose(ws) {
    const id = this.#idOf(ws);
    if (!id) return;
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      try {
        other.send(JSON.stringify({ type: "LEAVE", src: id }));
      } catch {
        /* 已断开 */
      }
    }
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }

  #idOf(ws) {
    try {
      return ws.deserializeAttachment()?.id ?? null;
    } catch {
      return null;
    }
  }
}

export default {
  async fetch(request, env) {
    // 单实例总机（房主/访客都是短消息，量级远低于单 DO 的处理能力；
    // 真要分片，可按 key 或 id 前缀取多个 DO，扩展时再改）。
    const hub = env.SIGNAL_HUB.get(env.SIGNAL_HUB.idFromName("hub"));
    return hub.fetch(request);
  },
};
