/**
 * 「我的房间」：**登录账号才有固定房号**（2026-10-26 业主口径）。
 *
 * 归属关系：
 * - **房号**（235417）属于账号，存在账号档案里（`AccountProfile.roomCode`）——
 *   本文件不存它。未登录就没有固定房号，开的是一次性随机房；
 *   退出登录也不会把账号的号丢掉。
 * - **房间钥匙**（roomKey）属于设备，只存本机（本文件负责）——它只用来给邀请链接
 *   签证明。换设备登录同一账号会拿到一把新钥匙：房号不变，旧链接换成新链接即可。
 *
 * 为什么要绑定账号而不是"本机随便领一个"：房号是要念给朋友、写进群公告的东西，
 * 换台电脑就变成另一个号，等于这功能没做。绑定账号后它就跟 ID / 昵称一样是"你的"。
 */

import { isNewRoomCode, normalizeCode, randomToken } from "./protocol";
import { readJson, writeJson } from "./storage";

/**
 * 钥匙按账号分开存：同一台电脑上两个账号各自一把钥匙，
 * 互不干扰（否则换账号后旧链接会突然"能进别人的房"）。
 */
const KEY = "roomKey";

interface KeyBook {
  /** accountId → roomKey */
  keys: Record<string, string>;
}

function book(): KeyBook {
  const stored = readJson<Partial<KeyBook>>(KEY, {});
  return { keys: stored.keys && typeof stored.keys === "object" ? stored.keys : {} };
}

/** 取某账号在这台机器上的房间钥匙；没有就返回 null。 */
export function loadRoomKey(accountId: string): string | null {
  const key = book().keys[accountId];
  return typeof key === "string" && key.length >= 16 ? key : null;
}

/**
 * 取（没有就造一把）某账号的房间钥匙。
 * 同一账号在这台机器上永远拿到同一把 → 邀请链接长期有效。
 */
export function ensureRoomKey(accountId: string): string {
  const existing = loadRoomKey(accountId);
  if (existing) return existing;
  const keys = book().keys;
  keys[accountId] = randomToken(24);
  writeJson(KEY, { keys });
  return keys[accountId]!;
}

/**
 * 换房号时连钥匙一起换：旧链接指向的是旧房号推导出的房主 ID，
 * 留着旧钥匙只会让人点进来发现房间不存在。
 */
export function renewRoomKey(accountId: string): string {
  const keys = book().keys;
  keys[accountId] = randomToken(24);
  writeJson(KEY, { keys });
  return keys[accountId]!;
}

/**
 * 数字 ID 被改过（后台操作）之后，把本机的房间钥匙搬到新 ID 名下。
 *
 * 为什么必须搬：钥匙只存本机、按账号 ID 分桶。ID 一变，客户端就会觉得"这台机器上
 * 没有我的钥匙"，于是新造一把——房号没变，但**之前发出去的邀请链接全部失效**
 * （访客用旧钥匙签证明，房主拿新钥匙算，对不上）。
 *
 * 幂等：目标已有钥匙就什么都不做；源不存在就返回 false（换设备/清过缓存）。
 */
export function migrateRoomKey(fromAccountId: string, toAccountId: string): boolean {
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) return false;
  const keys = book().keys;
  const source = keys[fromAccountId];
  if (!source) return false;
  if (!keys[toAccountId]) keys[toAccountId] = source;
  delete keys[fromAccountId];
  writeJson(KEY, { keys });
  return true;
}

/** 校验用户手填的固定房号（6 位数字）。 */
export function normalizeFixedRoomCode(raw: string): string | null {
  const code = normalizeCode(raw);
  return isNewRoomCode(code) ? code : null;
}
