/**
 * 账号 / 好友的最小数据契约（2026-10-26）。
 *
 * 设计约束（必须守住）：
 * - **登录只加功能，不加门禁**：房间进出的任何路径都不读取登录态；
 * - 数字 ID 是主键（8 位，永不变），用户名是展示名（唯一、可搜）；
 * - 好友必须双向同意；单向关系只进「最近一起玩」（同房记录，只自己可见，
 *   7 天过期——见下方 RecentPlay，2026-10-27 落地）。
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
  /**
   * 固定房号「我的房间 235417」——**绑定在账号上**（2026-10-26 业主口径）。
   *
   * - 只有登录账号才有固定房：没登录就是随机房号，退出登录也不该占着别人的号；
   * - 换设备登录同一个账号，房号还是这一个（服务端存；本地适配器存在 localStorage）；
   * - 缺省 = 这个账号还没领号，第一次开房时分配。
   */
  roomCode?: string;
  /**
   * 房号是否已经锁死（业主 2026-10-26）：
   * 每个账号**只有一次**改号机会——首次领号不算改，改过之后这个号永久属于你，
   * 别人再想改成同一个号会被服务端的唯一索引挡下（提示"已被认领"）。
   */
  roomCodeLocked?: boolean;
  /**
   * 后台刚把数字 ID 改过时带上的旧 ID。
   * 客户端据此把本机房间钥匙搬到新 ID 名下（不然老邀请链接会全失效）。
   */
  previousId?: string;
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
  /**
   * 备注名（仅自己可见，2026-10-27）。
   * 好友改了昵称、或者两个人同名时，靠它还能按你熟悉的名字找到他。
   * 空 = 没设备注，界面回落到 `account.name`。
   */
  alias?: string;
}

export interface FriendRequest {
  account: AccountProfile;
  at: number;
  /** 申请附言（≤30 字）：只给 8 位 ID 加人的时候，对方至少知道"我是谁" */
  note?: string;
}

/**
 * 好友发来的房间邀请（2026-10-26 业主口径）。
 *
 * 关键点：**它是一条会被存下来的记录**，不是一闪而过的弹窗——
 * 对方没看见、在忙、关着电脑，回来在好友面板的「邀请」里还留着：
 * "独步吟客 邀请你进语音房 235417 · 3 分钟前"。
 */
export interface RoomInvite {
  from: AccountProfile;
  /** 房间号（私密房还要密码才进得去，密码不在邀请里，得房主另给） */
  code: string;
  /** 发邀请的时间（ms） */
  at: number;
  /**
   * 私密房的房间钥匙（房主发邀请时一起带过来）。
   * 有它就能一键直达；没有（普通房 / 老版本发的邀请）就只带着房号。
   */
  roomKey?: string;
  /**
   * 房主此刻在不在线（2026-10-27）。
   * 23 小时前的邀请如果房主早走了，点「加入」只会得到"房主不在线"——
   * 有了这个字段就能在列表里先标出来，别让人白点。
   */
  fromPresence?: Presence;
}

/**
 * 好友发来的「我想进你的房间」（2026-10-27）。
 *
 * 好友在某个房间里，但那是私密房、我也不知道密码时用。
 * **房主同意后才由他的客户端发出带钥匙的邀请**——钥匙永远只由房主本机提供，
 * 服务端不生成、不推导，安全边界和"只有房主能邀请"完全一致。
 */
export interface Knock {
  from: AccountProfile;
  at: number;
}

/**
 * 最近一起玩过的人（2026-10-27）。
 *
 * 现在加好友只有两条路：知道 8 位 ID，或者在房间里点成员——后者依赖对方客户端
 * 上报 accountId，旧客户端经常加不上。所以把"同房过"记下来给一个入口。
 * 只自己可见，7 天过期，最多 30 条。
 */
export interface RecentPlay {
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
  | "room-taken"
  | "room-locked"
  /** 刚被拒绝过 / 刚被删过，24 小时内不许再申请（2026-10-27） */
  | "cooldown"
  /** 今日好友请求 / 邀请 / 敲门次数超上限（软限流，防脚本刷） */
  | "rate-limited"
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
  updateProfile(
    patch: Partial<Pick<AccountProfile, "name" | "avatar" | "username" | "roomCode">>,
  ): Promise<AuthResult>;
  search(query: string): Promise<AccountProfile[]>;
  /** 加好友。note = 可选的申请附言（≤30 字），对方在「待处理」里能看到。 */
  addFriend(accountId: string, note?: string): Promise<AuthResult>;
  acceptFriend(accountId: string): Promise<AuthResult>;
  rejectFriend(accountId: string): Promise<AuthResult>;
  removeFriend(accountId: string): Promise<AuthResult>;
  /** 改好友备注名（空串 = 清除），只影响自己看到的名字 */
  setAlias(accountId: string, alias: string): Promise<AuthResult>;
  snapshot(): Promise<FriendsSnapshot>;
  /** 房间心跳：用于「在线 · 在 2354 房」这类展示，不参与进房校验 */
  heartbeat(roomCode?: string): void;

  /** 邀请好友进我这间房（只有房主会调；写入一条持久记录，不靠弹窗） */
  sendInvite(accountId: string, roomCode: string, roomKey?: string): Promise<AuthResult>;
  /** 我收到的邀请（按时间新→旧）。已处理过的不会再出现。 */
  invites(): Promise<RoomInvite[]>;
  /** 客户端迁完本机钥匙后调一次，让服务端清掉 previousId */
  ackIdChange(): Promise<void>;
  /** 处理掉一条邀请（加入或忽略都算），之后列表里不再出现 */
  dismissInvite(fromAccountId: string): Promise<void>;

  /**
   * 敲门：请求进入好友正在的房间（2026-10-27）。
   * 房主同意后，他的客户端会发一条带钥匙的邀请过来。
   */
  knock(accountId: string): Promise<AuthResult>;
  /** 我收到的敲门（10 分钟内有效） */
  knocks(): Promise<Knock[]>;
  /** 房主同意：把我房间（code + 可选钥匙）作为邀请发给申请者 */
  acceptKnock(fromAccountId: string, roomCode: string, roomKey?: string): Promise<AuthResult>;
  /** 忽略一次敲门 */
  dismissKnock(fromAccountId: string): Promise<void>;

  /** 最近一起玩过的人（7 天内、最多 30 条，只自己可见） */
  recentPlays(): Promise<RecentPlay[]>;
  /** 上报"我刚和这些人在同一个房间"（客户端负责节流与去重） */
  reportRecentPlays(accountIds: string[]): Promise<void>;
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
  "room-taken": "这个房号已经被别人认领了，换一个试试",
  "room-locked": "房号已经锁定：每个账号只有一次改号机会",
  cooldown: "对方暂时不接受好友申请，过一天再试",
  "rate-limited": "今天操作太频繁了，明天再来",
  unknown: "出了点问题，稍后再试",
};
