/**
 * 账号收件箱：一条基本不说话的常驻连接，服务端有事就敲一下。
 *
 * 为什么需要它：邀请/好友变更原来是客户端定时轮询（邀请 8 秒、好友 5 秒、
 * 心跳 30 秒），一个已登录窗口每小时固定 1,290 次请求，把 Workers 免费额度
 * （10 万/天）顶到九成。改成"服务端推送 + 兜底轮询"之后，邀请从"最多晚 8 秒"
 * 变成"几乎立刻"，请求量却降一个数量级。
 *
 * 为什么连本站域名：`wss://5blong.pages.dev/peerjs/inbox` 由 Pages Worker 的
 * `/peerjs*` 路由经 service binding 转给信令 Worker —— 和房间信令走同一条
 * **已验证可达**的通路。客户端从不直连 `*.workers.dev`：那个域名在境内被
 * DNS 污染（实测解析到 Facebook 网段，TCP 都建不起来）。
 *
 * 三条硬约束（改动前先读）：
 *   1. **永不信任推送内容**：收到 `INVITE` 只当"去拉一次"，界面数据永远来自
 *      `/api/account/invites`（服务端推送只带类型，不带房号/昵称）。
 *   2. **连不上必须能退回轮询**：状态一变就报给上层。公司代理、弱网、
 *      Worker 没部署新版时，邀请不能丢——只是晚一点。
 *   3. **空闲不能烧额度**：心跳是精确字符串 `{"type":"HEARTBEAT"}`，
 *      服务端用 setWebSocketAutoResponse 自动应答，不唤醒 DO、不计请求。
 *   4. **在线状态复用这条连接**（2026-10-26）：原来客户端每 30 秒打一次
 *      HTTP `/api/account/presence`，现在改成"进/出房时报一次房号"，
 *      活着这件事由服务端每 30 秒统一落库（alarm 单例，不随人数涨）。
 *      但**必须等服务端明确回 `presence: true` 才停 HTTP 心跳** ——
 *      老版本 Worker / 没绑 D1 时它不落库，停了就等于好友全离线。
 */

export type InboxStatus =
  /** 没登录，或开发环境（vite dev 没有 Worker，连了只会反复失败） */
  | "idle"
  | "connecting"
  /** 连上了：可以放慢轮询 */
  | "live"
  /** 断了，正在退避重连：立刻恢复轮询 */
  | "down";

/** 重连退避（毫秒）：抖动时别把服务端打爆，但也别让邀请等太久。 */
const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/** 心跳间隔：服务端在线窗口 75 秒，25 秒足够稳；走自动应答，不花额度。 */
const HEARTBEAT_MS = 25_000;

/** 与 `engine.ts` 的信令线路保持一致（同一域名、同一转发通路）。 */
const INBOX_HOST = "5blong.pages.dev";

export type InboxHandlers = {
  /** 收到"有邀请"提示：调用方应立刻拉一次 `/invites`。 */
  onInvite: () => void;
  /** 连接状态变化：`live` 时可放慢轮询，其它状态必须走兜底间隔。 */
  onStatus?: (status: InboxStatus) => void;
  /**
   * 服务端能否代管在线状态（取决于它有没有 D1 + 能不能排 alarm）。
   * `true` 时调用方可以停掉 30 秒的 HTTP 心跳，改成只报房号变化；
   * `false` / 断开连接时必须退回 HTTP 心跳，否则好友面板会全离线。
   */
  onPresence?: (enabled: boolean) => void;
};

export type InboxHandle = {
  /** 断开并清理：切换账号、登出、组件卸载时必须调用。 */
  close: () => void;
  /**
   * 上报"我在哪个房"（`null` = 不在房间）。
   * 仅在服务端声明 `presence: true` 时生效，并且只影响自己那一行在线记录。
   */
  setRoom: (code: string | null | undefined) => void;
};

/**
 * 建立账号收件箱连接。
 *
 * 返回句柄：切换账号、登出、组件卸载时必须 `close()`，否则会留下重连定时器。
 */
