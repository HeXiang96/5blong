/**
 * 线上账号适配器：走 Cloudflare Pages Worker 的 `/api/account/*`（D1 存储）。
 *
 * 与本地适配器的差别只在"数据放哪"——UI 一行不用改（接口是 AccountAdapter）。
 *
 * 登录态：
 * - 网页端：Worker 下发 httpOnly cookie（`5blong_sess`），前端拿不到、XSS 偷不走；
 * - 桌面端（tauri.localhost）：跨域第三方 cookie 在 WebView2 里不可靠，所以 Worker
 *   同时把令牌放在响应体里，这里存 localStorage 并用 `Authorization: Bearer` 带上。
 *   两者服务端一视同仁（见 currentAccount）。
 *
 * 固定房号「我的房间」也在这条线上：`PATCH /me { roomCode }` → `accounts.room_code`，
 * 唯一索引保证"一个号只属于一个账号"，绑定的是 8 位数字账号 ID。
 */
import {
  type AccountAdapter,
  type AccountError,
  type AccountProfile,
  type AuthResult,
  type FriendRequest,
  type FriendsSnapshot,
  type RoomInvite,
} from "./types";

const TOKEN_KEY = "5blong.account.token";
const ME_KEY = "5blong.account.me";

function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 接口根地址：
 * - 网页端部署在 Pages 上 → 同源 `/api/account`（cookie 是 first-party，最稳）；
 * - 桌面端从 tauri.localhost 加载 → 必须绝对地址打回 Pages。
 */
function apiBase(): string {
  const override = import.meta.env["VITE_ACCOUNT_API"] as string | undefined;
  if (override) return override.replace(/\/$/, "");
  if (isDesktopRuntime()) return "https://5blong.pages.dev/api/account";
  return "/api/account";
}

/** 服务端错误码 → 客户端契约里的 AccountError（未知一律 unknown，不抛给 UI 原始文本）。 */
function toError(code: unknown): AccountError {
  switch (code) {
    case "username-taken":
    case "username-invalid":
    case "password-weak":
    case "bad-credentials":
    case "not-found":
    case "already-friend":
    case "self":
    case "room-taken":
      return code;
    default:
      return "unknown";
  }
}

export class WorkerAccountAdapter implements AccountAdapter {
  private token = "";
  private me: AccountProfile | null = null;
  private listeners = new Set<() => void>();
  private hydratePromise: Promise<void> | null = null;
  private lastBeat = 0;
  private lastRoom = "";

