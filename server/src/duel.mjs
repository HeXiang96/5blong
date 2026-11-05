/**
 * 房间内「梗王对局」的信使（docs/DUEL.md 方案 A）。
 *
 * 定位：**只做收发，不懂规则**。
 *   * 房主（host）在自己机器上跑引擎，每次变化把整份快照传上来（version +1）；
 *   * 访客（guest）只传动作意图，房主取走自己执行；
 *   * 任一方点「退出对局」→ 置 host_left / guest_left，对方下一次轮询就能看到，
 *     **人还在房间里也一样**；
 *   * 双方各每 ~1.2 秒 POST /poll，这个轮询同时是心跳（*_seen_at），
 *     对方 15 秒没来就视为掉线。
 *
 * 为什么不走 PeerJS 数据通道：房间是星型拓扑（engine.ts 里只有
 * handleHostMessage / handleGuestMessage 两个方向），访客之间没有连接，
 * 要对打就得经房主转发或另建连接。回合制对 1.2s 延迟无感，
 * 而 HTTP 天然可重试、断线后能回查快照追进度。
 *
 * 身份：客户端本地生成的 clientId（未登录也能玩）。
 * 访问控制只有一条：只有 host_id / guest_id 本人能读写自己那一行。
 */

import express from "express";
import { randomUUID } from "node:crypto";

/** 邀请 1 分钟内有效：超过这个时间对方大概率已经不在电脑前，也容易挡住下一局。 */
const INVITE_TTL_MS = 60_000;
/** 一局最多活 30 分钟（客户端有轮询保活，这里兜住忘记关的情况）。 */
const SESSION_TTL_MS = 30 * 60_000;
/** 结束/取消的对局再保留 60 秒，够对方看到最终画面。 */
const OVER_GRACE_MS = 60_000;
/** 对方超过这么久没轮询 = 掉线（正常间隔 1.2s，留十倍余量）。 */
const IDLE_MS = 15_000;
/** 快照上限：一局 8 张手牌 × 双方，正常十几 KB。 */
const STATE_MAX = 200_000;
/** clientId / gameId 的形状：客户端随机生成，不含特殊字符。 */
const ID_RE = /^[0-9a-zA-Z_-]{8,64}$/;
const NAME_MAX = 24;

