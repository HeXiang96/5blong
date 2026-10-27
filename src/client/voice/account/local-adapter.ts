/**
 * 本地账号适配器（用于预览 / 单机演示 / 后续离线模式）。
 *
 * 全部数据放 localStorage，跨标签用 BroadcastChannel 广播：
 * 开两个窗口 = 两台设备，可以完整走「注册 → 加好友 → 同意 → 看到在线」。
 *
 * 密码用 PBKDF2-SHA256 存哈希（不存明文），虽然是本地演示也不破例——
 * 免得以后有人把这套代码直接搬到线上。
 *
 * 上线时把 AccountAdapter 换成 Worker 实现即可，UI 一行不用改。
 */
import {
  type AccountAdapter,
  type AccountProfile,
  type AuthResult,
  type FriendRequest,
  type FriendsSnapshot,
  type Knock,
  type Presence,
  type RecentPlay,
  type RoomInvite,
  validatePassword,
  validateUsername,
} from "./types";
import { isNewRoomCode } from "../protocol";

const ACCOUNTS_KEY = "5blong.accounts.v1";
const FRIENDS_KEY = "5blong.friends.v1";
/**
 * 登录态存 sessionStorage 而不是 localStorage：
 * 同一个浏览器开两个窗口 = 两个独立会话，可以拿一个当"朋友"，把
 * 「加好友 → 同意 → 看到对方在线」整条路演示出来。
 * （上线换成 Worker 的 httpOnly cookie 后，这个差异就不存在了。）
 */
const SESSION_KEY = "5blong.session.v1";
const sessionStore = {
  get: (): string | null => sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(SESSION_KEY),
  set: (id: string): void => sessionStorage.setItem(SESSION_KEY, id),
  clear: (): void => {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
  },
};
const AVATAR_KEY = "5blong.avatar.";
/** 房间邀请：toId → fromId → { code, at }（处理后就删掉这条） */
const INVITES_KEY = "5blong.invites.v1";
const CHANNEL = "5blong.account";

interface StoredAccount extends AccountProfile {
  salt: string;
  hash: string;
  /** 改号次数：0 = 还有那唯一一次机会；>=1 = 已锁定 */
  roomChanges?: number;
}

interface FriendGraph {
  /** accountId → 好友 accountId 列表 */
  friends: Record<string, string[]>;
  /** accountId → 待我处理的请求来源 */
  incoming: Record<string, string[]>;
  /** accountId → 我已发出、还没被同意的 */
  outgoing: Record<string, string[]>;
  /**
   * 以下是 2026-10-27 补的字段。
   * 全部可选：老版本写进 localStorage 的图里没有这些键，
   * 读到 undefined 时按空对象处理（`graph.aliases?.[me.id] ?? {}`）。
   */
  /** ownerId → friendId → 备注名（仅 owner 自己能看到） */
  aliases?: Record<string, Record<string, string>>;
  /** fromId → toId → 申请附言（≤30 字） */
  notes?: Record<string, Record<string, string>>;
  /** fromId → toId → 被拒绝/被删除的时间（24 小时冷却） */
  cooldowns?: Record<string, Record<string, number>>;
  /** ownerId → peerId → 一起玩的时间 */
  plays?: Record<string, Record<string, number>>;
  /** toId → fromId → 敲门时间（1 小时去重、10 分钟有效） */
  knocks?: Record<string, Record<string, number>>;
}

/** 与线上 Worker 一致的时间窗（本地演示也要能看出冷却/过期行为）。 */
const REQUEST_COOLDOWN_MS = 24 * 3600_000;
const KNOCK_TTL_MS = 10 * 60_000;
const KNOCK_GAP_MS = 3600_000;
const RECENT_PLAY_TTL_MS = 7 * 24 * 3600_000;
const RECENT_PLAY_MAX = 30;

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额满/隐私模式：忽略，功能降级 */
  }
};

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const randomHex = (bytes: number): string => {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return toHex(array.buffer);
};

async function hashPassword(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: 120_000, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(bits);
}

/** 8 位数字 ID：够用（1 亿），且不像 4–5 位那样能被扫。 */
function makeAccountId(existing: Set<string>): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
    if (!existing.has(value)) return value;
  }
  return String(Date.now()).slice(-8);
}

const stripAccount = (stored: StoredAccount): AccountProfile => ({
  id: stored.id,
  username: stored.username,
  name: stored.name,
  avatar: stored.avatar,
  avatarVersion: stored.avatarVersion,
  createdAt: stored.createdAt,
  ...(stored.roomCode ? { roomCode: stored.roomCode } : {}),
  roomCodeLocked: Boolean(stored.roomCode) && (stored.roomChanges ?? 0) >= 1,
});

