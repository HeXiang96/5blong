/**
 * 个人身份：本机生成、无需注册。
 *
 * 与旧版差异：
 * - ID 用 crypto 随机源生成（旧版用 Math.random）。
 * - 颜色不再由 personId 推导死，而是存下来，这样改昵称不会换色、换色也不用改 ID。
 * - 昵称池更大，并提供重名消歧，避免房间里出现两个分不清的"狐狸23"。
 */

import { randomIndex, randomToken, toBase64Url } from "./protocol";
import { readJson, writeJson } from "./storage";

export interface Identity {
  /** 本机唯一 ID，10 位数字，可读可复制。 */
  personId: string;
  name: string;
  /** 头像 dataURL；空串表示用首字母色块。 */
  avatar: string;
  /** 首字母底色（固定调色板，保证与深色/浅色主题都有足够对比）。 */
  color: string;
}

export const AVATAR_COLORS = [
  "#5b8cff",
  "#22b8a6",
  "#f2704f",
  "#a773ff",
  "#e8a33d",
  "#41b6e6",
  "#e05f8a",
  "#6fbf4b",
  "#d4634a",
  "#4f7ce0",
] as const;

const KEY = "identity";

/** 只保留可安全展示与口头念出的字符：10 位数字，首位非 0。 */
function makePersonId(): string {
  let digits = String(1 + randomIndex(9));
  for (let i = 1; i < 10; i++) digits += String(randomIndex(10));
  return digits;
}

const ANIMALS = [
  "狐狸", "熊猫", "水獭", "考拉", "企鹅", "柴犬", "海豹", "小鹿", "浣熊", "松鼠",
  "雪豹", "兔狲", "树懒", "刺猬", "鹦鹉", "锦鲤", "海豚", "鲸头鹳", "旱獭", "驯鹿",
  "仓鼠", "狐獴", "穿山甲", "小熊猫",
];

const ADJECTIVES = [
  "安静", "活泼", "好奇", "认真", "悠哉", "飞快", "温柔", "机灵",
  "低调", "元气", "爱睡", "爱笑", "深夜", "清晨", "雨天", "晴天",
];

export function randomDisplayName(): string {
  const animal = ANIMALS[randomIndex(ANIMALS.length)]!;
  const adjective = ADJECTIVES[randomIndex(ADJECTIVES.length)]!;
  return `${adjective}的${animal}`;
}

function defaultIdentity(): Identity {
  const personId = makePersonId();
  return {
    personId,
    name: randomDisplayName(),
    avatar: "",
    color: AVATAR_COLORS[randomIndex(AVATAR_COLORS.length)]!,
  };
}

function sanitize(raw: Partial<Identity>): Identity | null {
  const personId = typeof raw.personId === "string" ? raw.personId.trim() : "";
  if (!/^\d{10}$/.test(personId)) return null;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 24) : "";
  const avatar = typeof raw.avatar === "string" ? raw.avatar : "";
  const color =
    typeof raw.color === "string" && raw.color ? raw.color : AVATAR_COLORS[0];
  return {
    personId,
    name: name || randomDisplayName(),
    avatar: avatar.startsWith("data:image/") ? avatar : "",
    color,
  };
}

function loadLegacy(): Identity | null {
  // 兼容旧版本写在 5blong:profile 下的资料，迁过来后不再丢弃用户设置。
  try {
    const raw = localStorage.getItem("5blong:profile");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Identity>;
    return sanitize(parsed);
  } catch {
    return null;
  }
}

export function loadIdentity(): Identity {
  const stored = readJson<Partial<Identity>>(KEY, {});
  const identity = sanitize(stored) ?? loadLegacy() ?? defaultIdentity();
  saveIdentity(identity);
  return identity;
}

export function saveIdentity(identity: Identity): boolean {
  return writeJson(KEY, identity);
}

export function initials(name: string): string {
  const trimmed = name.trim();
  return trimmed ? (trimmed[0] ?? "?").toUpperCase() : "?";
}

/** 昵称相似度用的短后缀：同 ID 稳定、不同 ID 基本不撞。 */
export function nameSuffix(personId: string): string {
  return personId.slice(-3);
}

/**
 * 本标签页的会话标识。
 *
 * personId 存在 localStorage，**同一个浏览器里开两个窗口会拿到同一个 ID**；
 * 只用它做重名消歧会让两个窗口显示完全相同的名字（实测确实如此）。
 * 这里按会话生成一个短标识，仅用于消歧，关掉标签页即失效。
 */
let cachedSessionId = "";
export function sessionScopedId(): string {
  if (!cachedSessionId) {
    cachedSessionId = toBase64Url(crypto.getRandomValues(new Uint8Array(6))).replace(
      /[-_]/g,
      "",
    );
  }
  return cachedSessionId;
}

/**
 * 给房间成员分配显示名：重名时补后缀。
 * 优先用会话标识（同人多窗口也能区分），没有才退回 member.id。
 */
export function resolveDisplayNames(
  members: { id: string; name: string; personId?: string; sessionId?: string }[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const member of members) {
    counts.set(member.name, (counts.get(member.name) ?? 0) + 1);
  }
  const result = new Map<string, string>();
  for (const member of members) {
    if ((counts.get(member.name) ?? 0) > 1) {
      const seed = member.sessionId || member.personId || member.id;
      result.set(member.id, `${member.name} · ${nameSuffix(seed)}`);
    } else {
      result.set(member.id, member.name);
    }
  }
  return result;
}

/** 本机一次性会话令牌，用来生成 peer id。 */
export function sessionToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(9)));
}

export { randomToken };
