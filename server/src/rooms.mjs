/**
 * 房间遥测（原来在信令 Worker 里，随 ROOM-SNAPSHOT 消息落库）。
 *
 * 关键背景 —— 这里和以前的判断不一样，别再走回头路：
 *   1. `/rooms/beat`、`/rooms/bye`、`/rooms/summary` 是**死接口**：
 *      客户端一行都没调用过（全仓搜不到）。真正的遥测通道是房主每 ~10 秒
 *      通过信令 WebSocket 发一条 `ROOM-SNAPSHOT`，由 Cloudflare 的信令 Worker 落库。
 *   2. 我们的 ECS 信令用的是 npm `peer` 包，它不认识这条消息，会直接忽略。
 *      所以「在线房间」页面在 ECS 上一直是空的。
 *
 * 解法（本次）：把上报通道从「信令 WebSocket」改成「HTTP POST /api/rooms/snapshot」。
 *   - 不动信令服务（改错了是整房连不上，代价太大）
 *   - HTTP 天然可重试、可观测，也不需要维持长连接
 *   - 客户端只改一处发送方式，payload 原样不动
 *
 * 与原实现的差异（有意为之）：
 *   - 原版状态放在 Durable Object 里，能跨重启存活；这里是进程内存。
 *     进程重启时，正在开着的房间会丢一次「结束时间」，
 *     但下一次快照会重建会话行（同一 sessionId 是 ON CONFLICT 更新），影响很小。
 *   - 原版靠 WebSocket 断开触发 finalize；HTTP 没有连接可监听，
 *     改成**空闲超时清扫**（90 秒没有快照就收尾）。
 */

import express from "express";

const SAMPLE_INTERVAL_MS = 5 * 60_000; // 人数曲线：约每 5 分钟一点
const IDLE_FINALIZE_MS = 90_000; // 90 秒没快照就认为房间结束了
const SWEEP_INTERVAL_MS = 60_000;
const ROOM_MAX_PER_IP = 4; // 同一 IP 同时活跃的房间数
const ROOM_HOURLY_LIMIT = 130; // 同一 IP 一小时内新建会话数

const clampStr = (value, max) => {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s.slice(0, max) : "";
};
const num = (value, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
};