  constructor() {
    this.token = readToken();
    // 先用缓存把界面点亮（不然每次刷新头像/昵称会闪一下空），再去服务端核对
    this.me = readCachedMe();
    void this.hydrate();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await fetch(`${apiBase()}${path}`, {
        method: init.method ?? "GET",
        headers,
        // 网页端靠 cookie：同源也要显式带上（桌面端是跨域，cookie 未必可用）
        credentials: "include",
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      return { status: 0, data: { error: "unknown" } };
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, data };
  }

  private applyAuth(data: Record<string, unknown>): void {
    const account = (data["account"] ?? null) as AccountProfile | null;
    if (typeof data["token"] === "string" && data["token"]) {
      this.token = data["token"];
      writeToken(this.token);
    }
    this.me = account;
    writeCachedMe(account);
    this.emit();
  }

  /** 用服务端核对一次登录态（cookie 或令牌）。失败静默当未登录，不打扰用户。 */
  async hydrate(): Promise<void> {
    this.hydratePromise ??= (async () => {
      const { data } = await this.request("/me");
      const account = (data["account"] ?? null) as AccountProfile | null;
      this.me = account;
      writeCachedMe(account);
      if (!account) {
        this.token = "";
        writeToken("");
      }
      this.emit();
    })();
    return this.hydratePromise;
  }

  current(): AccountProfile | null {
    return this.me;
  }

  async register(input: { username: string; password: string; name?: string }): Promise<AuthResult> {
    const { data } = await this.request("/register", { method: "POST", body: input });
    if (data["error"]) return { error: toError(data["error"]) };
    this.applyAuth(data);
    return { account: this.me ?? undefined };
  }

  async login(input: { username: string; password: string }): Promise<AuthResult> {
    const { data } = await this.request("/login", { method: "POST", body: input });
    if (data["error"]) return { error: toError(data["error"]) };
    this.applyAuth(data);
    return { account: this.me ?? undefined };
  }

  logout(): void {
    void this.request("/logout", { method: "POST" });
    this.token = "";
    writeToken("");
    this.me = null;
    writeCachedMe(null);
    this.emit();
  }

  async updateProfile(
    patch: Partial<Pick<AccountProfile, "name" | "avatar" | "username" | "roomCode">>,
  ): Promise<AuthResult> {
    const { data } = await this.request("/me", { method: "PATCH", body: patch });
    if (data["error"]) return { error: toError(data["error"]) };
    const account = (data["account"] ?? null) as AccountProfile | null;
    if (account) {
      this.me = account;
      writeCachedMe(account);
      this.emit();
    }
    return { account: account ?? undefined };
  }

  async search(query: string): Promise<AccountProfile[]> {
    const { data } = await this.request(`/search?q=${encodeURIComponent(query)}`);
    return (data["accounts"] as AccountProfile[] | undefined) ?? [];
  }

  private async friendAction(
    path: string,
    id: string,
    method = "POST",
    body?: Record<string, unknown>,
  ): Promise<AuthResult> {
    const { data } = await this.request(path, {
      method,
      body: method === "DELETE" ? undefined : (body ?? { id }),
    });
    if (data["error"]) return { error: toError(data["error"]) };
    const account = (data["account"] ?? null) as AccountProfile | null;
    // 好友变化会改快照，UI 靠 refresh 拉；这里只把"当前账号"顺手同步一下
    this.emit();
    return { account: account ?? undefined };
  }

  addFriend(accountId: string): Promise<AuthResult> {
    return this.friendAction("/friends", accountId);
  }

  acceptFriend(accountId: string): Promise<AuthResult> {
    return this.friendAction("/friends/accept", accountId);
  }

  rejectFriend(accountId: string): Promise<AuthResult> {
    return this.friendAction("/friends/reject", accountId);
  }

  removeFriend(accountId: string): Promise<AuthResult> {
    return this.friendAction(`/friends/${accountId}`, "", "DELETE");
  }

  async snapshot(): Promise<FriendsSnapshot> {
    const { data } = await this.request("/friends");
    return {
      friends: (data["friends"] as FriendsSnapshot["friends"] | undefined) ?? [],
      incoming: (data["incoming"] as FriendRequest[] | undefined) ?? [],
      outgoing: (data["outgoing"] as FriendRequest[] | undefined) ?? [],
    };
  }

  async sendInvite(accountId: string, roomCode: string): Promise<AuthResult> {
    return this.friendAction("/invites", accountId, "POST", { id: accountId, code: roomCode });
  }

  async invites(): Promise<RoomInvite[]> {
    const { data } = await this.request("/invites");
    return (data["invites"] as RoomInvite[] | undefined) ?? [];
  }

  async dismissInvite(fromAccountId: string): Promise<void> {
    await this.request(`/invites/${fromAccountId}`, { method: "DELETE" });
  }

  /**
   * 在线心跳：30 秒一次（useAccount 每 5 秒刷一次好友，那个是读，这个是写）。
   * 服务端 75 秒没收到就算离线——写太勤会把 D1 免费额度烧掉，也没必要。
   */
  heartbeat(roomCode?: string): void {
    if (!this.me) return;
    const now = Date.now();
    const room = roomCode ?? "";
    if (now - this.lastBeat < 30_000 && room === this.lastRoom) return;
    this.lastBeat = now;
    this.lastRoom = room;
    void this.request("/presence", { method: "POST", body: { roomCode: room } });
  }
}

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式：忽略，退回 cookie */
  }
}

function readCachedMe(): AccountProfile | null {
  try {
    const raw = localStorage.getItem(ME_KEY);
    return raw ? (JSON.parse(raw) as AccountProfile) : null;
  } catch {
    return null;
  }
}

function writeCachedMe(account: AccountProfile | null): void {
  try {
    if (account) localStorage.setItem(ME_KEY, JSON.stringify(account));
    else localStorage.removeItem(ME_KEY);
  } catch {
    /* 忽略 */
  }
}
