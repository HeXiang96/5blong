/**
 * 5blong 自建信令服务（PeerJS 协议兼容）+ 房间遥测。
 *
 * 为什么要自建：公共 PeerJS 云（0.peerjs.com）**会对我们的 WebSocket 握手返回
 * Cloudflare 1020**（按浏览器签名封禁），部分用户完全进不去房间；借自家域名中转
 * 也没用（它连我们 Worker 的服务器请求一起拦）。所以自己实现服务端那一半。
 *
 * 保留的是 **PeerJS 客户端库**（浏览器里的 WebRTC 管道），只换掉服务器：
 * 协议是 WebSocket 上的几条 JSON 消息，客户端不必改（协议推导见 git 历史）。
 *
 * 协议（从 node_modules/peerjs/dist/peerjs.js 逐条核对）：
 *   连接：wss://<host>/peerjs?key=<key>&id=<peerId>&token=..&version=..
 *  ↑ 客户端 → 服务端：
 *     { type:"OFFER"|"ANSWER"|"CANDIDATE", payload:{ sdp|candidate, type, connectionId }, dst }
 *     { type:"HEARTBEAT" }                         ← 每 5 秒一次，精确字符串
 *     { type:"ROOM-SNAPSHOT", payload:{...} }      ← 房主房间遥测（本服务自有扩展）
 *  ↓ 服务端 → 客户端：
 *     { type:"OPEN" }                              ← 注册成功
 *     { type:"ID-TAKEN", payload:{ msg } }         ← id 被占用（房主撞码 → 换码重试）
 *     { type:"EXPIRE", src:<dst> }                 ← 目标不存在 → 客户端报"房主不在线"
 *     { type:"LEAVE", src:<id> }                   ← 对端断开
 *     { type:"OFFER"|"ANSWER"|"CANDIDATE", src:<发送者>, payload }  ← 原样转发
 *
 * 房间遥测（ROOM-SNAPSHOT，仅房主发送）：
 *   payload = { sessionId, code, createdAt, runtime, version,
 *               members: [{ key, name, joinedAt, rttSum, rttCount, rttMax,
 *                           jitterMax, lossPct, link, reconnects, speakingS,
 *                           leftAt?, runtime, version }],
 *               events: [{ at, kind, detail }],
 *               share: { active, totalS, transport, last } }
 *   - 实时态存在 **内存**（面板经 service binding 查 /rooms-live，零数据库读放大）；
 *   - **历史档案写 D1**（低频）：会话开始 1 行、峰值变化才更新、每 5 分钟人数采样、
 *     成员离开/会话结束时落成员明细 —— 免费额度（10 万行写/天）用量 ~1%；
 *   - **隐私**：房间码明文（运营者自查）；成员匿名编号 + 昵称（业主确认收集）；
 *     IP 只存不可逆哈希；**永不存**聊天内容 / 麦克风 / 屏幕画面。
 *
 * 成本控制（Workers 免费额度：10 万请求/天，13,000 GB·s/天）：
 *   - **WebSocket 休眠 API**：空闲时不占计算时长；
 *   - 心跳 **setWebSocketAutoResponse** 精确匹配自动应答：不唤醒、不计请求；
 *   - **出站消息不计费**，断开时广播 LEAVE 不必省。
 */
