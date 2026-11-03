/**
 * 与 worker 完全同构的纯函数工具。
 *
 * 这一层的唯一目标：**输出逐字节一致**。
 * 密码哈希串格式、cookie 属性、档案字段名，任何一处不同都会导致
 * "老用户登不上"或"客户端解析不出来"，所以这里是照抄，不是重写。
 */

import {
  MAX_AVATAR_CHARS,
  PBKDF2_ROUNDS,
  SESSION_COOKIE,
  ACCOUNT_ROOM_CODE_RE,
} from "./config.mjs";

export const hexOf = (buffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function randomHex(bytes) {
  return hexOf(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
}

/** 生成给人念的随机密码：去掉 0/O/1/l/I 这些看错的字符。 */
export function suggestPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

/**
 * 密码哈希：`pbkdf2$<迭代次数>$<hex>`。
 *
 * 轮数写进串里是老设计留下的好处：将来调强度，老用户的哈希自带次数照样能验。
 * Node 20 的 `crypto.subtle` 与 Workers 同源，所以这段可以原样使用。
 */
export async function pbkdf2Hex(password, salt, rounds = PBKDF2_ROUNDS) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: rounds, hash: "SHA-256" },
    key,
    256,
  );
  return `pbkdf2$${rounds}$${hexOf(bits)}`;
}

/** 校验密码：兼容没有前缀的旧格式（纯 hex，按默认轮数）。 */
export async function verifyPassword(password, salt, stored) {
  const match = /^pbkdf2\$(\d+)\$([0-9a-f]+)$/.exec(String(stored ?? ""));
  if (match) {
    const rounds = Number(match[1]);
    const hash = await pbkdf2Hex(password, salt, rounds);
    return hash === stored;
  }
  const hash = await pbkdf2Hex(password, salt);
  return hash.endsWith(`$${String(stored ?? "")}`) || hash.split("$")[2] === stored;
}

/** 从 Cookie 头里取一个值。 */
export function readCookie(headers, name) {
  const raw = headers.cookie;
  if (!raw) return "";
  for (const part of String(raw).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

/**
 * Set-Cookie 串。
 *
 * 这里比 worker 多一个 `Domain` 的可能：主站是 5blong.site、接口也是同一个域，
 * 所以默认不写 Domain（host-only），最省心。
 * SameSite=Lax 保持不变 —— 前后端同域时它完全够用，而 None 会被 Safari 拦。
 */
export function sessionCookie(token, maxAgeSeconds, secure) {
  const flag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${flag}`;
}

/** 清除 cookie（登出）。 */
export function clearSessionCookie(secure) {
  return sessionCookie("", 0, secure);
}

// ---------------------------------------------------------------------------
// 投影（字段名与客户端契约一致，改一个客户端就白屏）
// ---------------------------------------------------------------------------
export function toProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    avatar: row.avatar ?? "",
    avatarVersion: row.avatar_version ?? 0,
    createdAt: row.created_at,
    ...(row.room_code ? { roomCode: row.room_code } : {}),
    roomCodeLocked: Boolean(row.room_code) && Number(row.room_changes ?? 0) >= 1,
    ...(row.prev_id ? { previousId: row.prev_id } : {}),
  };
}

/** 别人看到的档案：去掉只属于账号主人的字段（房号、锁定状态、previousId）。 */
export function toPublicProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    avatar: row.avatar ?? "",
    avatarVersion: row.avatar_version ?? 0,
    createdAt: row.created_at,
  };
}

export function clampName(value) {
  return String(value ?? "").trim().slice(0, 24);
}

/** 附言：折叠空白、按字符截断（不切坏 emoji），空串存 NULL。 */
export function clampNote(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > 30 ? chars.slice(0, 30).join("") : text;
}

export function clampAvatar(value) {
  const avatar = String(value ?? "");
  if (avatar.length > MAX_AVATAR_CHARS) return { error: "avatar too large" };
  if (avatar && !avatar.startsWith("data:image/")) return { error: "bad avatar" };
  return { avatar };
}

/** 每日额度的日期键（UTC 日；跨 8 小时边界的误差对"防刷"没有影响）。 */
export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** 房间码：4 位老码与 6 位新码都算有效（老链接/老截图不能失效）。 */
export function isValidRoomCode(code) {
  return /^\d{4}$|^\d{6}$/.test(String(code ?? ""));
}

/** 房号（固定房号）只认 6 位。 */
export function isValidOwnRoomCode(code) {
  return ACCOUNT_ROOM_CODE_RE.test(String(code ?? ""));
}
