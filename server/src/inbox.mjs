/**
 * 账号收件箱：一条基本不说话的常驻 WebSocket，服务端有事就敲一下。
 *
 * 为什么要有它（客户端那边有更长的说明）：
 *   邀请 8 秒、好友 5 秒、心跳 30 秒的轮询，一个已登录窗口每小时固定 1,290 次请求。
 *   改成「服务端推送 + 兜底轮询」之后，邀请从"最多晚 8 秒"变成"几乎立刻"，
 *   请求量还降一个数量级。
 *
 * 为什么放在**接口进程**里而不是信令进程：
 *   推送的触发点在邀请/好友的写入路径上（`api.mjs`），
 *   放同一个进程就是一次函数调用；分开就得跨进程 IPC 或者再开一条内部 HTTP，
 *   多一个能坏的环节，而且出了"邀请存进去了但没推"的问题很难查。
 *   信令那边是纯转发、不需要数据库，所以它单独一个进程。
 *
 * 三条硬约束（改之前先读）：
 *   1. **只收不发**：除了 `HEARTBEAT` 和 `PRESENCE`，其他消息一律丢弃。
 *      让客户端自己推的话，任何人都能给任意 8 位 ID "敲门"，是骚扰面。
 *   2. **永不信任推送内容**：只发 `{type:"INVITE"}` / `{type:"FRIEND"}`，
 *      不带房号/昵称。客户端收到后自己去拉快照，所以推送被伪造也改不了界面。
 *   3. **在线状态由这里代管**：客户端连上就停掉它自己的 30 秒 HTTP 心跳，
 *      改由这里每 30 秒统一落一次 `account_presence`。
 *      所以 OPEN 里那个 `presence: true` 是**承诺**，不是装饰 ——
 *      一旦发出去而这里不落库，好友面板会全员离线。
 */

import { WebSocketServer } from "ws";
import { isValidRoomCode } from "./util.mjs";

/** 落库周期：客户端在线窗口是 75 秒，30 秒足够稳，也不会把库写热。 */
const PRESENCE_TICK_MS = 30_000;
/** 心跳应答：客户端每 25 秒发一次，原样回一个字面量，不查库不唤醒任何东西。 */
const HEARTBEAT_REPLY = '{"type":"HEARTBEAT"}';

