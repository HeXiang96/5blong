/**
 * 登录态：与 worker 同一套逻辑。
 *
 * 两个凭据都试（Bearer + cookie）：桌面端带 Bearer、网页端靠 cookie，
 * 只认第一个会让"另一个其实有效"的用户莫名被登出。
 */

import { SESSION_COOKIE, SESSION_TTL_MS } from "./config.mjs";
import { randomHex, readCookie, utcDay } from "./util.mjs";

export function accountById(db, id) {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first();
}

/**
 * 当前登录账号（没登录返回 null）。
 *
 * 注意：这里不校验房号、不校验在线，纯身份。
 */
export function currentAccount(req, db) {
  const header = String(req.headers.authorization ?? "");
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const cookie = readCookie(req.headers, SESSION_COOKIE);
  const candidates = [...new Set([bearer, cookie].filter(Boolean))];
  for (const token of candidates) {
    const session = db
      .prepare("SELECT account_id, expires_at FROM account_sessions WHERE token = ?")
      .bind(token)
      .first();
    if (session && session.expires_at >= Date.now()) return accountById(db, session.account_id);
  }
  return null;
}

/** 建会话并顺手清掉该账号的过期会话（别让表越滚越大）。 */
export function createSession(db, accountId) {
  const token = randomHex(32);
  const now = Date.now();
  db.prepare(
    "INSERT INTO account_sessions (token, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(token, accountId, now + SESSION_TTL_MS, now)
    .run();
  db.prepare("DELETE FROM account_sessions WHERE account_id = ? AND expires_at < ?")
    .bind(accountId, now)
    .run();
  return token;
}

/** 8 位数字账号 ID：好友用它加人，也是「我的房间」的绑定键。 */
export function makeAccountId(db) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // 别用 Math.random：这个值既是主键也是加好友的凭据
    const bucket = crypto.getRandomValues(new Uint32Array(1))[0] % 90_000_000;
    const id = String(10_000_000 + bucket);
    const taken = db.prepare("SELECT 1 AS x FROM accounts WHERE id = ?").bind(id).first();
    if (!taken) return id;
  }
  // 极端情况（号池快满）：退回时间戳后 8 位
  return String(Date.now()).slice(-8);
}

/**
 * 每日动作计数：先读后写，超限返回 false。
 * 并发下可能多放过一两次 —— 这是**软上限**，目的是让脚本刷不动，不值得上事务。
 */
export function bumpDaily(db, accountId, kind, limit) {
  const day = utcDay();
  const row = db
    .prepare("SELECT count FROM daily_actions WHERE account_id = ? AND day = ? AND kind = ?")
    .bind(accountId, day, kind)
    .first();
  if (Number(row?.count ?? 0) >= limit) return false;
  db.prepare(
    "INSERT INTO daily_actions (account_id, day, kind, count) VALUES (?, ?, ?, 1) " +
      "ON CONFLICT(account_id, day, kind) DO UPDATE SET count = count + 1",
  )
    .bind(accountId, day, kind)
    .run();
  return true;
}

/*
 * 注：存在性投影（presence）没放在这里 —— 它依赖各接口自己 SELECT 出来的别名列
 * （好友快照用 `p_room`、邀请列表用 `from_room`），抽成通用函数反而容易取错列。
 * 各接口里就地写，与 worker 一致。
 */