const str = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
const parseJson = (raw) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export function createDuelRouter(db) {
  const router = express.Router();

  /** 行 → 给客户端的形状。state 只给访客，action 只给房主（自己传的不用回显）。 */
  const view = (row, clientId) => {
    const isHost = row.host_id === clientId;
    const now = Date.now();
    return {
      gameId: row.id,
      room: row.room_code,
      role: isHost ? "host" : "guest",
      phase: row.phase,
      version: row.version,
      state: isHost ? null : parseJson(row.state),
      action: isHost ? parseJson(row.action) : null,
      actionSeq: row.action_seq,
      opponentName: isHost ? row.guest_name : row.host_name,
      opponentLeft: isHost ? row.guest_left === 1 : row.host_left === 1,
      iLeft: isHost ? row.host_left === 1 : row.guest_left === 1,
      // seen_at 为 0 = 对方还没轮询过（刚发的邀请），不能算掉线
      opponentIdleMs:
        (isHost ? row.guest_seen_at : row.host_seen_at) === 0
          ? 0
          : Math.max(0, now - (isHost ? row.guest_seen_at : row.host_seen_at)),
    };
  };

  const findActive = (clientId, room) =>
    db
      .prepare(
        `SELECT * FROM duel_sessions
          WHERE (host_id = ? OR guest_id = ?)
            AND phase NOT IN ('cancelled', 'over')
            AND NOT (host_left = 1 AND guest_left = 1)
            AND updated_at > ?
            AND (? = '' OR room_code = ?)
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(clientId, clientId, Date.now() - SESSION_TTL_MS - OVER_GRACE_MS, room, room)
      .first();

  /** 低频清理：结束/取消太久的行删掉，别让表无限涨。 */
  const sweep = () => {
    db.prepare("DELETE FROM duel_sessions WHERE updated_at < ?").bind(Date.now() - 2 * 3600_000).run();
  };

  router.post("/invite", (req, res) => {
    const body = req.body ?? {};
    const clientId = str(body.clientId, 64);
    if (!ID_RE.test(clientId)) return res.status(400).json({ error: "bad-clientId" });
    const guestId = str(body.guestId, 64);
    if (!ID_RE.test(guestId)) return res.status(400).json({ error: "bad-guestId" });
    const gameId = str(body.gameId, 64);
    if (!ID_RE.test(gameId)) return res.status(400).json({ error: "bad-gameId" });
    if (guestId === clientId) return res.status(400).json({ error: "self-invite" });

    const room = str(body.room, 16);
    const hostName = str(body.hostName, NAME_MAX) || "房主";
    const guestName = str(body.guestName, NAME_MAX) || "对手";
    const now = Date.now();

    /*
     * 换了房间 = 上一间房的邀请/对局全部作废，先就地收掉。
     *
     * 不清的话，一条没人理的邀请会跟着人走：在新房间点「梗王对局」直接 409 busy，
     * 而且那条邀请可能来自几十分钟前、房号都完全不一样——2026-11-04 线上实测，
     * 房主侧表现为「点了按钮什么都不出来」，只在角落闪一条 4 秒提示。
     * 对局同理：房间都没了（房主关房/退出账号回首页），那局不可能继续。
     */
    db.prepare(
      `UPDATE duel_sessions
          SET phase = 'cancelled', updated_at = ?
        WHERE (host_id = ? OR guest_id = ?)
          AND phase IN ('invite', 'playing')
          AND room_code <> ?
          AND created_at > ?`,
    )
      .bind(now, clientId, clientId, room, now - SESSION_TTL_MS)
      .run();

    // 双方都不能已经在别的局里：一局没结束就开第二局，两边状态会串。
    // 注意邀请只挡 1 分钟：过期邀请算垃圾，不能像以前那样挡满 30 分钟。
    const busy = db
      .prepare(
        `SELECT id FROM duel_sessions
          WHERE (host_id = ? OR guest_id = ? OR host_id = ? OR guest_id = ?)
            AND (phase = 'playing' OR (phase = 'invite' AND created_at > ?))
            AND updated_at > ?
          LIMIT 1`,
      )
      .bind(clientId, clientId, guestId, guestId, now - INVITE_TTL_MS, now - SESSION_TTL_MS)
      .first();
    if (busy) return res.status(409).json({ error: "busy", message: "对方或你已经在另一局里了" });

    db.prepare(
      `INSERT INTO duel_sessions
        (id, room_code, host_id, host_name, guest_id, guest_name, phase,
         version, state, action, action_seq,
         host_seen_at, guest_seen_at, host_left, guest_left, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'invite', 0, NULL, NULL, 0, ?, 0, 0, 0, ?, ?)`,
    )
      .bind(gameId, room, clientId, hostName, guestId, guestName, now, now, now)
      .run();

    return res.json({ ok: true, gameId, expiresInMs: INVITE_TTL_MS });
  });

  /**
   * 轮询：一次往返同时完成「拉」和「推」。
   *
   * body: { clientId, room?, gameId?, cmd?, version?, state?, action?, ackAction?, since? }
   *   cmd        "accept" | "decline" | "leave"
   *   state      房主上传的快照（version 必须比服务端手里的大）
   *   action     访客上传的意图
   *   ackAction  房主消费完动作后回报，服务端据此清空
   *   since      客户端手里的 version；没变化就不回传 state（省流量）
   */
  router.post("/poll", (req, res) => {
    const body = req.body ?? {};
    const clientId = str(body.clientId, 64);
    if (!ID_RE.test(clientId)) return res.status(400).json({ error: "bad-clientId" });

    if (Math.random() < 0.02) sweep();

    const room = str(body.room, 16);
    const cmd = str(body.cmd, 16);
    const gameId = str(body.gameId, 64);

    let row = gameId
      ? db.prepare("SELECT * FROM duel_sessions WHERE id = ?").bind(gameId).first()
      : null;
    if (!row) row = findActive(clientId, room);
    if (!row) return res.json({ ok: true, session: null });
    if (row.host_id !== clientId && row.guest_id !== clientId) {
      return res.status(403).json({ error: "forbidden" });
    }

    // cancelled = 邀请被拒/过期/取消：没有要保留的最终画面，立刻收；
    // over 保留一小段，让双方都能看到胜负画面。
    if (row.phase === "cancelled") return res.json({ ok: true, session: null });
    if (row.phase === "over" && Date.now() - row.updated_at > OVER_GRACE_MS) {
      return res.json({ ok: true, session: null });
    }
    /*
     * 邀请过期按 **created_at** 算，不能按 updated_at：
     * 每次 /poll 都会刷新 updated_at（当心跳用），房主一直轮询时
     * 「1 分钟内有效」就永远不会生效——一个等待卡可以挂一整天。
     */
    if (row.phase === "invite" && Date.now() - row.created_at > INVITE_TTL_MS) {
      db.prepare("UPDATE duel_sessions SET phase = 'cancelled', updated_at = ? WHERE id = ?")
        .bind(Date.now(), row.id)
        .run();
      return res.json({ ok: true, session: null, expired: true });
    }

    const isHost = row.host_id === clientId;
    const now = Date.now();
    const patch = {};

    if (cmd === "accept" && !isHost && row.phase === "invite") patch.phase = "playing";
    if (cmd === "decline" && !isHost) patch.phase = "cancelled";
    if (cmd === "leave") {
      patch[isHost ? "host_left" : "guest_left"] = 1;
      /*
       * 邀请阶段点退出 = 取消；对局中任一方点退出 = 这局直接结束。
       *
       * 以前是「两个人都退了才算 over」，于是先退出的那个人会被自己上一局挡住：
       * 服务端那行还是 playing，他马上想再邀别人 → 409 busy（2026-11-04 业主反馈
       * 「有人点退出游戏了，之后再邀请」）。现在只要有人退出就 over，
       * 对方下一轮仍然看得到「XX 退出了对局」的结算画面（over 保留 60 秒）。
       */
      if (row.phase === "invite") patch.phase = "cancelled";
      else patch.phase = "over";
    }

    // 房主推快照
    if (isHost && row.phase !== "cancelled" && body.state && typeof body.state === "object") {
      const version = Number(body.version);
      if (!Number.isFinite(version) || version <= row.version) {
        // 版本没变 = 没变化，什么都不做
      } else {
        const raw = JSON.stringify(body.state);
        if (raw.length > STATE_MAX) return res.status(413).json({ error: "state-too-large" });
        patch.state = raw;
        patch.version = version;
        if (row.phase === "invite") patch.phase = "playing";
        if (body.state.over === true) patch.phase = "over";
      }
    }

    // 访客推动作
    if (!isHost && row.phase === "playing" && body.action && typeof body.action === "object") {
      patch.action = JSON.stringify(body.action);
      patch.action_seq = row.action_seq + 1;
    }

    // 房主确认已消费
    if (isHost && body.ackAction !== undefined && Number(body.ackAction) >= row.action_seq) {
      patch.action = null;
    }

    // 轮询即心跳：合并进同一条 UPDATE
    patch[isHost ? "host_seen_at" : "guest_seen_at"] = now;

    let next = { ...row, ...patch, updated_at: now };
    const keys = Object.keys(patch);
    db.prepare(`UPDATE duel_sessions SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...keys.map((k) => patch[k]), now, row.id)
      .run();

    const since = Number(body.since);
    if (Number.isFinite(since) && next.version === since) next.state = null; // 没变化
    return res.json({ ok: true, session: view(next, clientId) });
  });

  /** 显式退出。与 poll 带 cmd=leave 等价，给 sendBeacon 这类读不到响应的场景。 */
  router.post("/leave", (req, res) => {
    const body = req.body ?? {};
    const clientId = str(body.clientId, 64);
    if (!ID_RE.test(clientId)) return res.status(400).json({ error: "bad-clientId" });
    const gameId = str(body.gameId, 64);
    if (!ID_RE.test(gameId)) return res.status(400).json({ error: "bad-gameId" });

    const row = db.prepare("SELECT * FROM duel_sessions WHERE id = ?").bind(gameId).first();
    if (!row) return res.json({ ok: true });
    if (row.host_id !== clientId && row.guest_id !== clientId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const isHost = row.host_id === clientId;
    db.prepare(
      `UPDATE duel_sessions
          SET ${isHost ? "host_left" : "guest_left"} = 1,
              phase = CASE
                WHEN phase = 'invite' THEN 'cancelled'
                WHEN phase = 'playing' THEN 'over'
                ELSE phase END,
              updated_at = ?
        WHERE id = ?`,
    )
      .bind(Date.now(), gameId)
      .run();
    return res.json({ ok: true });
  });

  return router;
}