export class SignalHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /*
     * 房间实时态：hostPeerId → { sessionId, code, createdAt, members: Map, peak, ... }。
     * 内存态，随快照不断重建（宿主每 ~10 秒发一次快照会唤醒本对象并刷新）；
     * DO 被回收后最多丢失几秒的实时展示，历史档案在 D1，不受影响。
     */
    this.rooms = new Map();
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

  #idOf(ws) {
    try {
      return ws.deserializeAttachment()?.id ?? null;
    } catch {
      return null;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 房间实时态查询（Pages Worker 校验令牌后带 x-admin-token 转发进来）
    if (url.pathname === "/rooms-live") {
      const token = request.headers.get("x-admin-token") ?? url.searchParams.get("token") ?? "";
      if (!this.env.FEEDBACK_TOKEN || !safeEqualStr(token, this.env.FEEDBACK_TOKEN)) {
        return json({ error: "unauthorized" }, 401);
      }
      const rooms = [];
      for (const room of this.rooms.values()) {
        rooms.push({
          sessionId: room.sessionId,
          code: room.code,
          createdAt: room.createdAt,
          runtime: room.runtime,
          version: room.version,
          members: [...room.members.values()],
          peak: room.peak,
          share: room.share,
        });
      }
      return json({ online: rooms.length, members: rooms.reduce((s, r) => s + liveCount(r), 0), rooms }, 200);
    }

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

  /** 收到客户端消息：转发给对方，或者回 EXPIRE（目标不在线）；房主快照进遥测。 */
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
    if (type === "ROOM-SNAPSHOT") {
      await this.#onRoomSnapshot(id, message.payload);
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

  /** 连接关闭：广播 LEAVE（出站消息不计费）；若是房主，落历史档案。 */
  async webSocketClose(ws) {
    const id = this.#idOf(ws);
    if (!id) return;
    if (this.rooms.has(id)) {
      await this.#finalizeRoom(id, "closed");
      this.rooms.delete(id);
    }
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

  // ------------------------------------------------------------ 房间遥测

  async #onRoomSnapshot(hostId, payload) {
    if (!payload || typeof payload !== "object") return;
    let room = this.rooms.get(hostId);
    const nowIso = new Date().toISOString();

    if (!room) {
      // 新会话：落一行档案（D1 不可用不影响实时功能）
      room = {
        sessionId: String(payload.sessionId ?? "").slice(0, 64) || `s-${Date.now()}`,
        code: String(payload.code ?? "").slice(0, 16),
        createdAt: String(payload.createdAt ?? nowIso).slice(0, 32),
        hostId,
        runtime: clampStr(payload.runtime, 20),
        version: clampStr(payload.version, 40),
        members: new Map(),
        peak: 1,
        lastSampleAt: 0,
        share: { active: false, totalS: 0, transport: "", last: "" },
        lastEventAt: "",
        archived: false,
      };
      this.rooms.set(hostId, room);
      await this.#db(`INSERT INTO room_sessions (id, code, created_at, peak_members, host_runtime, host_version)
                      VALUES (?, ?, ?, 1, ?, ?)`,
        [room.sessionId, room.code, room.createdAt, room.runtime, room.version]).catch(() => {});
    }

    room.code = clampStr(payload.code, 16) || room.code;
    room.runtime = clampStr(payload.runtime, 20) || room.runtime;
    room.version = clampStr(payload.version, 40) || room.version;
    room.share = {
      active: payload.share?.active === true,
      totalS: Math.max(0, Math.round(Number(payload.share?.totalS) || 0)),
      transport: clampStr(payload.share?.transport, 16),
      last: clampStr(payload.share?.last, 32),
    };

    // 成员：以 key 为准合并（离开的成员保留 leftAt，供历史展示）
    for (const m of Array.isArray(payload.members) ? payload.members.slice(0, 64) : []) {
      const key = clampStr(m?.key, 64);
      if (!key) continue;
      const prev = room.members.get(key);
      room.members.set(key, {
        key,
        name: clampStr(m?.name, 24),
        joinedAt: String(m?.joinedAt ?? prev?.joinedAt ?? nowIso).slice(0, 32),
        leftAt: m?.leftAt ? String(m.leftAt).slice(0, 32) : (prev?.leftAt ?? null),
        rttSum: Math.max(0, Number(m?.rttSum) || 0),
        rttCount: Math.max(0, Number(m?.rttCount) || 0),
        rttMax: Math.max(0, Number(m?.rttMax) || 0),
        jitterMax: Math.max(0, Number(m?.jitterMax) || 0),
        lossPct: Math.max(0, Math.min(100, Number(m?.lossPct) || 0)),
        link: clampStr(m?.link, 12),
        reconnects: Math.max(0, Math.round(Number(m?.reconnects) || 0)),
        speakingS: Math.max(0, Math.round(Number(m?.speakingS) || 0)),
        runtime: clampStr(m?.runtime, 20),
        version: clampStr(m?.version, 40),
      });
    }

    const live = [...room.members.values()].filter((m) => !m.leftAt).length;
    if (live > room.peak) {
      room.peak = live;
      await this.#db("UPDATE room_sessions SET peak_members = ? WHERE id = ?", [room.peak, room.sessionId]).catch(() => {});
    }

    // 人数曲线采样：约每 5 分钟一点
    if (Date.now() - room.lastSampleAt > 5 * 60_000) {
      room.lastSampleAt = Date.now();
      await this.#db("INSERT OR REPLACE INTO room_samples (session_id, at, members) VALUES (?, ?, ?)",
        [room.sessionId, nowIso, live]).catch(() => {});
    }

    // 事件流水：只收比上次新的（客户端按时间排序发送）
    for (const ev of Array.isArray(payload.events) ? payload.events.slice(-20) : []) {
      const at = String(ev?.at ?? "").slice(0, 32);
      const kind = clampStr(ev?.kind, 24);
      if (!at || !kind || at <= room.lastEventAt) continue;
      room.lastEventAt = at > room.lastEventAt ? at : room.lastEventAt;
      await this.#db("INSERT INTO room_events (session_id, at, kind, detail) VALUES (?, ?, ?, ?)",
        [room.sessionId, at, kind, clampStr(ev?.detail, 200)]).catch(() => {});
    }
  }

  /** 会话结束：把结束信息与成员明细落库（房主关房 / 断线 / 崩溃都走这里）。 */
  async #finalizeRoom(hostId, reason) {
    const room = this.rooms.get(hostId);
    if (!room) return;
    const nowIso = new Date().toISOString();
    const created = Date.parse(room.createdAt);
    const durationS = Number.isFinite(created) ? Math.max(0, Math.round((Date.now() - created) / 1000)) : null;
    await this.#db(
      "UPDATE room_sessions SET ended_at = ?, duration_s = ?, peak_members = ?, snapshot_json = ? WHERE id = ?",
      [nowIso, durationS, room.peak, JSON.stringify({ reason, members: [...room.members.values()], share: room.share }).slice(0, 200_000), room.sessionId],
    ).catch(() => {});
    for (const m of room.members.values()) {
      const leftAt = m.leftAt ?? nowIso;
      const joined = Date.parse(m.joinedAt);
      const dur = Number.isFinite(joined) ? Math.max(0, Math.round((Date.parse(leftAt) - joined) / 1000)) : null;
      const rttAvg = m.rttCount > 0 ? Math.round(m.rttSum / m.rttCount) : null;
      await this.#db(
        `INSERT INTO room_members (session_id, member_key, name, joined_at, left_at, duration_s,
           rtt_avg_ms, rtt_max_ms, jitter_avg_ms, loss_pct, link, reconnects, speaking_s, runtime, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, member_key) DO UPDATE SET left_at = excluded.left_at,
           duration_s = excluded.duration_s, rtt_avg_ms = excluded.rtt_avg_ms,
           rtt_max_ms = excluded.rtt_max_ms, jitter_avg_ms = excluded.jitter_avg_ms,
           loss_pct = excluded.loss_pct, link = excluded.link, reconnects = excluded.reconnects,
           speaking_s = excluded.speaking_s`,
        [room.sessionId, m.key, m.name, m.joinedAt, leftAt, dur, rttAvg, m.rttMax || null,
          m.jitterMax || null, m.lossPct || null, m.link || null, m.reconnects || 0,
          m.speakingS || 0, m.runtime || null, m.version || null],
      ).catch(() => {});
    }
  }

  async #db(sql, params = []) {
    if (!this.env?.DB) return; // 未绑定 D1：实时功能不受影响
    await this.env.DB.prepare(sql).bind(...params).run();
  }
}

function safeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clampStr(v, max) {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : "";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}

function liveCount(room) {
  return [...room.members.values()].filter((m) => !m.leftAt).length;
}

export default {
  async fetch(request, env) {
    // 单实例总机（房主/访客都是短消息，量级远低于单 DO 的处理能力；
    // 真要分片，可按 key 或 id 前缀取多个 DO，扩展时再改）。
    const hub = env.SIGNAL_HUB.get(env.SIGNAL_HUB.idFromName("hub"));
    return hub.fetch(request);
  },
};