export function startInbox(accountId: string, handlers: InboxHandlers): InboxHandle {
  const noop: InboxHandle = { close: () => {}, setRoom: () => {} };
  // 开发环境没有 Worker（vite dev 只有静态资源），连了也白连，直接让上层用轮询
  if (import.meta.env.DEV || !accountId) {
    handlers.onStatus?.("idle");
    handlers.onPresence?.(false);
    return noop;
  }

  let socket: WebSocket | null = null;
  let heartbeat: number | null = null;
  let reconnect: number | null = null;
  let attempt = 0;
  let closed = false;
  /** 当前所在房号（null = 不在房间）：重连后要补报给服务端。 */
  let roomCode: string | null = null;
  /** 服务端已声明"在线状态由我代管"：此时才允许上层停掉 HTTP 心跳。 */
  let presenceReady = false;

  const setStatus = (status: InboxStatus) => {
    if (!closed) handlers.onStatus?.(status);
  };

  const clearHeartbeat = () => {
    if (heartbeat !== null) {
      window.clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnect !== null) return;
    const wait = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)] ?? 30_000;
    attempt += 1;
    reconnect = window.setTimeout(() => {
      reconnect = null;
      connect();
    }, wait);
  };

  /** 把当前房号报给服务端（只在它声明支持在线状态时才发）。 */
  const sendPresence = () => {
    if (!presenceReady) return;
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "PRESENCE", roomCode: roomCode ?? "" }));
    } catch {
      /* 已断开：onclose 会重连，重连后 OPEN 时自动补报 */
    }
  };

  function connect() {
    if (closed) return;
    setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(`wss://${INBOX_HOST}/peerjs/inbox?id=${encodeURIComponent(accountId)}`);
    } catch {
      setStatus("down");
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      setStatus("live");
      clearHeartbeat();
      heartbeat = window.setInterval(() => {
        try {
          ws.send('{"type":"HEARTBEAT"}');
        } catch {
          /* 已断开：紧接着会触发 onclose，统一在那里重连 */
        }
      }, HEARTBEAT_MS);
    };

    ws.onmessage = (event) => {
      let message: { type?: string; role?: string; presence?: boolean } | null = null;
      try {
        message = JSON.parse(String(event.data)) as { type?: string; role?: string; presence?: boolean };
      } catch {
        return;
      }
      /*
       * OPEN：服务端确认身份。`presence: true` 表示它愿意代管在线状态
       * （有 D1、能排 alarm）；没有这个字段就是老版本或降级环境，必须继续走 HTTP 心跳。
       */
      if (message?.type === "OPEN") {
        if (message.role === "inbox" && message.presence === true && !presenceReady) {
          presenceReady = true;
          handlers.onPresence?.(true);
        }
        // 连上/重连成功都补报一次当前房号
        sendPresence();
        return;
      }
      /*
       * 只认类型，不看内容：服务端推送本来就不带房号/昵称，
       * 真正的数据由调用方去 /invites 拉。这样推送被滥用也伪造不了界面。
       */
      if (message?.type === "INVITE") handlers.onInvite();
    };

    ws.onerror = () => {
      /* onclose 紧随其后，重连统一在那里做，避免双重重连 */
    };

    ws.onclose = () => {
      clearHeartbeat();
      if (socket === ws) socket = null;
      if (presenceReady) {
        presenceReady = false;
        // 立刻交还控制权：上层要马上恢复 HTTP 心跳，否则这段时间没人更新在线状态
        handlers.onPresence?.(false);
      }
      if (closed) return;
      setStatus("down");
      scheduleReconnect();
    };
  }

  connect();

  return {
    close: () => {
      closed = true;
      clearHeartbeat();
      if (reconnect !== null) {
        window.clearTimeout(reconnect);
        reconnect = null;
      }
      const ws = socket;
      socket = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* 已断开 */
        }
      }
      if (presenceReady) {
        presenceReady = false;
        handlers.onPresence?.(false);
      }
      handlers.onStatus?.("idle");
    },
    setRoom: (code) => {
      const next = code ?? null;
      if (next === roomCode) return;
      roomCode = next;
      // 未连上时只记下来，等 OPEN 后统一补报（见 onmessage）
      sendPresence();
    },
  };
}