/**
 * 预览用种子数据（只在 `?account=demo` 时调用）：
 * 造两个账号，方便一个人也能把「搜索 → 加好友 → 同意」整条路点完。
 * 密码统一 12345678。
 */
export async function seedDemoAccounts(): Promise<void> {
  const accounts = read<Record<string, StoredAccount>>(ACCOUNTS_KEY, {});
  if (Object.keys(accounts).length > 0) return;
  const seed = [
    { id: "48231907", username: "duBu", name: "独步吟客" },
    { id: "53720018", username: "tangxiaofei", name: "无敌唐小菲大王" },
  ];
  for (const item of seed) {
    const salt = randomHex(16);
    accounts[item.id] = {
      ...item,
      avatar: "",
      avatarVersion: 0,
      createdAt: Date.now(),
      salt,
      hash: await hashPassword("12345678", salt),
    };
  }
  write(ACCOUNTS_KEY, accounts);
}

export class LocalAccountAdapter implements AccountAdapter {
  private channel: BroadcastChannel | null = null;
  /** 其他标签页的心跳：accountId → { at, roomCode } */
  private beats = new Map<string, { at: number; roomCode?: string }>();
  private beatTimer = 0;
  private listeners = new Set<() => void>();

  constructor() {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (event: MessageEvent) => {
        const data = event.data as { t?: string; id?: string; at?: number; room?: string };
        if (data?.t !== "beat" || !data.id) return;
        this.beats.set(data.id, { at: data.at ?? Date.now(), roomCode: data.room });
        this.emit();
      };
    }
    // 每 8 秒广播一次自己的在线心跳；12 秒没收到就算离线
    this.beatTimer = window.setInterval(() => this.beat(), 8_000);
  }

  /** UI 订阅：好友状态变化时刷新 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private beat(roomCode?: string): void {
    const me = this.current();
    if (!me) return;
    this.channel?.postMessage({ t: "beat", id: me.id, at: Date.now(), room: roomCode });
  }

  heartbeat(roomCode?: string): void {
    this.beat(roomCode);
  }

  current(): AccountProfile | null {
    const id = sessionStore.get();
    if (!id) return null;
    const accounts = read<Record<string, StoredAccount>>(ACCOUNTS_KEY, {});
    const stored = accounts[id];
    return stored ? stripAccount(stored) : null;
  }

  async register(input: { username: string; password: string; name?: string }): Promise<AuthResult> {
    const username = input.username.trim();
    if (!validateUsername(username)) return { error: "username-invalid" };
    if (!validatePassword(input.password)) return { error: "password-weak" };

    const accounts = read<Record<string, StoredAccount>>(ACCOUNTS_KEY, {});
    const taken = Object.values(accounts).some(
      (item) => item.username.toLowerCase() === username.toLowerCase(),
    );
    if (taken) return { error: "username-taken" };

    const salt = randomHex(16);
    const hash = await hashPassword(input.password, salt);
    const id = makeAccountId(new Set(Object.keys(accounts)));
    const account: StoredAccount = {
      id,
      username,
      name: (input.name ?? username).slice(0, 24),
      avatar: "",
      avatarVersion: 0,
      createdAt: Date.now(),
      salt,
      hash,
    };
    accounts[id] = account;
    write(ACCOUNTS_KEY, accounts);
    sessionStore.set(id);
    this.beat();
    this.emit();
    return { account: stripAccount(account) };
  }

  async login(input: { username: string; password: string }): Promise<AuthResult> {
    const accounts = read<Record<string, StoredAccount>>(ACCOUNTS_KEY, {});
    const found = Object.values(accounts).find(
      (item) => item.username.toLowerCase() === input.username.trim().toLowerCase(),
    );
    if (!found) return { error: "bad-credentials" };
    const hash = await hashPassword(input.password, found.salt);
    if (hash !== found.hash) return { error: "bad-credentials" };
    sessionStore.set(found.id);
    this.beat();
    this.emit();
    return { account: stripAccount(found) };
  }

  logout(): void {
    sessionStore.clear();
    this.emit();
  }

  async updateProfile(
    patch: Partial<Pick<AccountProfile, "name" | "avatar" | "username" | "roomCode">>,
  ): Promise<AuthResult> {
    const me = this.current();
    if (!me) return { error: "not-found" };
    const accounts = read<Record<string, StoredAccount>>(ACCOUNTS_KEY, {});
    const stored = accounts[me.id];
    if (!stored) return { error: "not-found" };

    if (patch.username !== undefined) {
      const username = patch.username.trim();
      if (!validateUsername(username)) return { error: "username-invalid" };
      const taken = Object.values(accounts).some(
        (item) => item.id !== me.id && item.username.toLowerCase() === username.toLowerCase(),
      );
      if (taken) return { error: "username-taken" };
      stored.username = username;
    }
    /*
     * 固定房号（「我的房间 235417」）存在账号上：
     * - 只接受 6 位新码（4 位老码空间太小，不做固定号）；
     * - 同一时间一个房号只能属于一个账号，否则两人开房必撞——本地适配器靠扫表兜住，
     *   换 Worker 后由服务端的唯一索引兜（本地这层校验留着也无害）。
     */
    if (patch.roomCode !== undefined) {
      const roomCode = patch.roomCode.trim();
      if (!isNewRoomCode(roomCode)) return { error: "room-taken" };
      // 每个账号只有一次改号机会：改过就锁死（业主 2026-10-26）
      if (stored.roomCode && (stored.roomChanges ?? 0) >= 1) return { error: "room-locked" };
      const occupied = Object.values(accounts).some(
        (item) => item.id !== me.id && item.roomCode === roomCode,
      );
      if (occupied) return { error: "room-taken" };
      // 首次领号不计数；有号再改就是那唯一一次
      stored.roomChanges = stored.roomCode ? 1 : 0;
      stored.roomCode = roomCode;
    }
    if (patch.name !== undefined) stored.name = patch.name.slice(0, 24) || stored.name;
    if (patch.avatar !== undefined) {
      stored.avatar = patch.avatar;
      stored.avatarVersion += 1;
      // 头像单独存一份，避免塞进 accounts 把整块数据撑大
      if (patch.avatar) localStorage.setItem(AVATAR_KEY + me.id, patch.avatar);
      else localStorage.removeItem(AVATAR_KEY + me.id);
    }
    write(ACCOUNTS_KEY, accounts);
    this.emit();
    return { account: stripAccount(stored) };
  }

  async search(query: string): Promise<AccountProfile[]> {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [];
    const accounts = read<Record<string, StoredAccount>>(ACCOUNTS_KEY, {});
    const me = this.current();
    return Object.values(accounts)
      .filter((item) => item.id !== me?.id)
      .filter(
        (item) =>
          item.id === keyword ||
          item.username.toLowerCase().includes(keyword) ||
          item.name.toLowerCase().includes(keyword),
      )
      .slice(0, 8)
      .map(stripAccount);
  }

  private graph(): FriendGraph {
    return read<FriendGraph>(FRIENDS_KEY, { friends: {}, incoming: {}, outgoing: {} });
  }

  private saveGraph(graph: FriendGraph): void {
    write(FRIENDS_KEY, graph);
  }

  private findById(accountId: string): AccountProfile | null {
    const accounts = read<Record<string, StoredAccount>>(ACCOUNTS_KEY, {});
    const stored = accounts[accountId];
    return stored ? stripAccount(stored) : null;
  }

  async addFriend(accountId: string, note?: string): Promise<AuthResult> {
    const me = this.current();
    if (!me) return { error: "not-found" };
    if (me.id === accountId) return { error: "self" };
    const target = this.findById(accountId);
    if (!target) return { error: "not-found" };

    const graph = this.graph();
    const mine = (graph.friends[me.id] ??= []);
    if (mine.includes(accountId)) return { error: "already-friend" };

    const now = Date.now();
    /*
     * 与线上 Worker 同一套规则（2026-10-27）：
     * - 已经发过、还在等 → 直接返回，不重复打扰对方；
     * - 刚被拒绝/刚被删 → 24 小时内不许再来。
     */
    if ((graph.outgoing[me.id] ?? []).includes(accountId)) return { account: target };
    const cooldown = graph.cooldowns?.[me.id]?.[accountId] ?? 0;
    if (cooldown && now - cooldown < REQUEST_COOLDOWN_MS) return { error: "cooldown" };

    // 对方已经请求过我 → 直接互相成为好友
    const incoming = graph.incoming[me.id] ?? [];
    if (incoming.includes(accountId)) {
      graph.incoming[me.id] = incoming.filter((id) => id !== accountId);
      mine.push(accountId);
      (graph.friends[accountId] ??= []).push(me.id);
      graph.outgoing[accountId] = (graph.outgoing[accountId] ?? []).filter((id) => id !== me.id);
      if (graph.cooldowns?.[me.id]) delete graph.cooldowns[me.id][accountId];
      this.saveGraph(graph);
      this.emit();
      return { account: target };
    }

    graph.outgoing[me.id] = [...(graph.outgoing[me.id] ?? []).filter((id) => id !== accountId), accountId];
    graph.incoming[accountId] = [...(graph.incoming[accountId] ?? []).filter((id) => id !== me.id), me.id];
    const text = (note ?? "").replace(/\s+/g, " ").trim();
    if (text) {
      const notes = (graph.notes ??= {});
      notes[me.id] = { ...(notes[me.id] ?? {}), [accountId]: Array.from(text).slice(0, 30).join("") };
    }
    this.saveGraph(graph);
    this.emit();
    return { account: target };
  }

  async acceptFriend(accountId: string): Promise<AuthResult> {
    const me = this.current();
    if (!me) return { error: "not-found" };
    const graph = this.graph();
    const incoming = graph.incoming[me.id] ?? [];
    if (!incoming.includes(accountId)) return { error: "not-found" };
    graph.incoming[me.id] = incoming.filter((id) => id !== accountId);
    (graph.friends[me.id] ??= []).push(accountId);
    (graph.friends[accountId] ??= []).push(me.id);
    graph.outgoing[accountId] = (graph.outgoing[accountId] ?? []).filter((id) => id !== me.id);
    // 同意了就把"曾经拒过"的记录清掉，别再拦着对方
    if (graph.cooldowns?.[accountId]) delete graph.cooldowns[accountId][me.id];
    this.saveGraph(graph);
    this.emit();
    return { account: this.findById(accountId) ?? undefined };
  }

  async rejectFriend(accountId: string): Promise<AuthResult> {
    const me = this.current();
    if (!me) return { error: "not-found" };
    const graph = this.graph();
    graph.incoming[me.id] = (graph.incoming[me.id] ?? []).filter((id) => id !== accountId);
    graph.outgoing[accountId] = (graph.outgoing[accountId] ?? []).filter((id) => id !== me.id);
    // 留一条冷却记录：对方 24 小时内不能反复申请（删除只清列表，不清这条）
    const cooldowns = (graph.cooldowns ??= {});
    cooldowns[me.id] = { ...(cooldowns[me.id] ?? {}), [accountId]: Date.now() };
    this.saveGraph(graph);
    this.emit();
    return {};
  }

  async removeFriend(accountId: string): Promise<AuthResult> {
    const me = this.current();
    if (!me) return { error: "not-found" };
    const graph = this.graph();
    graph.friends[me.id] = (graph.friends[me.id] ?? []).filter((id) => id !== accountId);
    graph.friends[accountId] = (graph.friends[accountId] ?? []).filter((id) => id !== me.id);
    // 两边残留的申请一起清掉，免得删完又从「待处理」里冒出来
    graph.incoming[me.id] = (graph.incoming[me.id] ?? []).filter((id) => id !== accountId);
    graph.outgoing[me.id] = (graph.outgoing[me.id] ?? []).filter((id) => id !== accountId);
    graph.incoming[accountId] = (graph.incoming[accountId] ?? []).filter((id) => id !== me.id);
    graph.outgoing[accountId] = (graph.outgoing[accountId] ?? []).filter((id) => id !== me.id);
    /*
     * 被删的一方 24 小时内不能把我加回来；删人的一方自己可以立刻加回来
     * （冷却按 `from = 申请者` 判定，所以只写对方 → 我这一侧）。
     */
    const cooldowns = (graph.cooldowns ??= {});
    cooldowns[accountId] = { ...(cooldowns[accountId] ?? {}), [me.id]: Date.now() };
    // 邀请 / 敲门 / 最近一起玩 一起清：删就删干净，别留半条门缝（与线上一致）
    if (graph.knocks?.[me.id]) delete graph.knocks[me.id][accountId];
    if (graph.knocks?.[accountId]) delete graph.knocks[accountId][me.id];
    if (graph.plays?.[me.id]) delete graph.plays[me.id][accountId];
    if (graph.plays?.[accountId]) delete graph.plays[accountId][me.id];
    const book = read<Record<string, Record<string, { code: string; at: number; roomKey?: string }>>>(
      INVITES_KEY,
      {},
    );
    if (book[me.id]) delete book[me.id][accountId];
    if (book[accountId]) delete book[accountId][me.id];
    write(INVITES_KEY, book);
    this.saveGraph(graph);
    this.emit();
    return {};
  }

  /** 备注名（仅自己可见）：空串 = 清除。 */
  async setAlias(accountId: string, alias: string): Promise<AuthResult> {
    const me = this.current();
    if (!me) return { error: "not-found" };
    const graph = this.graph();
    if (!(graph.friends[me.id] ?? []).includes(accountId)) return { error: "not-found" };
    const text = alias.replace(/\s+/g, " ").trim();
    const aliases = (graph.aliases ??= {});
    const mine = { ...(aliases[me.id] ?? {}) };
    if (text) mine[accountId] = Array.from(text).slice(0, 12).join("");
    else delete mine[accountId];
    aliases[me.id] = mine;
    this.saveGraph(graph);
    this.emit();
    return { account: this.findById(accountId) ?? undefined };
  }

  private presenceOf(accountId: string): Presence {
    const at = this.beats.get(accountId);
    if (!at || Date.now() - at.at > 12_000) {
      return { state: "offline", lastSeen: at?.at ?? 0 };
    }
    return { state: "online", lastSeen: at.at, roomCode: at.roomCode };
  }

  async sendInvite(accountId: string, roomCode: string, roomKey?: string): Promise<AuthResult> {
    const me = this.current();
    if (!me) return { error: "not-found" };
    if (me.id === accountId) return { error: "self" };
    const target = this.findById(accountId);
    if (!target) return { error: "not-found" };
    // 与线上口径一致：只给好友发邀请（陌生人走好友请求那套）
    if (!(this.graph().friends[me.id] ?? []).includes(accountId)) return { error: "not-found" };
    const book = read<Record<string, Record<string, { code: string; at: number }>>>(INVITES_KEY, {});
    (book[accountId] ??= {})[me.id] = {
      code: roomCode,
      at: Date.now(),
      ...(roomKey ? { roomKey } : {}),
    };
    write(INVITES_KEY, book);
    this.emit();
    return { account: target };
  }

  async ackIdChange(): Promise<void> {
    // 本地适配器不会改数字 ID（只有后台能改），这里不需要做什么
  }

  async invites(): Promise<RoomInvite[]> {
    const me = this.current();
    if (!me) return [];
    const book = read<Record<string, Record<string, { code: string; at: number; roomKey?: string }>>>(
      INVITES_KEY,
      {},
    );
    const mine = book[me.id] ?? {};
    return Object.entries(mine)
      .map(([fromId, item]): RoomInvite | null => {
        const from = this.findById(fromId);
        return from
          ? {
              from,
              code: item.code,
              at: item.at,
              // 本地版以前把 roomKey 吞掉了：私密房在预览里永远要不到钥匙
              ...(item.roomKey ? { roomKey: item.roomKey } : {}),
              // 房主在不在线（与线上一致）：让界面能标出"这条邀请可能已经失效"
              fromPresence: this.presenceOf(fromId),
            }
          : null;
      })
      .filter((item): item is RoomInvite => item !== null)
      .sort((a, b) => b.at - a.at);
  }

  async dismissInvite(fromAccountId: string): Promise<void> {
    const me = this.current();
    if (!me) return;
    const book = read<Record<string, Record<string, { code: string; at: number }>>>(INVITES_KEY, {});
    if (book[me.id]) {
      delete book[me.id][fromAccountId];
      write(INVITES_KEY, book);
    }
    this.emit();
  }

  async snapshot(): Promise<FriendsSnapshot> {
    const me = this.current();
    if (!me) return { friends: [], incoming: [], outgoing: [] };
    const graph = this.graph();
    const pick = (ids: string[]): AccountProfile[] =>
      ids.map((id) => this.findById(id)).filter((item): item is AccountProfile => item !== null);
    const aliases = graph.aliases?.[me.id] ?? {};
    const friends = pick(graph.friends[me.id] ?? []).map((account) => ({
      account,
      since: Date.now(),
      presence: this.presenceOf(account.id),
      ...(aliases[account.id] ? { alias: aliases[account.id] } : {}),
    }));
    const incoming: FriendRequest[] = pick(graph.incoming[me.id] ?? []).map((account) => ({
      account,
      at: Date.now(),
      ...(graph.notes?.[account.id]?.[me.id] ? { note: graph.notes[account.id][me.id] } : {}),
    }));
    const outgoing: FriendRequest[] = pick(graph.outgoing[me.id] ?? []).map((account) => ({
      account,
      at: Date.now(),
      ...(graph.notes?.[me.id]?.[account.id] ? { note: graph.notes[me.id][account.id] } : {}),
    }));
    return { friends, incoming, outgoing };
  }

  // ---- 敲门（2026-10-27）：与线上 Worker 同一套语义 ----

  async knock(accountId: string): Promise<AuthResult> {
    const me = this.current();
    if (!me) return { error: "not-found" };
    if (me.id === accountId) return { error: "self" };
    const target = this.findById(accountId);
    if (!target) return { error: "not-found" };
    if (!(this.graph().friends[me.id] ?? []).includes(accountId)) return { error: "not-found" };
    const graph = this.graph();
    const now = Date.now();
    const mine = graph.knocks?.[accountId]?.[me.id] ?? 0;
    if (mine && now - mine < KNOCK_GAP_MS) return { account: target };
    const knocks = (graph.knocks ??= {});
    knocks[accountId] = { ...(knocks[accountId] ?? {}), [me.id]: now };
    this.saveGraph(graph);
    this.emit();
    return { account: target };
  }

  async knocks(): Promise<Knock[]> {
    const me = this.current();
    if (!me) return [];
    const now = Date.now();
    const mine = this.graph().knocks?.[me.id] ?? {};
    return Object.entries(mine)
      .filter(([, at]) => now - at <= KNOCK_TTL_MS)
      .map(([fromId, at]) => {
        const from = this.findById(fromId);
        return from ? { from, at } : null;
      })
      .filter((item): item is Knock => item !== null)
      .sort((a, b) => b.at - a.at);
  }

  async acceptKnock(fromAccountId: string, roomCode: string, roomKey?: string): Promise<AuthResult> {
    const me = this.current();
    if (!me) return { error: "not-found" };
    const graph = this.graph();
    const at = graph.knocks?.[me.id]?.[fromAccountId] ?? 0;
    if (!at || Date.now() - at > KNOCK_TTL_MS) return { error: "not-found" };
    // 与 sendInvite 同一份存储：对方会在「待处理 → 邀请」里看到这一条
    const book = read<Record<string, Record<string, { code: string; at: number; roomKey?: string }>>>(
      INVITES_KEY,
      {},
    );
    (book[fromAccountId] ??= {})[me.id] = {
      code: roomCode,
      at: Date.now(),
      ...(roomKey ? { roomKey } : {}),
    };
    write(INVITES_KEY, book);
    if (graph.knocks?.[me.id]) delete graph.knocks[me.id][fromAccountId];
    this.saveGraph(graph);
    this.emit();
    return { account: this.findById(fromAccountId) ?? undefined };
  }

  async dismissKnock(fromAccountId: string): Promise<void> {
    const me = this.current();
    if (!me) return;
    const graph = this.graph();
    if (graph.knocks?.[me.id]) delete graph.knocks[me.id][fromAccountId];
    this.saveGraph(graph);
    this.emit();
  }

  // ---- 最近一起玩 ----

  async recentPlays(): Promise<RecentPlay[]> {
    const me = this.current();
    if (!me) return [];
    const now = Date.now();
    const mine = this.graph().plays?.[me.id] ?? {};
    return Object.entries(mine)
      .filter(([, at]) => now - at <= RECENT_PLAY_TTL_MS)
      .map(([id, at]) => {
        const account = this.findById(id);
        return account ? { account, at } : null;
      })
      .filter((item): item is RecentPlay => item !== null)
      .sort((a, b) => b.at - a.at)
      .slice(0, RECENT_PLAY_MAX);
  }

  async reportRecentPlays(accountIds: string[]): Promise<void> {
    const me = this.current();
    if (!me) return;
    const now = Date.now();
    const graph = this.graph();
    const plays = (graph.plays ??= {});
    const mine = { ...(plays[me.id] ?? {}) };
    let changed = false;
    for (const id of accountIds) {
      if (!/^\d{8}$/.test(id) || id === me.id) continue;
      if (!this.findById(id)) continue;
      mine[id] = now;
      changed = true;
    }
    if (!changed) return;
    // 只留最近 30 条，和线上一致
    const trimmed = Object.entries(mine)
      .sort((a, b) => b[1] - a[1])
      .slice(0, RECENT_PLAY_MAX);
    plays[me.id] = Object.fromEntries(trimmed);
    this.saveGraph(graph);
    this.emit();
  }

  dispose(): void {
    window.clearInterval(this.beatTimer);
    this.channel?.close();
    this.listeners.clear();
  }
}
