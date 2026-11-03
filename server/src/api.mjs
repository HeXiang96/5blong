/**
 * 账号接口：从 `worker/_worker.pages.js` 逐条搬迁。
 *
 * 迁移原则（改这条之前先想清楚）：
 *   * **错误码不许改** —— 客户端的文案表按错误码查，改一个就变成"未知错误"。
 *   * **字段名不许改** —— `account` / `friends` / `invites` / `plays` 这些外层键
 *     是客户端解构出来的，少一个就白屏。
 *   * **判定顺序不许改** —— 比如"先判用户名被占、再判房号"，顺序反了会返回不同的错误码。
 *
 * 唯一实质差异：推送（pushInboxHint / pushInviteHint）没有搬。
 * 那是"敲一下对方收件箱"的加速通道，客户端本来就有 90 秒兜底轮询，
 * 缺失只影响"红点亮得慢一点"，不影响任何数据正确性。
 */

import express from "express";
import {
  CONFIG,
  FRIEND_REQUEST_DAILY,
  INVITE_DAILY,
  INVITE_TTL_MS,
  KNOCK_DAILY,
  KNOCK_TTL_MS,
  MAX_AVATAR_CHARS,
  PRESENCE_ONLINE_MS,
  RECENT_PLAY_TTL_MS,
  REQUEST_COOLDOWN_MS,
  ROOM_HOLD_TTL_MS,
  SESSION_TTL_MS,
  ACCOUNT_USERNAME_RE,
  ACCOUNT_ROOM_CODE_RE,
} from "./config.mjs";
import {
  clampName,
  clampNote,
  isValidRoomCode,
  pbkdf2Hex,
  randomHex,
  readCookie,
  sessionCookie,
  toProfile,
  toPublicProfile,
  verifyPassword,
} from "./util.mjs";
import { accountById, bumpDaily, createSession, currentAccount, makeAccountId } from "./auth.mjs";
import { SESSION_COOKIE } from "./config.mjs";

/** 密码强度：注册与改密码共用一套，避免两处标准漂移。 */
function passwordProblem(password) {
  if (password.length < 8 || password.length > 64) return "password-weak";
  if (new Set(password).size < 4) return "password-weak";
  return null;
}