export function createRoomsHarness(db) {
  const router = express.Router();

  /** sessionId → 房间状态（只放内存，见文件头说明） */
  const rooms = new Map();
  /** ip → { activeSessions:Set, hourly:number[] } */
  const limits = new Map();

  const insertStatement = () =>
    db.prepare(
      "INSERT INTO room_sessions (id, code, created_at, peak_members, host_runtime, host_version) " +
        "VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING",
    );
  const memberStatement = () =>
    db.prepare(
      "INSERT INTO room_members (session_id, member_key, name, joined_at, left_at, duration_s, " +
        "rtt_avg_ms, rtt_max_ms, jitter_avg_ms, loss_pct, link, reconnects, speaking_s, runtime, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(session_id, member_key) DO UPDATE SET left_at = excluded.left_at, " +
        "duration_s = excluded.duration_s, rtt_avg_ms = excluded.rtt_avg_ms, " +
        "rtt_max_ms = excluded.rtt_max_ms, jitter_avg_ms = excluded.jitter_avg_ms, " +
        "loss_pct = excluded.loss_pct, link = excluded.link, reconnects = excluded.reconnects, " +
        "speaking_s = excluded.speaking_s",
    );

  const liveCount = (room) => [...room.members.values()].filter((m) => !m.leftAt).length;

  /**
   * 把「正在开着的房间」同步到 `rooms` 表 —— 后台的在线面板读的是这张表。
   *
   * 为什么需要这一步：原来 `rooms` 表由客户端调 `/rooms/beat` 写入，
   * 而那个接口**客户端从来没调用过**（全仓搜不到），所以面板一直是空的。
   * 现在快照里已经带了人数/共享/版本，顺手同步一份，面板立刻就有数据了。
   *
   * id 用**房号**而不是 sessionId：面板上"房主 / 房号"要能一眼对上，
   * sessionId 是 32 位串，展示出来没人看得懂。
   */
  function syncLiveRow(room, live) {
    const id = room.code || room.sessionId;
    try {
      db.prepare(
        "INSERT INTO rooms (id, created_at, last_seen, members, sharing, version, runtime, ip_hash) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, members = excluded.members, " +
          "sharing = excluded.sharing, version = excluded.version, runtime = excluded.runtime",
      )
        .bind(
          id,
          room.createdAt,
          new Date().toISOString(),
          live,
          room.share.active ? 1 : 0,
          room.version || "",
          room.runtime || "",
          "snapshot",
        )
        .run();
    } catch (error) {
      console.error("[rooms] 同步在线行失败：", error.message);
    }
  }

  /** 会话收尾：写结束时间、时长、峰值、明细分档。关房/断线/崩溃都走这里。 */
  function finalize(sessionId, reason) {
    const room = rooms.get(sessionId);
    if (!room) return;
    rooms.delete(sessionId);

    const nowIso = new Date().toISOString();
    const created = Date.parse(room.createdAt);
    const durationS = Number.isFinite(created) ? Math.max(0, Math.round((Date.now() - created) / 1000)) : null;
    try {
      db.prepare(
        "UPDATE room_sessions SET ended_at = ?, duration_s = ?, peak_members = ?, snapshot_json = ? WHERE id = ?",
      )
        .bind(
          nowIso,
          durationS,
          room.peak,
          JSON.stringify({ reason, members: [...room.members.values()], share: room.share }).slice(0, 200_000),
          sessionId,
        )
        .run();

      const statement = memberStatement();
      for (const m of room.members.values()) {
        const leftAt = m.leftAt ?? nowIso;
        const joined = Date.parse(m.joinedAt);
        const dur = Number.isFinite(joined) ? Math.max(0, Math.round((Date.parse(leftAt) - joined) / 1000)) : null;
        statement
          .bind(
            sessionId,
            m.key,
            m.name,
            m.joinedAt,
            leftAt,
            dur,
            m.rttCount > 0 ? Math.round(m.rttSum / m.rttCount) : null,
            m.rttMax || null,
            m.jitterMax || null,
            m.lossPct || null,
            m.link || null,
            m.reconnects || 0,
            m.speakingS || 0,
            m.runtime || null,
            m.version || null,
          )
          .run();
      }
    } catch (error) {
      console.error(`[rooms] 收尾失败 ${sessionId}：`, error.message);
    }

    // 房间结束了，在线面板上的那一行也必须消失（否则要等 150 秒超时才掉）
    try {
      db.prepare("DELETE FROM rooms WHERE id = ?").bind(room.code || sessionId).run();
    } catch (error) {
      console.error("[rooms] 清理在线行失败：", error.message);
    }

    // 释放这个 IP 的活跃名额
    const bucket = limits.get(room.ip);
    bucket?.active.delete(sessionId);
  }

  /** 把一份快照合并进内存状态 + 落库。 */
  function applySnapshot(payload, ip) {
    const sessionId = clampStr(payload?.sessionId, 64) || `s-${Date.now()}`;
    const nowIso = new Date().toISOString();
    let room = rooms.get(sessionId);

    if (!room) {
      room = {
        sessionId,
        code: clampStr(payload?.code, 16),
        createdAt: clampStr(payload?.createdAt, 32) || nowIso,
        runtime: clampStr(payload?.runtime, 20),
        version: clampStr(payload?.version, 40),
        members: new Map(),
        peak: 1,
        lastSampleAt: 0,
        lastEventAt: "",
        share: { active: false, totalS: 0, transport: "", last: "" },
        ip,
        lastSeen: Date.now(),
      };
      rooms.set(sessionId, room);

      let bucket = limits.get(ip);
      if (!bucket) {
        bucket = { active: new Set(), hourly: [] };
        limits.set(ip, bucket);
      }
      const hourAgo = Date.now() - 3600_000;
      bucket.hourly = bucket.hourly.filter((t) => t > hourAgo);
      if (bucket.active.size >= ROOM_MAX_PER_IP) return { error: "too many rooms", status: 429 };
      if (bucket.hourly.length >= ROOM_HOURLY_LIMIT) return { error: "too many requests", status: 429 };
      bucket.active.add(sessionId);
      bucket.hourly.push(Date.now());

      try {
        insertStatement().bind(sessionId, room.code, room.createdAt, room.runtime, room.version).run();
      } catch (error) {
        console.error("[rooms] 建会话失败：", error.message);
      }
    }

    room.lastSeen = Date.now();
    room.code = clampStr(payload?.code, 16) || room.code;
    room.runtime = clampStr(payload?.runtime, 20) || room.runtime;
    room.version = clampStr(payload?.version, 40) || room.version;
    room.share = {
      active: payload?.share?.active === true,
      totalS: num(payload?.share?.totalS),
      transport: clampStr(payload?.share?.transport, 16),
      last: clampStr(payload?.share?.last, 32),
    };

    // 成员按 key 合并：离开的人保留 leftAt，历史面板才看得到完整进出
    const members = Array.isArray(payload?.members) ? payload.members.slice(0, 64) : [];
    for (const m of members) {
      const key = clampStr(m?.key, 64);
      if (!key) continue;
      const prev = room.members.get(key);
      room.members.set(key, {
        key,
        name: clampStr(m?.name, 24),
        joinedAt: clampStr(m?.joinedAt, 32) || prev?.joinedAt || nowIso,
        leftAt: m?.leftAt ? clampStr(m.leftAt, 32) : (prev?.leftAt ?? null),
        rttSum: num(m?.rttSum),
        rttCount: num(m?.rttCount),
        rttMax: num(m?.rttMax),
        jitterMax: num(m?.jitterMax),
        lossPct: Math.min(100, num(m?.lossPct)),
        link: clampStr(m?.link, 12),
        reconnects: num(m?.reconnects),
        speakingS: num(m?.speakingS),
        runtime: clampStr(m?.runtime, 20),
        version: clampStr(m?.version, 40),
      });
    }

    const live = liveCount(room);
    // 人数/共享状态每轮都可能变，跟着刷一次在线行
    syncLiveRow(room, live);
    try {
      if (live > room.peak) {
        room.peak = live;
        db.prepare("UPDATE room_sessions SET peak_members = ? WHERE id = ?").bind(room.peak, sessionId).run();
      }
      if (Date.now() - room.lastSampleAt > SAMPLE_INTERVAL_MS) {
        room.lastSampleAt = Date.now();
        db.prepare("INSERT OR REPLACE INTO room_samples (session_id, at, members) VALUES (?, ?, ?)")
          .bind(sessionId, nowIso, live)
          .run();
      }
      // 事件只收比上次新的（客户端按时间排序发）
      const statement = db.prepare(
        "INSERT INTO room_events (session_id, at, kind, detail) VALUES (?, ?, ?, ?)",
      );
      for (const ev of Array.isArray(payload?.events) ? payload.events.slice(-20) : []) {
        const at = clampStr(ev?.at, 32);
        const kind = clampStr(ev?.kind, 24);
        if (!at || !kind || at <= room.lastEventAt) continue;
        room.lastEventAt = at;
        statement.bind(sessionId, at, kind, clampStr(ev?.detail, 200)).run();
      }
    } catch (error) {
      console.error("[rooms] 快照落库失败：", error.message);
    }

    return { ok: true };
  }

  /*
   * 空闲清扫：HTTP 没有"连接关闭"事件，只能靠超时判断房间结束。
   * 90 秒没新快照就收尾 —— 客户端每 ~10 秒发一次，连丢 9 次才会误判。
   */
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
      if (now - room.lastSeen > IDLE_FINALIZE_MS) finalize(id, "idle");
    }
    // 顺手清理限额表里已经空掉的 IP
    for (const [ip, bucket] of limits) {
      bucket.hourly = bucket.hourly.filter((t) => t > now - 3600_000);
      if (bucket.active.size === 0 && bucket.hourly.length === 0) limits.delete(ip);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  // =========================================================================
  // POST /api/rooms/snapshot —— 房主每 ~10 秒上报一次
  // =========================================================================
  router.post("/rooms/snapshot", (req, res) => {
    const ip =
      String(req.headers["x-forwarded-for"] ?? "")
        .split(",")[0]
        .trim() ||
      req.socket.remoteAddress ||
      "unknown";
    const result = applySnapshot(req.body ?? {}, ip);
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.status(200).json({ ok: true });
  });

  return {
    router,
    stats() {
      return { liveRooms: rooms.size };
    },
    close() {
      clearInterval(sweeper);
    },
  };
}