export function createInboxHub(db) {
  const wss = new WebSocketServer({ noServer: true });
  /** accountId → Set<ws>。同一账号允许多开窗口，每条都要收到推送。 */
  const byAccount = new Map();
  /** ws → 当前房号（null = 在线但不在房间）。 */
  const roomOf = new WeakMap();
  /** ws → 上一次 ping 是否有回应，用来回收半开连接。 */
  const alive = new WeakMap();

  let ticker = null;

  const presenceStatement = () =>
    db.prepare(
      "INSERT INTO account_presence (account_id, last_seen, room_code) VALUES (?, ?, ?) " +
        "ON CONFLICT(account_id) DO UPDATE SET last_seen = excluded.last_seen, room_code = excluded.room_code",
    );

  /**
   * 把"当前所有还连着的收件箱"写成在线状态。
   *
   * 语义与客户端 HTTP 心跳完全一致：`last_seen = now`，`room_code = 当前房号或 null`。
   * 断开不需要单独写离线 —— 下一次 flush 不再包含它，75 秒后自然判离线
   * （和"客户端不发心跳就超时"的判定窗口一模一样，不会闪）。
   */
  function flushPresence() {
    if (byAccount.size === 0) return;
    const now = Date.now();
    let statement;
    try {
      statement = presenceStatement();
    } catch (error) {
      // 库还没建好 / 抖动：下一次 tick 会补上，不要让定时器整个死掉
      console.error("[inbox] 准备在线状态语句失败：", error.message);
      return;
    }
    for (const [id, sockets] of byAccount) {
      // 同一账号多开时取第一个非空房号：一个人不可能同时在两个房
      let room = null;
      for (const ws of sockets) {
        const value = roomOf.get(ws);
        if (value) {
          room = value;
          break;
        }
      }
      try {
        statement.bind(id, now, room).run();
      } catch (error) {
        console.error(`[inbox] 写在线状态失败 ${id}：`, error.message);
      }
    }
  }

  /** 顺手清理半开连接：浏览器收到 ping 会自动回 pong，没有回应的就当断了。 */
  function sweepDeadSockets() {
    for (const [id, sockets] of byAccount) {
      for (const ws of sockets) {
        if (alive.get(ws) === false) {
          try {
            ws.terminate();
          } catch {
            /* 已经没了 */
          }
          continue;
        }
        alive.set(ws, false);
        try {
          ws.ping();
        } catch {
          /* 下一步会 terminate */
        }
      }
      if (sockets.size === 0) byAccount.delete(id);
    }
  }

  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      sweepDeadSockets();
      flushPresence();
      // 一个人都没有了就停掉，别让空转的定时器占着事件循环
      if (byAccount.size === 0 && ticker) {
        clearInterval(ticker);
        ticker = null;
      }
    }, PRESENCE_TICK_MS);
    // 不要因为这个定时器让进程无法退出
    ticker.unref?.();
  }

  function bind(accountId, ws) {
    let sockets = byAccount.get(accountId);
    if (!sockets) {
      sockets = new Set();
      byAccount.set(accountId, sockets);
    }
    sockets.add(ws);
    roomOf.set(ws, null);
    alive.set(ws, true);
    ensureTicker();
  }

  function unbind(accountId, ws) {
    const sockets = byAccount.get(accountId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) byAccount.delete(accountId);
  }

  wss.on("connection", (ws, _req, accountId) => {
    bind(accountId, ws);
    ws.on("pong", () => alive.set(ws, true));

    /*
     * OPEN 里的 `presence: true` 是承诺：连上之后客户端会停掉自己的 HTTP 心跳。
     * 所以必须先确保定时器真的在跑，再把这个承诺发出去。
     */
    ensureTicker();
    try {
      ws.send(JSON.stringify({ type: "OPEN", role: "inbox", presence: true }));
    } catch {
      /* 刚连上就断了，close 会清理 */
    }

    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      } catch {
        return;
      }
      if (message?.type === "HEARTBEAT") {
        try {
          ws.send(HEARTBEAT_REPLY);
        } catch {
          /* 已断开 */
        }
        return;
      }
      if (message?.type === "PRESENCE") {
        // 只认 4 位老码与 6 位新码，其他一律当"在线但不在房间"（与 /api/account/presence 同口径）
        const room = String(message?.roomCode ?? "").trim();
        roomOf.set(ws, isValidRoomCode(room) ? room : null);
        // 进/退房立刻落一次，好友面板上的"在 xxx 房"不用等下一个 30 秒周期
        flushPresence();
      }
      // 其余消息一律丢弃（见文件头第 1 条约束）
    });

    ws.on("close", () => unbind(accountId, ws));
    ws.on("error", () => unbind(accountId, ws));
  });

  return {
    /**
     * 给某个账号的所有在线窗口敲一下。没有连接就什么也不做 ——
     * 对方还没上线时由客户端 8 秒/5 秒的兜底轮询补上，不需要重试队列。
     */
    push(accountId, type) {
      const sockets = byAccount.get(String(accountId));
      if (!sockets || sockets.size === 0) return 0;
      const payload = JSON.stringify({ type });
      let sent = 0;
      for (const ws of sockets) {
        try {
          ws.send(payload);
          sent += 1;
        } catch {
          /* 单条失败不影响其他人 */
        }
      }
      return sent;
    },

    /**
     * 交给 http server 的 `upgrade` 事件调用。
     * 返回 true 表示这条升级已经被处理（调用方不要再转给别的 WS 服务）。
     */
    handleUpgrade(req, socket, head) {
      let path = "";
      let accountId = "";
      try {
        const url = new URL(req.url, "http://localhost");
        path = url.pathname;
        accountId = (url.searchParams.get("id") ?? "").trim();
      } catch {
        return false;
      }
      // 与信令 worker 同口径：/peerjs/inbox，或任何以 /inbox 结尾的路径
      if (path !== "/peerjs/inbox" && !path.endsWith("/inbox")) return false;

      if (!/^\d{8}$/.test(accountId)) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return true;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, accountId);
      });
      return true;
    },

    /** 供 /healthz 看在线连接数（排查"红点不来"时第一个要看的东西）。 */
    stats() {
      let sockets = 0;
      for (const set of byAccount.values()) sockets += set.size;
      return { inboxAccounts: byAccount.size, inboxSockets: sockets };
    },

    close() {
      if (ticker) {
        clearInterval(ticker);
        ticker = null;
      }
      for (const sockets of byAccount.values()) {
        for (const ws of sockets) {
          try {
            ws.close();
          } catch {
            /* 已断 */
          }
        }
      }
      byAccount.clear();
      wss.close();
    },
  };
}