export function createApiRouter(db, inbox) {
  const router = express.Router();
  const secure = CONFIG.cookieSecure;

  const json = (res, data, status = 200, extra = {}) => {
    if (extra["Set-Cookie"]) res.setHeader("Set-Cookie", extra["Set-Cookie"]);
    for (const [key, value] of Object.entries(extra)) {
      if (key === "Set-Cookie") continue;
      res.setHeader(key, value);
    }
    res.status(status).json(data);
  };

  /** 取 token：Bearer 优先，其次 cookie。 */
  const tokenOf = (req) => {
    const header = String(req.headers.authorization ?? "");
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    return bearer || readCookie(req.headers, SESSION_COOKIE);
  };

  // =========================================================================
  // 注册 / 登录 / 登出
  // =========================================================================
  router.post("/register", async (req, res) => {
    const body = req.body ?? {};
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    if (!ACCOUNT_USERNAME_RE.test(username)) return json(res, { error: "username-invalid" }, 400);
    const weak = passwordProblem(password);
    if (weak) return json(res, { error: weak }, 400);

    const taken = db
      .prepare("SELECT 1 AS x FROM accounts WHERE lower(username) = lower(?)")
      .bind(username)
      .first();
    if (taken) return json(res, { error: "username-taken" }, 409);

    const id = makeAccountId(db);
    const salt = randomHex(16);
    const hash = await pbkdf2Hex(password, salt);
    const now = Date.now();
    const name = clampName(body.name) || username;
    db.prepare(
      "INSERT INTO accounts (id, username, name, salt, hash, avatar, avatar_version, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, '', 0, ?, ?)",
    )
      .bind(id, username, name, salt, hash, now, now)
      .run();

    const token = createSession(db, id);
    return json(
      res,
      { account: toProfile(accountById(db, id)), token },
      200,
      { "Set-Cookie": sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000), secure) },
    );
  });

  router.post("/login", async (req, res) => {
    const body = req.body ?? {};
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    const row = db.prepare("SELECT * FROM accounts WHERE lower(username) = lower(?)").bind(username).first();
    // 账号不存在与密码错给同一个错误，不泄漏"这个名字注册过"
    if (!row) return json(res, { error: "bad-credentials" }, 401);
    if (!(await verifyPassword(password, row.salt, row.hash))) {
      return json(res, { error: "bad-credentials" }, 401);
    }
    const token = createSession(db, row.id);
    return json(
      res,
      { account: toProfile(row), token },
      200,
      { "Set-Cookie": sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000), secure) },
    );
  });

  router.post("/logout", (req, res) => {
    const token = tokenOf(req);
    if (token) db.prepare("DELETE FROM account_sessions WHERE token = ?").bind(token).run();
    return json(res, { ok: true }, 200, { "Set-Cookie": sessionCookie("", 0, secure) });
  });

  // =========================================================================
  // 我自己
  // =========================================================================
  router.get("/me", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { account: null }, 200);
    return json(res, { account: toProfile(me) }, 200);
  });

  router.post("/password", async (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { error: "not-logged-in" }, 401);
    const body = req.body ?? {};
    const current = String(body.current ?? "");
    const next = String(body.next ?? "");

    const weak = passwordProblem(next);
    if (weak) return json(res, { error: weak }, 400);
    if (current && current === next) return json(res, { error: "same-password" }, 400);

    const row = db.prepare("SELECT salt, hash FROM accounts WHERE id = ?").bind(me.id).first();
    if (!row) return json(res, { error: "not-found" }, 404);
    if (!(await verifyPassword(current, row.salt, row.hash))) {
      return json(res, { error: "bad-credentials" }, 401);
    }

    const salt = randomHex(16);
    const hash = await pbkdf2Hex(next, salt);
    db.prepare("UPDATE accounts SET salt = ?, hash = ?, updated_at = ? WHERE id = ?")
      .bind(salt, hash, Date.now(), me.id)
      .run();

    // 踢掉其它会话、保留当前这条：改密码往往意味着怀疑别人还登着
    const keep = tokenOf(req);
    if (keep) {
      db.prepare("DELETE FROM account_sessions WHERE account_id = ? AND token <> ?")
        .bind(me.id, keep)
        .run();
    }
    return json(res, { ok: true }, 200);
  });

  router.patch("/me", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { error: "not-found" }, 401);
    const body = req.body;
    if (!body || typeof body !== "object") return json(res, { error: "bad json" }, 400);

    const patch = {};
    if (body.username !== undefined) {
      const username = String(body.username).trim();
      if (!ACCOUNT_USERNAME_RE.test(username)) return json(res, { error: "username-invalid" }, 400);
      const taken = db
        .prepare("SELECT 1 AS x FROM accounts WHERE lower(username) = lower(?) AND id <> ?")
        .bind(username, me.id)
        .first();
      if (taken) return json(res, { error: "username-taken" }, 409);
      patch.username = username;
    }
    if (body.name !== undefined) {
      const name = clampName(body.name);
      if (name) patch.name = name;
    }
    if (body.avatar !== undefined) {
      const avatar = String(body.avatar ?? "");
      if (avatar.length > MAX_AVATAR_CHARS) return json(res, { error: "avatar too large" }, 413);
      if (avatar && !avatar.startsWith("data:image/")) return json(res, { error: "bad avatar" }, 400);
      patch.avatar = avatar;
    }
    if (body.roomCode !== undefined) {
      const roomCode = String(body.roomCode ?? "").trim();
      if (!ACCOUNT_ROOM_CODE_RE.test(roomCode)) return json(res, { error: "room-taken" }, 409);
      // 每个账号只有一次改号机会：改过就锁死
      if (me.room_code && Number(me.room_changes ?? 0) >= 1) {
        return json(res, { error: "room-locked" }, 409);
      }
      const occupied = db
        .prepare("SELECT id FROM accounts WHERE room_code = ? AND id <> ?")
        .bind(roomCode, me.id)
        .first();
      if (occupied) return json(res, { error: "room-taken" }, 409);
      const heldNow = db
        .prepare("SELECT 1 AS x FROM room_holds WHERE code = ? AND expires_at > ?")
        .bind(roomCode, Date.now())
        .first();
      if (heldNow) return json(res, { error: "room-taken" }, 409);
      patch.roomCode = roomCode;
      patch.roomChanges = me.room_code ? 1 : 0;
    }

    const sets = [];
    const values = [];
    if (patch.username !== undefined) {
      sets.push("username = ?");
      values.push(patch.username);
    }
    if (patch.name !== undefined) {
      sets.push("name = ?");
      values.push(patch.name);
    }
    if (patch.avatar !== undefined) {
      sets.push("avatar = ?", "avatar_version = avatar_version + 1");
      values.push(patch.avatar);
    }
    if (patch.roomCode !== undefined) {
      sets.push("room_code = ?", "room_code_at = ?", "room_changes = ?");
      values.push(patch.roomCode, Date.now(), patch.roomChanges ?? 0);
    }
    if (sets.length === 0) return json(res, { account: toProfile(me) }, 200);

    sets.push("updated_at = ?");
    values.push(Date.now(), me.id);
    try {
      db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...values)
        .run();
    } catch (error) {
      // 唯一索引兜底（并发抢同一个房号 / 用户名）
      const message = String(error?.message ?? "");
      if (message.includes("room_code")) return json(res, { error: "room-taken" }, 409);
      if (message.includes("username")) return json(res, { error: "username-taken" }, 409);
      throw error;
    }
    return json(res, { account: toProfile(accountById(db, me.id)) }, 200);
  });

  router.post("/me/ack-id-change", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { ok: false }, 401);
    db.prepare("UPDATE accounts SET prev_id = NULL WHERE id = ?").bind(me.id).run();
    return json(res, { ok: true }, 200);
  });

  // =========================================================================
  // 房号
  // =========================================================================
  router.get("/room-claim", (req, res) => {
    const code = String(req.query.code ?? "").trim();
    if (!ACCOUNT_ROOM_CODE_RE.test(code)) return json(res, { taken: false }, 200);
    const row = db.prepare("SELECT 1 AS x FROM accounts WHERE room_code = ? LIMIT 1").bind(code).first();
    return json(res, { taken: Boolean(row) }, 200, { "Cache-Control": "public, max-age=600" });
  });

  router.post("/room-hold", (req, res) => {
    const body = req.body ?? {};
    const code = String(body.code ?? "").trim();
    const token = String(body.token ?? "").trim();
    if (!ACCOUNT_ROOM_CODE_RE.test(code) || !/^[a-zA-Z0-9_-]{8,64}$/.test(token)) {
      return json(res, { error: "bad request" }, 400);
    }
    const claimed = db.prepare("SELECT 1 AS x FROM accounts WHERE room_code = ? LIMIT 1").bind(code).first();
    if (claimed) return json(res, { error: "taken" }, 409);

    const now = Date.now();
    const hold = db.prepare("SELECT token, expires_at FROM room_holds WHERE code = ?").bind(code).first();
    if (hold && hold.expires_at > now && hold.token !== token) {
      return json(res, { error: "busy" }, 409);
    }
    db.prepare(
      "INSERT INTO room_holds (code, token, expires_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(code) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at",
    )
      .bind(code, token, now + ROOM_HOLD_TTL_MS)
      .run();
    return json(res, { ok: true, code, ttl: ROOM_HOLD_TTL_MS }, 200);
  });

  router.delete("/room-hold", (req, res) => {
    const token = String(req.query.token ?? "").trim();
    if (!token) return json(res, { ok: false }, 400);
    db.prepare("DELETE FROM room_holds WHERE token = ?").bind(token).run();
    return json(res, { ok: true }, 200);
  });

  // =========================================================================
  // 搜索 / 好友
  // =========================================================================
  router.get("/search", (req, res) => {
    const me = currentAccount(req, db);
    const keyword = String(req.query.q ?? "").trim();
    if (!keyword) return json(res, { accounts: [] }, 200);
    const like = `%${keyword.toLowerCase()}%`;
    const rows = db
      .prepare(
        "SELECT * FROM accounts WHERE id <> ? AND (id = ? OR lower(username) LIKE ? OR lower(name) LIKE ?) " +
          "ORDER BY id LIMIT 8",
      )
      .bind(me?.id ?? "", keyword, like, like)
      .all();
    return json(res, { accounts: (rows.results ?? []).map(toPublicProfile) }, 200);
  });

  router.get("/friends", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { friends: [], incoming: [], outgoing: [] }, 200);
    const friends = db
      .prepare(
        "SELECT a.*, f.since AS since, f.alias AS alias, p.last_seen AS last_seen, p.room_code AS p_room " +
          "FROM friendships f JOIN accounts a ON a.id = f.friend_id " +
          "LEFT JOIN account_presence p ON p.account_id = a.id " +
          "WHERE f.account_id = ? ORDER BY f.since DESC",
      )
      .bind(me.id)
      .all();
    const incoming = db
      .prepare(
        "SELECT a.*, r.at AS at, r.note AS note FROM friend_requests r JOIN accounts a ON a.id = r.from_id " +
          "WHERE r.to_id = ? AND COALESCE(r.status, 0) = 0 ORDER BY r.at DESC",
      )
      .bind(me.id)
      .all();
    const outgoing = db
      .prepare(
        "SELECT a.*, r.at AS at, r.note AS note FROM friend_requests r JOIN accounts a ON a.id = r.to_id " +
          "WHERE r.from_id = ? AND COALESCE(r.status, 0) = 0 ORDER BY r.at DESC",
      )
      .bind(me.id)
      .all();

    const now = Date.now();
    const presence = (row) =>
      row.last_seen && now - row.last_seen <= PRESENCE_ONLINE_MS
        ? { state: "online", lastSeen: row.last_seen, ...(row.p_room ? { roomCode: row.p_room } : {}) }
        : { state: "offline", lastSeen: row.last_seen ?? 0 };

    return json(
      res,
      {
        friends: (friends.results ?? []).map((row) => ({
          account: toPublicProfile(row),
          since: row.since ?? now,
          presence: presence(row),
          ...(row.alias ? { alias: row.alias } : {}),
        })),
        incoming: (incoming.results ?? []).map((row) => ({
          account: toPublicProfile(row),
          at: row.at ?? now,
          ...(row.note ? { note: row.note } : {}),
        })),
        outgoing: (outgoing.results ?? []).map((row) => ({
          account: toPublicProfile(row),
          at: row.at ?? now,
          ...(row.note ? { note: row.note } : {}),
        })),
      },
      200,
    );
  });

  router.post("/friends", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { error: "not-found" }, 401);
    const body = req.body ?? {};
    const targetId = String(body.id ?? "").trim();
    if (!/^\d{8}$/.test(targetId)) return json(res, { error: "not-found" }, 404);
    if (targetId === me.id) return json(res, { error: "self" }, 400);
    const target = accountById(db, targetId);
    if (!target) return json(res, { error: "not-found" }, 404);

    const friend = db
      .prepare("SELECT 1 AS x FROM friendships WHERE account_id = ? AND friend_id = ?")
      .bind(me.id, targetId)
      .first();
    if (friend) return json(res, { error: "already-friend" }, 409);

    const now = Date.now();
    const mine = db
      .prepare("SELECT status, at FROM friend_requests WHERE from_id = ? AND to_id = ?")
      .bind(me.id, targetId)
      .first();
    // 已经发过、还在等：直接回"已发送"，不再推送（否则对方红点被反复敲）
    if (mine && Number(mine.status ?? 0) === 0) {
      return json(res, { account: toPublicProfile(target), pending: true }, 200);
    }
    // 刚被拒绝：24 小时内不许再来
    if (mine && Number(mine.status ?? 0) === 1 && now - Number(mine.at ?? 0) < REQUEST_COOLDOWN_MS) {
      return json(res, { error: "cooldown" }, 429);
    }

    // 对方已经请求过我 → 直接互相成为好友（少一次点击）
    const reverse = db
      .prepare(
        "SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ? AND COALESCE(status, 0) = 0",
      )
      .bind(targetId, me.id)
      .first();
    if (reverse) {
      db.batch([
        db.prepare("INSERT OR IGNORE INTO friendships (account_id, friend_id, since) VALUES (?, ?, ?)").bind(me.id, targetId, now),
        db.prepare("INSERT OR IGNORE INTO friendships (account_id, friend_id, since) VALUES (?, ?, ?)").bind(targetId, me.id, now),
        db.prepare("DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)").bind(me.id, targetId, targetId, me.id),
      ]);
      // 双向都成了：对方那边的"待处理"要立刻消失，敲他一次
      inbox?.push(targetId, "FRIEND");
      return json(res, { account: toPublicProfile(target) }, 200);
    }

    if (!bumpDaily(db, me.id, "friend-req", FRIEND_REQUEST_DAILY)) {
      return json(res, { error: "rate-limited" }, 429);
    }

    db.prepare(
      "INSERT INTO friend_requests (from_id, to_id, at, note, status) VALUES (?, ?, ?, ?, 0) " +
        "ON CONFLICT(from_id, to_id) DO UPDATE SET at = excluded.at, note = excluded.note, status = 0",
    )
      .bind(me.id, targetId, now, clampNote(body.note))
      .run();
    // 敲一下对方的收件箱：红点几乎立刻出现，不用等他 5 秒一次的好友轮询。
    // 推送只带类型不带内容，对方收到后自己去拉快照（伪造也改不了界面）。
    inbox?.push(targetId, "FRIEND");
    return json(res, { account: toPublicProfile(target), pending: true }, 200);
  });

  router.post("/friends/accept", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { error: "not-found" }, 401);
    const fromId = String((req.body ?? {}).id ?? "").trim();
    const pending = db
      .prepare("SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ?")
      .bind(fromId, me.id)
      .first();
    if (!pending) return json(res, { error: "not-found" }, 404);
    const now = Date.now();
    db.batch([
      db.prepare("INSERT OR IGNORE INTO friendships (account_id, friend_id, since) VALUES (?, ?, ?)").bind(me.id, fromId, now),
      db.prepare("INSERT OR IGNORE INTO friendships (account_id, friend_id, since) VALUES (?, ?, ?)").bind(fromId, me.id, now),
      db.prepare("DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(fromId, me.id),
    ]);
    inbox?.push(fromId, "FRIEND");
    return json(res, { account: toPublicProfile(accountById(db, fromId)) }, 200);
  });

  router.post("/friends/reject", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { error: "not-found" }, 401);
    const fromId = String((req.body ?? {}).id ?? "").trim();
    // 拒绝不删行：把 status 盖成 1、at 刷成现在，申请方 24 小时内再来会拿到 cooldown
    db.prepare("UPDATE friend_requests SET status = 1, at = ? WHERE from_id = ? AND to_id = ?")
      .bind(Date.now(), fromId, me.id)
      .run();
    // 拒绝也要敲：申请方的按钮不能一直转"等待验证"
    inbox?.push(fromId, "FRIEND");
    return json(res, { ok: true }, 200);
  });

  router.patch("/friends/:id", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { error: "not-found" }, 401);
    const raw = String((req.body ?? {}).alias ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const alias = raw ? Array.from(raw).slice(0, 12).join("") : null;
    db.prepare("UPDATE friendships SET alias = ? WHERE account_id = ? AND friend_id = ?")
      .bind(alias, me.id, req.params.id)
      .run();
    return json(res, { ok: true, alias }, 200);
  });

  router.delete("/friends/:id", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { error: "not-found" }, 401);
    const targetId = req.params.id;
    const now = Date.now();
    db.batch([
      db.prepare("DELETE FROM friendships WHERE account_id = ? AND friend_id = ?").bind(me.id, targetId),
      db.prepare("DELETE FROM friendships WHERE account_id = ? AND friend_id = ?").bind(targetId, me.id),
      db.prepare("DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)").bind(me.id, targetId, targetId, me.id),
      // 邀请 / 敲门 / 最近一起玩 一起清干净，别留半条门缝
      db.prepare("DELETE FROM room_invites WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)").bind(me.id, targetId, targetId, me.id),
      db.prepare("DELETE FROM knocks WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)").bind(me.id, targetId, targetId, me.id),
      db.prepare("DELETE FROM recent_plays WHERE (owner_id = ? AND peer_id = ?) OR (owner_id = ? AND peer_id = ?)").bind(me.id, targetId, targetId, me.id),
      // 被删的一方留 24 小时冷却（删人的一方自己可以立刻加回来：冷却只看申请者那一侧）
      db.prepare(
        "INSERT INTO friend_requests (from_id, to_id, at, note, status) VALUES (?, ?, ?, NULL, 1) " +
          "ON CONFLICT(from_id, to_id) DO UPDATE SET at = excluded.at, status = 1",
      ).bind(targetId, me.id, now),
    ]);
    // 被删的一方要立刻从列表里消失，不能等他下次轮询
    inbox?.push(targetId, "FRIEND");
    return json(res, { ok: true }, 200);
  });

  // =========================================================================
  // 在线心跳
  // =========================================================================
  router.post("/presence", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { ok: false }, 200);
    const room = String((req.body ?? {}).roomCode ?? "").trim();
    const roomCode = isValidRoomCode(room) ? room : "";
    db.prepare(
      "INSERT INTO account_presence (account_id, last_seen, room_code) VALUES (?, ?, ?) " +
        "ON CONFLICT(account_id) DO UPDATE SET last_seen = excluded.last_seen, room_code = excluded.room_code",
    )
      .bind(me.id, Date.now(), roomCode || null)
      .run();
    return json(res, { ok: true }, 200);
  });

  // =========================================================================
  // 邀请
  // =========================================================================
  router.post("/invites", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { error: "not-found" }, 401);
    const body = req.body ?? {};
    const toId = String(body.id ?? "").trim();
    const code = String(body.code ?? "").trim();
    if (!/^\d{8}$/.test(toId)) return json(res, { error: "not-found" }, 404);
    if (toId === me.id) return json(res, { error: "self" }, 400);
    if (!isValidRoomCode(code)) return json(res, { error: "room-taken" }, 400);

    const friend = db
      .prepare("SELECT 1 AS x FROM friendships WHERE account_id = ? AND friend_id = ?")
      .bind(me.id, toId)
      .first();
    // 只给好友发：陌生人靠好友请求那套，别让邀请变成骚扰通道
    if (!friend) return json(res, { error: "not-found" }, 403);

    const roomKey = String(body.roomKey ?? "").trim();
    const safeKey = /^[A-Za-z0-9_-]{16,128}$/.test(roomKey) ? roomKey : null;
    if (!bumpDaily(db, me.id, "invite", INVITE_DAILY)) {
      return json(res, { error: "rate-limited" }, 429);
    }
    db.prepare(
      "INSERT INTO room_invites (from_id, to_id, code, at, room_key) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(from_id, to_id) DO UPDATE SET code = excluded.code, at = excluded.at, room_key = excluded.room_key",
    )
      .bind(me.id, toId, code, Date.now(), safeKey)
      .run();
    // 敲对方：邀请本来要等 8 秒轮询，推送之后是"几乎立刻弹出来"
    inbox?.push(toId, "INVITE");
    return json(res, { ok: true }, 200);
  });

  router.get("/invites", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { invites: [] }, 200);
    const now = Date.now();
    const rows = db
      .prepare(
        "SELECT a.*, i.code AS invite_code, i.at AS invite_at, i.room_key AS invite_key, " +
          "p.last_seen AS from_last_seen, p.room_code AS from_room " +
          "FROM room_invites i JOIN accounts a ON a.id = i.from_id " +
          "LEFT JOIN account_presence p ON p.account_id = i.from_id " +
          "WHERE i.to_id = ? AND i.at > ? ORDER BY i.at DESC LIMIT 20",
      )
      .bind(me.id, now - INVITE_TTL_MS)
      .all();
    return json(
      res,
      {
        invites: (rows.results ?? []).map((row) => ({
          from: toPublicProfile(row),
          code: row.invite_code,
          at: row.invite_at,
          fromPresence:
            row.from_last_seen && now - row.from_last_seen <= PRESENCE_ONLINE_MS
              ? {
                  state: "online",
                  lastSeen: row.from_last_seen,
                  ...(row.from_room ? { roomCode: row.from_room } : {}),
                }
              : { state: "offline", lastSeen: row.from_last_seen ?? 0 },
          ...(row.invite_key ? { roomKey: row.invite_key } : {}),
        })),
      },
      200,
    );
  });

  router.delete("/invites/:id", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { ok: false }, 401);
    db.prepare("DELETE FROM room_invites WHERE from_id = ? AND to_id = ?")
      .bind(req.params.id, me.id)
      .run();
    return json(res, { ok: true }, 200);
  });

  // =========================================================================
  // 敲门
  // =========================================================================
  router.get("/knocks", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { knocks: [] }, 200);
    const rows = db
      .prepare(
        "SELECT a.*, k.at AS knock_at FROM knocks k JOIN accounts a ON a.id = k.from_id " +
          "WHERE k.to_id = ? AND k.at > ? ORDER BY k.at DESC LIMIT 10",
      )
      .bind(me.id, Date.now() - KNOCK_TTL_MS)
      .all();
    return json(
      res,
      { knocks: (rows.results ?? []).map((row) => ({ from: toPublicProfile(row), at: row.knock_at })) },
      200,
    );
  });

  router.post("/knocks", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { error: "not-found" }, 401);
    const toId = String((req.body ?? {}).id ?? "").trim();
    if (!/^\d{8}$/.test(toId)) return json(res, { error: "not-found" }, 404);
    if (toId === me.id) return json(res, { error: "self" }, 400);
    // 只允许敲好友：陌生人之间没有"敲门"这回事
    const friend = db
      .prepare("SELECT 1 AS x FROM friendships WHERE account_id = ? AND friend_id = ?")
      .bind(me.id, toId)
      .first();
    if (!friend) return json(res, { error: "not-found" }, 403);

    const now = Date.now();
    const existing = db.prepare("SELECT at FROM knocks WHERE from_id = ? AND to_id = ?").bind(me.id, toId).first();
    // 同一对好友 1 小时只敲一次
    if (existing && now - Number(existing.at ?? 0) < 3600_000) {
      return json(res, { ok: true, pending: true }, 200);
    }
    if (!bumpDaily(db, me.id, "knock", KNOCK_DAILY)) {
      return json(res, { error: "rate-limited" }, 429);
    }
    db.prepare(
      "INSERT INTO knocks (from_id, to_id, at) VALUES (?, ?, ?) " +
        "ON CONFLICT(from_id, to_id) DO UPDATE SET at = excluded.at",
    )
      .bind(me.id, toId, now)
      .run();
    // 「我能进吗」也要立刻送到，否者对方不知道有人在外面等
    inbox?.push(toId, "INVITE");
    return json(res, { ok: true }, 200);
  });

  router.post("/knocks/accept", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { error: "not-found" }, 401);
    const body = req.body ?? {};
    const fromId = String(body.from ?? "").trim();
    const code = String(body.code ?? "").trim();
    if (!/^\d{8}$/.test(fromId)) return json(res, { error: "not-found" }, 404);
    if (!isValidRoomCode(code)) return json(res, { error: "room-taken" }, 400);
    const now = Date.now();
    const knock = db
      .prepare("SELECT 1 AS x FROM knocks WHERE from_id = ? AND to_id = ? AND at > ?")
      .bind(fromId, me.id, now - KNOCK_TTL_MS)
      .first();
    if (!knock) return json(res, { error: "not-found" }, 404);

    const roomKey = String(body.roomKey ?? "").trim();
    const safeKey = /^[A-Za-z0-9_-]{16,128}$/.test(roomKey) ? roomKey : null;
    db.batch([
      db.prepare(
        "INSERT INTO room_invites (from_id, to_id, code, at, room_key) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(from_id, to_id) DO UPDATE SET code = excluded.code, at = excluded.at, room_key = excluded.room_key",
      ).bind(me.id, fromId, code, now, safeKey),
      db.prepare("DELETE FROM knocks WHERE from_id = ? AND to_id = ?").bind(fromId, me.id),
    ]);
    inbox?.push(fromId, "INVITE");
    return json(res, { ok: true }, 200);
  });

  router.delete("/knocks/:id", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { ok: false }, 401);
    db.prepare("DELETE FROM knocks WHERE from_id = ? AND to_id = ?").bind(req.params.id, me.id).run();
    return json(res, { ok: true }, 200);
  });

  // =========================================================================
  // 最近一起玩
  // =========================================================================
  router.get("/recent-plays", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { plays: [] }, 200);
    const rows = db
      .prepare(
        "SELECT a.*, r.at AS play_at FROM recent_plays r JOIN accounts a ON a.id = r.peer_id " +
          "WHERE r.owner_id = ? AND r.at > ? ORDER BY r.at DESC LIMIT 30",
      )
      .bind(me.id, Date.now() - RECENT_PLAY_TTL_MS)
      .all();
    return json(
      res,
      { plays: (rows.results ?? []).map((row) => ({ account: toPublicProfile(row), at: row.play_at })) },
      200,
    );
  });

  router.post("/recent-plays", (req, res) => {
    const me = currentAccount(req, db);
    if (!me) return json(res, { ok: false }, 401);
    const raw = Array.isArray((req.body ?? {}).ids) ? req.body.ids : [];
    const now = Date.now();
    const ids = [...new Set(raw.map((id) => String(id).trim()))]
      .filter((id) => /^\d{8}$/.test(id) && id !== me.id)
      .slice(0, 20);
    if (ids.length === 0) return json(res, { ok: true }, 200);

    const statements = [
      // 顺手清理自己的过期记录（每次上报都清，不需要额外定时任务）
      db.prepare("DELETE FROM recent_plays WHERE owner_id = ? AND at < ?").bind(me.id, now - RECENT_PLAY_TTL_MS),
    ];
    // 先确认 ID 真实存在，再插入（避免把乱填的号写进列表）
    const placeholders = ids.map(() => "?").join(", ");
    const existing = db.prepare(`SELECT id FROM accounts WHERE id IN (${placeholders})`).bind(...ids).all();
    for (const row of existing.results ?? []) {
      statements.push(
        db.prepare(
          "INSERT INTO recent_plays (owner_id, peer_id, at) VALUES (?, ?, ?) " +
            "ON CONFLICT(owner_id, peer_id) DO UPDATE SET at = excluded.at",
        ).bind(me.id, row.id, now),
      );
    }
    db.batch(statements);
    return json(res, { ok: true }, 200);
  });

  return router;
}
