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
/**
 * 在线状态落库节奏（账号收件箱专用）。
 *
 * 原来由客户端每 30 秒打一次 HTTP `/api/account/presence`，一个已登录窗口
 * 每小时 120 次请求（20 人每天上万次）。改成：客户端只在**进/出房时**发一条
 * PRESENCE，剩下的"我还活着"由这里的 alarm 统一代写 —— alarm 是 DO 单例，
 * 一天固定 2,880 次，**不随在线人数增长**。
 *
 * 和 `PRESENCE_ONLINE_MS`（75 秒）保持 2.5 倍余量，掉线判定行为完全不变。
 */
const PRESENCE_TICK_MS = 30_000;
/** D1 单条语句最多 100 个绑定参数；每行 3 个，留足余量。 */
const PRESENCE_BATCH = 30;

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
  /**
   * 连接上的附加信息（hibernation 后靠它恢复身份，内存 Map 会被回收）。
   *
   * 两种连接共用一个 DO：
   *   - 房间信令：`{ id: <peerId>, role: "peer" }`（老连接没有 role，按 peer 处理）
   *   - 账号收件箱：`{ acct: <数字ID>, role: "inbox" }` —— 见 #handleInbox
   * 用 **acct 而不是 id** 存账号，天然避开 peer 的 ID-TAKEN 判定与 #peers() 映射。
   */
  #attOf(ws) {
    try {
      return ws.deserializeAttachment() ?? null;
    } catch {
      return null;
    }
  }

  #peers() {
    const map = new Map();
    for (const ws of this.state.getWebSockets()) {
      const att = this.#attOf(ws);
      // 收件箱连接不是房间成员：混进来会让 OFFER 发错人、房主被误判在线
      if (!att || att.role === "inbox") continue;
      if (att.id) map.set(att.id, ws);
    }
    return map;
  }

  /** 房间 peer 的 id；收件箱连接一律返回 null（关连接/路由时就不会误伤房间）。 */
  #idOf(ws) {
    const att = this.#attOf(ws);
    if (!att || att.role === "inbox") return null;
    return att.id ?? null;
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

    // 内部推送（Pages Worker 存完邀请后经 service binding 调用）
    if (url.pathname === "/push") return this.#pushToInbox(request);

    // 非升级请求：只提供 /id 取号端点（客户端没指定 id 时才会用），其余给个健康检查
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      if (url.pathname.endsWith("/id")) {
        return new Response(crypto.randomUUID(), {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
        });
      }
      return new Response("5blong signal hub", { status: 200 });
    }

    // 账号收件箱：/peerjs/inbox?id=<数字ID>（走到这里一定是 Upgrade，
    // 非升级请求已经在上面被拦成健康检查了）。放在房间握手之前，因为它没有房间 id 语义。
    if (url.pathname === "/peerjs/inbox" || url.pathname.endsWith("/inbox")) {
      return this.#handleInbox(url);
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
    server.serializeAttachment({ id, role: "peer" });
    server.send(JSON.stringify({ type: "OPEN" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------ 账号收件箱
  //
  // 为什么要有它：邀请/好友变更原来是客户端定时轮询（邀请 8 秒、好友 5 秒），
  // 一个已登录窗口每小时固定 1,290 次请求，把 Workers 免费额度（10 万/天）顶到九成。
  // 客户端登录后挂一条闲着的长连接，服务端有事就敲一下，轮询就能放慢到兜底级别。
  //
  // 成本（Workers 免费额度）：
  //   - `acceptWebSocket` 是休眠 API：空闲不占计算时长；
  //   - 心跳 `{"type":"HEARTBEAT"}` 走 setWebSocketAutoResponse，**不唤醒、不计请求**；
  //   - 推送是出站消息，不计费。
  //
  // 身份：attachment 里存 acct，**不信任客户端自称的 src**（见 #onInboxMessage）。
  //
  // 在线状态（2026-10-26 起）：连接本身就是"在线"。客户端进/出房时发一条
  // `PRESENCE`（带房号），其余时间由 alarm 每 30 秒把"当前挂着的连接"批量
  // 落库到 D1 的 account_presence —— 客户端不再每 30 秒打一次 HTTP。
  // OPEN 里回 `presence:true` 是**能力声明**：老版本 Worker / 没有 D1 / 存储不可用时
  // 一律回 false，客户端据此继续走原来的 HTTP 心跳（否则好友面板会全员离线）。
  async #handleInbox(url) {
    const acct = (url.searchParams.get("id") ?? url.searchParams.get("acct") ?? "").trim();
    if (!/^[1-9]\d{5,11}$/.test(acct)) return new Response("missing account", { status: 400 });

    /*
     * 能力探测：D1 没绑、或 storage/alarm 不可用（本地 miniflare 某些配置）时
     * 绝不能声称支持 —— 客户端停掉 HTTP 心跳后就没有任何东西在更新 last_seen 了。
     */
    let canPresence = false;
    try {
      if (this.env?.DB) {
        await this.state.storage.getAlarm();
        canPresence = true;
      }
    } catch {
      canPresence = false;
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // 同一账号允许多条：多开窗口时每条都要收到推送（房间连接才要求 id 唯一）
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ role: "inbox", acct, room: null });
    server.send(
      JSON.stringify({ type: "OPEN", role: "inbox", ...(canPresence ? { presence: true } : {}) }),
    );
    if (canPresence) await this.#schedulePresenceAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 某账号当前挂着的所有收件箱连接（无状态遍历：休眠被回收后依然正确）。 */
  #inboxSockets(acct) {
    const list = [];
    for (const ws of this.state.getWebSockets()) {
      const att = this.#attOf(ws);
      if (att?.role === "inbox" && att.acct === acct) list.push(ws);
    }
    return list;
  }

  /**
   * 收件箱**只收不发**：除了心跳与在线状态，其他消息一律丢弃。
   *
   * 为什么不让客户端自己推：那样任何人都能给任意 8 位 ID "敲门"（骚扰面），
   * 而且发送方一旦没连上就推不出去。改由 **Pages Worker 在存完邀请后经
   * service binding 调 `/push`** —— 服务端到服务端，可靠且不需要发送方在线。
   *
   * 唯一例外是 `PRESENCE`：客户端进房/退房时自己报一次房号（它只影响
   * **自己**那一行 account_presence，伪造也只能伪造自己，不构成骚扰面）。
   * 报完立刻落一次库，好友面板上的"在 xxx 房"不用等下一个 alarm 周期。
   */
  async #onInboxMessage(ws, acct, raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (message?.type === "HEARTBEAT") {
      // 正常由自动应答处理；走到这里说明运行时没有该 API
      try {
        ws.send('{"type":"HEARTBEAT"}');
      } catch {
        /* 已断开 */
      }
      return;
    }
    if (message?.type === "PRESENCE") {
      // 只收 6 位新码与 4 位老码，其它一律当"在线但不在房间"（与 /api/account/presence 一致）
      const room = String(message?.roomCode ?? "").trim();
      const roomCode = /^\d{4}$|^\d{6}$/.test(room) ? room : null;
      try {
        // attachment 是休眠后唯一还记得"这条连接在哪个房"的地方
        ws.serializeAttachment({ role: "inbox", acct, room: roomCode });
      } catch {
        return;
      }
      await this.#flushPresence();
    }
    void acct;
  }

  /**
   * 把"当前所有收件箱连接"写成在线状态（D1 `account_presence`）。
   *
   * 语义与客户端 HTTP 心跳完全一致：`last_seen = now`，`room_code = 当前房号或 null`。
   * 断开连接不需要单独写离线 —— 下一次 flush 不再包含它，75 秒后自然判离线
   * （和原来"客户端不发心跳就超时"的判定窗口一模一样，不会闪）。
   *
   * 同一账号多开窗口时按 acct 去重（后读到的覆盖房号）：同一人不可能同时在两个房，
   * 真出现了也只影响自己那一行的展示。
   */
  async #flushPresence() {
    if (!this.env?.DB) return;
    const byAcct = new Map();
    for (const ws of this.state.getWebSockets()) {
      const att = this.#attOf(ws);
      if (att?.role !== "inbox" || !att.acct) continue;
      byAcct.set(att.acct, att.room ?? null);
    }
    const rows = [...byAcct.entries()];
    if (!rows.length) return;
    const now = Date.now();
    for (let i = 0; i < rows.length; i += PRESENCE_BATCH) {
      const chunk = rows.slice(i, i + PRESENCE_BATCH);
      const values = chunk.map(() => "(?, ?, ?)").join(", ");
      const args = [];
      for (const [acct, room] of chunk) args.push(acct, now, room);
      await this.#db(
        `INSERT INTO account_presence (account_id, last_seen, room_code) VALUES ${values} ` +
          `ON CONFLICT(account_id) DO UPDATE SET last_seen = excluded.last_seen, room_code = excluded.room_code`,
        args,
      ).catch(() => {
        /* D1 抖动：下一次 alarm 会补上，最多晚 30 秒 */
      });
    }
  }

  /**
   * 排下一次落库。**单例**：所有收件箱连接共用一个 alarm，一天固定 2,880 次，
   * 不随在线人数增长（这是这个方案唯一真正省请求的地方，改前想清楚）。
   * 没有连接了就不再排 —— 下一条连接进来时 #handleInbox 会重新排。
   */
  async #schedulePresenceAlarm() {
    if (!this.state.getWebSockets().some((ws) => this.#attOf(ws)?.role === "inbox")) return;
    try {
      const current = await this.state.storage.getAlarm();
      if (current === null) await this.state.storage.setAlarm(Date.now() + PRESENCE_TICK_MS);
    } catch {
      /* storage 不可用：客户端那边有 HTTP 心跳兜底（见 OPEN 里的能力声明） */
    }
  }

  /** 周期性落库。DO 休眠后仍会按时触发，这正是选 alarm 而不是内存定时器的原因。 */
  async alarm() {
    await this.#flushPresence();
    await this.#schedulePresenceAlarm();
  }

  /**
   * 内部推送端点：`POST /push  {acct, kind:"INVITE"}`。
   *
   * 只有 Pages Worker 通过 service binding 能调到这里（不经公网、无公开路由），
   * 所以不做令牌校验。返回 `sent` 是"投出去几条连接"，排障时能一眼看出对方在不在线。
   */
  async #pushToInbox(request) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    let body = null;
    try {
      body = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const acct = String(body?.acct ?? "").trim();
    if (!/^[1-9]\d{5,11}$/.test(acct)) return json({ error: "bad-acct" }, 400);
    // 白名单：目前只有"有邀请"一种理由，别把这个端点做成任意消息通道
    if (String(body?.kind ?? "") !== "INVITE") return json({ error: "bad-kind" }, 400);

    const out = JSON.stringify({ type: "INVITE" });
    let sent = 0;
    for (const ws of this.#inboxSockets(acct)) {
      try {
        ws.send(out);
        sent += 1;
      } catch {
        /* 目标刚断开：它自己会重连，拉一次 /invites 就能补上 */
      }
    }
    return json({ ok: true, sent }, 200);
  }

  /** 收到客户端消息：转发给对方，或者回 EXPIRE（目标不在线）；房主快照进遥测。 */
  async webSocketMessage(ws, raw) {
    // 收件箱连接走完全独立的一套消息（PUSH），绝不能落进房间信令的转发逻辑
    const att = this.#attOf(ws);
    if (att?.role === "inbox") {
      await this.#onInboxMessage(ws, att.acct, raw);
      return;
    }
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
      // 收件箱连接不关心房间成员进出（省一次解析）
      if (this.#attOf(other)?.role === "inbox") continue;
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
