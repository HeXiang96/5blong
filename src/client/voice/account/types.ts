/**
 * 账号 / 好友的最小数据契约（2026-10-26）。
 *
 * 设计约束（必须守住）：
 * - **登录只加功能，不加门禁**：房间进出的任何路径都不读取登录态；
 * - 数字 ID 是主键（8 位，永不变），用户名是展示名（唯一、可搜）；
 * - 好友必须双向同意；单向只能进「最近一起玩」（后续阶段）。
 */

export interface AccountProfile {
  /** 8 位数字 ID：好友用它加人，永远不变 */
  id: string;
  /** 用户名：唯一、可被搜到、可改（改名有冷却） */
  username: string;
  /** 昵称（房间里显示的名字，和用户名可以不同） */
  name: string;
  /** 头像（data URL 或 R2 URL；没有则用颜色 + 首字） */
  avatar: string;
  /** 头像版本（换头像时变化，用于缓存失效） */
  avatarVersion: number;
  createdAt: number;
}

export type PresenceState = "online" | "offline";

export interface Presence {
  state: PresenceState;
  /** 最后一次心跳（ms） */
  lastSeen: number;
  /** 正在哪个房间（只有在线且进房时有值） */
  roomCode?: string;
}

export interface FriendEntry {
  account: AccountProfile;
  since: number;
  presence: Presence;
}

export interface FriendRequest {
  account: AccountProfile;
  at: number;
}

export interface FriendsSnapshot {
  friends: FriendEntry[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export type AccountError =
  | "username-taken"
  | "username-invalid"
  | "password-weak"
  | "bad-credentials"
  | "not-found"
  | "already-friend"
  | "self"
  | "unknown";

export interface AuthResult {
  account?: AccountProfile;
  error?: AccountError;
}

/** 适配器：本地预览用 localStorage 实现，上线换成 Worker 实现即可。 */
export interface AccountAdapter {
  current(): AccountProfile | null;
  register(input: { username: string; password: string; name?: string }): Promise<AuthResult>;
  login(input: { username: string; password: string }): Promise<AuthResult>;
  logout(): void;
  updateProfile(patch: Partial<Pick<AccountProfile, "name" | "avatar" | "username">>): Promise<AuthResult>;
  search(query: string): Promise<AccountProfile[]>;
  addFriend(accountId: string): Promise<AuthResult>;
  acceptFriend(accountId: string): Promise<AuthResult>;
  rejectFriend(accountId: string): Promise<AuthResult>;
  removeFriend(accountId: string): Promise<AuthResult>;
  snapshot(): Promise<FriendsSnapshot>;
  /** 房间心跳：用于「在线 · 在 2354 房」这类展示，不参与进房校验 */
  heartbeat(roomCode?: string): void;
}

/** 用户名规则：3–16 位，字母数字下划线，首字符必须是字母。 */
export function validateUsername(raw: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]{2,15}$/.test(raw.trim());
}

/** 密码强度：至少 8 位，且不能全是同一种字符。 */
export function validatePassword(raw: string): boolean {
  if (raw.length < 8 || raw.length > 64) return false;
  return new Set(raw).size >= 4;
}

export const ACCOUNT_ERROR_TEXT: Record<AccountError, string> = {
  "username-taken": "这个用户名已被注册，换一个试试",
  "username-invalid": "用户名需 3–16 位，字母开头，只能用字母/数字/下划线",
  "password-weak": "密码至少 8 位，且不要用重复字符",
  "bad-credentials": "用户名或密码不对",
  "not-found": "没找到这个账号（检查 8 位 ID 或用户名）",
  "already-friend": "你们已经是好友了",
  self: "不能加自己为好友",
  unknown: "出了点问题，稍后再试",
};
