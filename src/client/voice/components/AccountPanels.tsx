/**
 * 账号面板（登录/注册 + 我的资料）与好友抽屉。
 *
 * 视觉沿用首页那套「纸面 + 木框」，不引入白底卡片——见 styles.css 里的
 * .vx-sheet / .vx-sheet-* 类。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, DoorOpen, LogOut, MoreHorizontal, Pencil, Search, Trash2, UserPlus, X } from "lucide-react";

import landingPigUrl from "../assets/landing-pig.webp?url";

import { Avatar } from "./ui";
import type {
  AccountAdapter,
  AccountError,
  AccountProfile,
  FriendEntry,
  FriendsSnapshot,
  Knock,
  RecentPlay,
  RoomInvite,
} from "../account/types";
import { ACCOUNT_ERROR_TEXT, validatePassword, validateUsername } from "../account/types";

/**
 * 空状态插画：线描小猪 / 叶子。
 *
 * 原来用的是 🐷 emoji，和整套手绘木牌风格完全不搭（2026-10-26 反馈）。
 * 这里改用极简线描，颜色走 currentColor，深浅主题自动跟随。
 */
function EmptyArt({ variant }: { variant: "pig" | "leaf" }) {
  if (variant === "leaf") {
    return (
      <svg viewBox="0 0 64 64" width="44" height="44" aria-hidden fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M46 18c-16 0-28 9-28 22 0 3 1 6 2 8 14 0 26-12 26-30z" />
        <path d="M20 48c6-9 14-16 24-21" />
      </svg>
    );
  }
  /*
   * 用产品自己的吉祥物（落地页那只动画猪），比手画线描可爱、也更一致。
   * 同一个资源已在首页加载过，这里不会额外多一次网络请求。
   */
  return <img className="vx-empty-pig" src={landingPigUrl} alt="" width={64} height={64} />;
}

interface AccountDialogProps {
  open: boolean;
  adapter: AccountAdapter;
  account: AccountProfile | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenFriends: () => void;
}

/** 登录 / 注册 / 我的资料，三合一。 */
export function AccountDialog({
  open,
  adapter,
  account,
  onClose,
  onChanged,
  onOpenFriends,
}: AccountDialogProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<AccountError | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setError(null);
      setBusy(false);
      setCopied(false);
      return;
    }
    /*
     * 表单弹窗**不能点背景就关**（2026-10-26 反馈：填到一半点一下外面，
     * 用户名密码全丢）。只认 ✕ 和 Esc，避免误触丢输入。
     */
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result =
      mode === "login"
        ? await adapter.login({ username, password })
        : await adapter.register({ username, password, name: displayName || username });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setPassword("");
    onChanged();
    // 注册成功**不关窗**：立刻让他看见自己的 8 位 ID（新人最需要这个）
    if (mode === "login") onClose();
  };

  const pickAvatar = async (file: File) => {
    // 客户端裁剪到 256×256 WebP：单张 ~20KB，R2 存得下几十万张
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const scale = Math.max(256 / bitmap.width, 256 / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    ctx.drawImage(bitmap, (256 - width) / 2, (256 - height) / 2, width, height);
    const dataUrl = canvas.toDataURL("image/webp", 0.85);
    await adapter.updateProfile({ avatar: dataUrl });
    onChanged();
  };

  // ---- 已登录：我的资料 ----
  if (account) {
    return (
      <div className="vx-modal-backdrop">
        <div className="vx-sheet">
          <div className="vx-sheet-head">
            <strong>我的资料</strong>
            <button type="button" className="vx-icon-btn" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </button>
          </div>

          <div className="vx-profile">
            <Avatar avatar={account.avatar} color="#b783d9" name={account.name} size={64} />
            <div className="vx-profile-main">
              <label className="vx-sheet-btn vx-profile-avatar">
                更换头像
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void pickAvatar(file);
                  }}
                />
              </label>
              <span className="vx-sheet-hint">自动裁成 256×256，约 20KB</span>
            </div>
          </div>

          <div className="vx-sheet-row">
            <span>昵称</span>
            <input
              className="vx-sheet-input"
              value={account.name}
              onChange={(event) => {
                void adapter.updateProfile({ name: event.target.value }).then(onChanged);
              }}
              maxLength={24}
            />
          </div>

          <div className="vx-sheet-row">
            <span>用户名</span>
            <span className="vx-sheet-value">{account.username}</span>
          </div>

          <div className="vx-sheet-row">
            <span>我的 ID</span>
            <button
              type="button"
              className="vx-sheet-value vx-sheet-copy"
              onClick={() => {
                void navigator.clipboard?.writeText(account.id);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {account.id} <Copy size={12} /> {copied ? "已复制" : ""}
            </button>
          </div>

          <p className="vx-sheet-hint">
            把这串 ID 发给朋友，他们在「好友 → 添加」里输入就能加你。房间里显示的是昵称，ID 不出现在猪圈里。
          </p>

          <div className="vx-sheet-actions">
            <button type="button" className="vx-btn vx-btn-ghost" onClick={onOpenFriends}>
              打开好友
            </button>
            <button
              type="button"
              className="vx-btn vx-btn-ghost vx-sheet-danger"
              onClick={() => {
                adapter.logout();
                onChanged();
                onClose();
              }}
            >
              <LogOut size={14} /> 退出登录
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- 未登录：登录 / 注册 ----
  return (
    <div className="vx-modal-backdrop">
      <div className="vx-sheet">
        <div className="vx-sheet-head">
          <strong>{mode === "login" ? "登录" : "注册"}</strong>
          <button type="button" className="vx-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <p className="vx-sheet-hint">
          <b>登录是可选的</b>：不登录照样能建房、进房、开麦、看共享。登录只是多出好友和“谁在线”。
        </p>

        <div className="vx-sheet-row">
          <span>用户名</span>
          <input
            className="vx-sheet-input"
            value={username}
            autoFocus
            spellCheck={false}
            placeholder="3–16 位，字母开头"
            onChange={(event) => {
              setUsername(event.target.value);
              setError(null);
            }}
          />
        </div>

        {mode === "register" ? (
          <div className="vx-sheet-row">
            <span>昵称</span>
            <input
              className="vx-sheet-input"
              value={displayName}
              maxLength={24}
              placeholder="房间里显示的名字（可不填）"
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
        ) : null}

        <div className="vx-sheet-row">
          <span>密码</span>
          <input
            className="vx-sheet-input"
            type="password"
            value={password}
            placeholder={mode === "register" ? "至少 8 位" : ""}
            onChange={(event) => {
              setPassword(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </div>

        {error ? <p className="vx-sheet-error">{ACCOUNT_ERROR_TEXT[error]}</p> : null}
        {mode === "register" && username && !validateUsername(username) ? (
          <p className="vx-sheet-error">{ACCOUNT_ERROR_TEXT["username-invalid"]}</p>
        ) : null}
        {mode === "register" && password && !validatePassword(password) ? (
          <p className="vx-sheet-error">{ACCOUNT_ERROR_TEXT["password-weak"]}</p>
        ) : null}

        <div className="vx-sheet-actions">
          <button
            type="button"
            className="vx-btn vx-btn-primary"
            disabled={busy || !username || !password}
            onClick={() => void submit()}
          >
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册"}
          </button>
          <button
            type="button"
            className="vx-btn vx-btn-ghost"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "没有账号？注册" : "已有账号？登录"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 「3 分钟前」这类相对时间——邀请要留档，时间得说人话（超过一天直接给天数）。 */
function minutesAgo(at: number): string {
  const diff = Math.max(0, Date.now() - at);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 备注名优先、昵称兜底（2026-10-27）：好友改了昵称，你还按熟悉的名字找到他。 */
function nameOf(entry: FriendEntry): string {
  return entry.alias?.trim() || entry.account.name;
}

/** 一行里正在展开的东西：⋯ 菜单 / 改备注 / 确认移除。 */
type RowState = { id: string; kind: "menu" | "alias" | "remove" } | null;

interface FriendsDrawerProps {
  open: boolean;
  adapter: AccountAdapter;
  snapshot: FriendsSnapshot;
  onClose: () => void;
  onChanged: () => void;
  /** 当前所在房间（用于显示"在 2354 房"、判断能不能邀请） */
  roomCode?: string | null;
  /** 邀请：把邀请推到对方的好友面板（离线也不丢） */
  onInvite?: (account: AccountProfile) => Promise<boolean>;
  /**
   * 能不能邀请：**只有房主可以**（2026-10-26 业主口径）。
   * 成员可以自己复制房间码发给朋友，但"从好友列表拉人"是房主的动作。
   */
  canInvite?: boolean;
  /** 好友发来的房间邀请（会留档，不靠一闪而过的弹窗） */
  invites?: RoomInvite[];
  onJoinInvite?: (invite: RoomInvite) => void;
  onDismissInvite?: (invite: RoomInvite) => void;
  /**
   * 敲门：好友在某个房间里、但我进不去（私密房没钥匙）时，请求他放我进去。
   * 房主同意后，他会发一条带钥匙的邀请过来。
   */
  onKnock?: (account: AccountProfile) => Promise<boolean>;
  /** 我收到的敲门（房主侧，10 分钟内有效） */
  knocks?: Knock[];
  onAcceptKnock?: (knock: Knock) => void;
  onDismissKnock?: (knock: Knock) => void;
  /** 最近一起玩过的人：加好友最自然的入口（同房记录，只自己可见） */
  recentPlays?: RecentPlay[];
}

/**
 * 好友抽屉（2026-10-27 重做）。
 *
 * 这一版解决四件事：
 *   1. **删得掉**：每行有 ⋯ 菜单（邀请 / 请求进入 / 备注名 / 移除好友）。
 *      上一版只有「邀请」一个按钮，加错人以后用户没有任何自救手段。
 *   2. **看得清谁叫得动**：按 在房间里 → 在线 → 离线 三段分组，不再按"加好友时间"排。
 *   3. **四个 tab 收成三个**：请求和邀请本来就是同一件事的两面（都是"待你处理"），
 *      合并后新用户不用猜该点哪个；敲门也放进这里。
 *   4. **有入口能找到人**：底部「最近一起玩」解决"刚一起玩得很开心却加不上"。
 */
export function FriendsDrawer({
  open,
  adapter,
  snapshot,
  onClose,
  onChanged,
  roomCode,
  onInvite,
  canInvite = false,
  invites = [],
  onJoinInvite,
  onDismissInvite,
  onKnock,
  knocks = [],
  onAcceptKnock,
  onDismissKnock,
  recentPlays = [],
}: FriendsDrawerProps) {
  const [tab, setTab] = useState<"friends" | "pending" | "recent" | "add">("friends");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AccountProfile[]>([]);
  /** 附言草稿：所有"加好友"入口共用（搜索结果 / 最近一起玩） */
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState("");
  const [row, setRow] = useState<RowState>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  /** 已经邀请过的好友（按钮显示「已邀请」，2.4 秒后复原） */
  const [invited, setInvited] = useState<Set<string>>(new Set());
  /** 已经敲过门的好友 */
  const [knocked, setKnocked] = useState<Set<string>>(new Set());
  const searchTimer = useRef(0);

  const runSearch = useCallback(
    (value: string) => {
      window.clearTimeout(searchTimer.current);
      searchTimer.current = window.setTimeout(() => {
        void adapter.search(value).then(setResults);
      }, 180);
    },
    [adapter],
  );

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setNote("");
      setFeedback("");
      setRow(null);
      return;
    }
    // popover 语义：点卡片外面关闭；点在卡片内或好友按钮上不关
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".vx-friends")) return;
      if (target.closest(".vx-friends-btn")) return;
      if (target.closest(".vx-sign-friends")) return;
      // 操作浮层在抽屉内部；不能因为点它就关掉整个抽屉
      if (target.closest(".vx-friend-sheet")) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  /*
   * 操作浮层自己也要「点外面关掉」。
   *
   * ⚠️ 这里必须认 **.vx-friend-sheet**（浮层的真实类名），而不是它前身的 `.vx-friend-menu`。
   * 2026-10-27 业主报「点备注名/移除好友没反应，界面直接消失」就是这个原因：
   * pointerdown 落在浮层按钮上却被判成「点了外面」→ 先 setRow(null) 关掉浮层，
   * 等 click 事件到达时按钮已经不在 DOM 里，onClick 永远不执行。
   * 换句话说：看到的「没反应」其实是「点空了」。
   */
  useEffect(() => {
    if (!row) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".vx-friend-sheet")) return;
      if (target.closest(".vx-friend-more")) return;
      if (target.closest(".vx-friend-row") && row.kind !== "menu") return;
      setRow(null);
    };
    const onScroll = () => {
      if (row.kind === "menu") setRow(null);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [row]);

  const pendingCount = snapshot.incoming.length + invites.length + knocks.length;

  /** 在房间里 → 在线 → 离线（组内按显示名）。 */
  const groups = useMemo(() => {
    const inRoom: FriendEntry[] = [];
    const online: FriendEntry[] = [];
    const offline: FriendEntry[] = [];
    for (const entry of snapshot.friends) {
      const isOnline = entry.presence.state === "online";
      const away = Boolean(entry.presence.roomCode && entry.presence.roomCode !== roomCode);
      if (isOnline && away) inRoom.push(entry);
      else if (isOnline) online.push(entry);
      else offline.push(entry);
    }
    const byName = (a: FriendEntry, b: FriendEntry) =>
      nameOf(a).localeCompare(nameOf(b), "zh-Hans-CN");
    inRoom.sort(byName);
    online.sort(byName);
    offline.sort(byName);
    return (
      [
        { key: "in-room", label: "在房间里", entries: inRoom },
        { key: "online", label: "在线", entries: online },
        { key: "offline", label: "离线", entries: offline },
      ] as const
    ).filter((group) => group.entries.length > 0);
  }, [snapshot.friends, roomCode]);

  /** 最近一起玩：去掉已经是好友的（那是废话），最多 8 条。 */
  const recent = useMemo(() => {
    const friendIds = new Set(snapshot.friends.map((entry) => entry.account.id));
    return recentPlays.filter((play) => !friendIds.has(play.account.id)).slice(0, 8);
  }, [recentPlays, snapshot.friends]);

  if (!open) return null;

  /**
   * 当前展开 ⋯ 菜单的那位好友。
   *
   * 菜单做在**抽屉底部的浮条**里，而不是跟在行后面：
   *   1. 列表是 `overflow-y: auto`，跟在行后面的绝对定位元素会被裁掉（最后几行看不见）；
   *   2. 挂到 body 用 fixed 坐标又会被页面自身的缩放/布局带偏（实测偏了 90px）。
   * 底部浮条不依赖任何坐标，位置永远稳定，也不遮挡"我是对谁操作"——标题写着名字。
   */
  const menuEntry =
    row?.kind === "menu"
      ? (snapshot.friends.find((entry) => entry.account.id === row.id) ?? null)
      : null;

  const doInvite = async (account: AccountProfile) => {
    const ok = await onInvite?.(account);
    if (!ok) return;
    // 文案：这是"邀请已推送"，不是"复制"——上一版写成「已复制」，用户会去剪贴板找
    setInvited((prev) => new Set(prev).add(account.id));
    window.setTimeout(() => {
      setInvited((prev) => {
        const next = new Set(prev);
        next.delete(account.id);
        return next;
      });
    }, 2_400);
  };

  const doKnock = async (account: AccountProfile) => {
    const ok = await onKnock?.(account);
    setRow(null);
    if (!ok) return;
    setKnocked((prev) => new Set(prev).add(account.id));
    window.setTimeout(() => {
      setKnocked((prev) => {
        const next = new Set(prev);
        next.delete(account.id);
        return next;
      });
    }, 3_000);
  };

  const saveAlias = async (accountId: string) => {
    await adapter.setAlias(accountId, aliasDraft);
    setRow(null);
    onChanged();
  };

  const doRemove = async (accountId: string) => {
    await adapter.removeFriend(accountId);
    setRow(null);
    setFeedback("已移除。对方那边也会从列表里消失。");
    onChanged();
  };

  const addFriend = async (account: AccountProfile) => {
    const result = await adapter.addFriend(account.id, note);
    setFeedback(
      result.error ? ACCOUNT_ERROR_TEXT[result.error] : "已发送请求，等对方同意（附言会一起带过去）",
    );
    setNote("");
    onChanged();
  };

  /** 好友行（含 ⋯ 菜单、备注名编辑、移除确认）。 */
  const renderFriend = (entry: FriendEntry) => {
    const online = entry.presence.state === "online";
    const awayRoom = entry.presence.roomCode;
    const inOtherRoom = Boolean(awayRoom && awayRoom !== roomCode);
    const inMyRoom = Boolean(awayRoom && roomCode && awayRoom === roomCode);
    const id = entry.account.id;
    const isMenu = row !== null && row.id === id && row.kind === "menu";
    const isAlias = row !== null && row.id === id && row.kind === "alias";
    const isRemove = row !== null && row.id === id && row.kind === "remove";

    return (
      <div
        className={`vx-friend-row ${online ? "vx-friend-row-on" : "vx-friend-row-off"}`}
        key={id}
      >
        <span className={`vx-friend-dot${online ? " vx-friend-dot-on" : ""}`} aria-hidden />
        <Avatar avatar={entry.account.avatar} color="#b783d9" name={nameOf(entry)} size={34} />

        {isAlias ? (
          <div className="vx-friend-main">
            <input
              className="vx-friend-edit"
              autoFocus
              value={aliasDraft}
              maxLength={12}
              placeholder={entry.account.name}
              onChange={(event) => setAliasDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveAlias(id);
                if (event.key === "Escape") setRow(null);
              }}
            />
            <span className="vx-friend-sub">备注只你自己看得见 · Enter 保存</span>
          </div>
        ) : isRemove ? (
          <div className="vx-friend-main">
            <b>移除 {nameOf(entry)}？</b>
            <span className="vx-friend-sub">双方列表里都会消失，24 小时内他不能再加你</span>
          </div>
        ) : (
          <div className="vx-friend-main">
            <b title={`${entry.account.username} · ${entry.account.id}`}>{nameOf(entry)}</b>
            <span className="vx-friend-sub" title={inOtherRoom ? `在 ${awayRoom} 房` : undefined}>
              {/*
               * 状态压到最短（2026-10-27 实拍）：原来写"在 612845 房"，占掉 80px，
               * 长名字直接被截成 "Foam..."。现在只留房号徽标 / 本房 / 在线 / 离线。
               */}
              {inMyRoom ? (
                "本房"
              ) : online ? (
                inOtherRoom ? (
                  <i className="vx-friend-room">{awayRoom}</i>
                ) : (
                  "在线"
                )
              ) : (
                "离线"
              )}
            </span>
          </div>
        )}

        {isAlias ? (
          <>
            <button type="button" className="vx-btn vx-btn-small vx-btn-primary" onClick={() => void saveAlias(id)}>
              保存
            </button>
            <button type="button" className="vx-btn vx-btn-small vx-btn-quiet" onClick={() => setRow(null)}>
              取消
            </button>
          </>
        ) : isRemove ? (
          <>
            <button type="button" className="vx-btn vx-btn-small vx-friend-danger" onClick={() => void doRemove(id)}>
              移除
            </button>
            <button type="button" className="vx-btn vx-btn-small vx-btn-quiet" onClick={() => setRow(null)}>
              取消
            </button>
          </>
        ) : (
          <>
            {/*
              主按钮只放"此刻真能做的事"：
              在别的房间 → 请求进入；我是不房主但对方在线 → 邀请；
              其它情况（我在房间里、或对方离线）不放大按钮，收进 ⋯ 里。
            */}
            {inOtherRoom ? (
              <button
                type="button"
                className="vx-friend-act"
                onClick={() => void doKnock(entry.account)}
                title="发一条请求，房主同意后会把房间钥匙发给你"
              >
                {knocked.has(id) ? "已请求" : "进房"}
              </button>
            ) : canInvite && online && roomCode && !inMyRoom ? (
              <button
                type="button"
                className="vx-friend-act"
                onClick={() => void doInvite(entry.account)}
                title="把邀请推到他的好友面板（离线也不会丢）"
              >
                {invited.has(id) ? "已邀请" : "邀请"}
              </button>
            ) : null}

            <button
              type="button"
              className={`vx-friend-more${isMenu ? " vx-friend-more-on" : ""}`}
              aria-label="更多操作"
              aria-expanded={isMenu}
              onClick={() => setRow(isMenu ? null : { id, kind: "menu" })}
            >
              <MoreHorizontal size={16} />
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <aside className="vx-friends" aria-label="好友">
      <div className="vx-friends-head">
        <div className="vx-friends-title">
          <b>好友</b>
          <span>
            {snapshot.friends.length} 位
            {pendingCount > 0 ? ` · ${pendingCount} 条待处理` : ""}
          </span>
        </div>
        <button type="button" className="vx-icon-btn" onClick={onClose} aria-label="关闭">
          <X size={16} />
        </button>
      </div>

      <div className="vx-friends-tabs">
        <button
          type="button"
          className={tab === "friends" ? "vx-friends-tab-on" : ""}
          onClick={() => setTab("friends")}
        >
          好友
        </button>
        <button
          type="button"
          className={tab === "pending" ? "vx-friends-tab-on" : ""}
          onClick={() => setTab("pending")}
        >
          待处理 {pendingCount > 0 ? <b className="vx-friends-badge">{pendingCount}</b> : null}
        </button>
        {/*
          「最近一起玩」单独一个 tab（2026-10-27 业主问"在哪看"）：
          原来塞在好友列表最底部，好友一多就得滚半天，等于没有入口。
        */}
        <button
          type="button"
          className={tab === "recent" ? "vx-friends-tab-on" : ""}
          onClick={() => setTab("recent")}
        >
          最近玩 {recent.length > 0 ? <b className="vx-friends-badge-soft">{recent.length}</b> : null}
        </button>
        <button
          type="button"
          className={tab === "add" ? "vx-friends-tab-on" : ""}
          onClick={() => setTab("add")}
        >
          添加
        </button>
      </div>

      <div className="vx-friends-body">
        {/* ── 好友 ───────────────────────────────────────────── */}
        {tab === "friends" ? (
          snapshot.friends.length === 0 ? (
            <div className="vx-friends-empty">
              <EmptyArt variant="pig" />
              <b>还没有好友</b>
              <p>用 8 位 ID 搜人，或在房间里点成员加好友</p>
            </div>
          ) : (
            <>
              {feedback ? <p className="vx-friend-feedback">{feedback}</p> : null}
              {groups.map((group) => (
                <section className="vx-friends-group" key={group.key}>
                  <h4>{group.label}</h4>
                  {group.entries.map(renderFriend)}
                </section>
              ))}
            </>
          )
        ) : null}

        {/* ── 最近一起玩 ───────────────────────────────────── */}
        {tab === "recent" ? (
          recent.length === 0 ? (
            <div className="vx-friends-empty">
              <EmptyArt variant="pig" />
              <b>还没有一起玩过的人</b>
              <p>进一个房间待一会儿，同房过的人会出现在这里（只你自己看得见，保留 7 天）</p>
            </div>
          ) : (
            <>
              <p className="vx-recent-hint">
                同房过的人 · 只你自己看得见 · 保留 7 天
              </p>
              {feedback ? <p className="vx-friend-feedback">{feedback}</p> : null}
              {recent.map((play) => (
                <div className="vx-friend-row" key={play.account.id}>
                  <Avatar
                    avatar={play.account.avatar}
                    color="#b783d9"
                    name={play.account.name}
                    size={32}
                  />
                  <div className="vx-friend-main">
                    <b>{play.account.name}</b>
                    <span className="vx-friend-sub">{minutesAgo(play.at)}一起玩过</span>
                  </div>
                  <button
                    type="button"
                    className="vx-friend-act"
                    onClick={() => void addFriend(play.account)}
                  >
                    加好友
                  </button>
                </div>
              ))}
            </>
          )
        ) : null}

        {/* ── 待处理：好友请求 + 房间邀请 + 敲门 ─────────────── */}
        {tab === "pending" ? (
          pendingCount === 0 ? (
            <div className="vx-friends-empty">
              <EmptyArt variant="leaf" />
              <b>没有待处理的事</b>
              <p>别人加你、邀请你进房、请求进你的房，都会出现在这里</p>
            </div>
          ) : (
            <>
              {snapshot.incoming.length > 0 ? (
                <section className="vx-friends-section">
                  <h4>
                    好友请求 <b>{snapshot.incoming.length}</b>
                  </h4>
                  {snapshot.incoming.map((request) => (
                    <div className="vx-friend-row vx-friend-row-req" key={request.account.id}>
                      <Avatar
                        avatar={request.account.avatar}
                        color="#b783d9"
                        name={request.account.name}
                        size={34}
                      />
                      <div className="vx-friend-main">
                        <b>{request.account.name}</b>
                        <span className="vx-friend-sub">
                          {request.account.username} · {request.account.id}
                        </span>
                        {/* 附言：陌生人加你时唯一能判断"这人是谁"的线索 */}
                        {request.note ? (
                          <span className="vx-friend-note">「{request.note}」</span>
                        ) : null}
                      </div>
                      <div className="vx-friend-acts">
                        <button
                          type="button"
                          className="vx-btn vx-btn-small vx-btn-primary"
                          onClick={() => {
                            void adapter.acceptFriend(request.account.id).then(onChanged);
                          }}
                        >
                          同意
                        </button>
                        <button
                          type="button"
                          className="vx-btn vx-btn-small vx-btn-ghost"
                          onClick={() => {
                            void adapter.rejectFriend(request.account.id).then(onChanged);
                          }}
                        >
                          拒绝
                        </button>
                      </div>
                    </div>
                  ))}
                </section>
              ) : null}

              {invites.length > 0 ? (
                <section className="vx-friends-section">
                  <h4>
                    房间邀请 <b>{invites.length}</b>
                  </h4>
                  {invites.map((invite) => {
                    const hostOffline = invite.fromPresence?.state === "offline";
                    return (
                      <div className="vx-friend-row vx-friend-row-req" key={invite.from.id}>
                        <Avatar
                          avatar={invite.from.avatar}
                          color="#b783d9"
                          name={invite.from.name}
                          size={34}
                        />
                        <div className="vx-friend-main">
                          <b>{invite.from.name}</b>
                          <span className="vx-friend-sub">
                            邀请你进语音房 <i className="vx-friend-room">{invite.code}</i> ·{" "}
                            {minutesAgo(invite.at)}
                          </span>
                          {hostOffline ? (
                            // 23 小时前的邀请如果房主早走了，先标出来，别让人白点
                            <span className="vx-friend-warn">房主已离线 · 这条邀请可能已失效</span>
                          ) : invite.roomKey ? (
                            <span className="vx-friend-onepress">点「加入」直接进（带钥匙）</span>
                          ) : null}
                        </div>
                        <div className="vx-friend-acts">
                          <button
                            type="button"
                            className="vx-btn vx-btn-small vx-btn-primary"
                            onClick={() => onJoinInvite?.(invite)}
                          >
                            加入
                          </button>
                          <button
                            type="button"
                            className="vx-btn vx-btn-small vx-btn-quiet"
                            onClick={() => onDismissInvite?.(invite)}
                          >
                            忽略
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </section>
              ) : null}

              {knocks.length > 0 ? (
                <section className="vx-friends-section">
                  <h4>
                    想进你的房间 <b>{knocks.length}</b>
                  </h4>
                  {knocks.map((knock) => (
                    <div className="vx-friend-row vx-friend-row-req" key={knock.from.id}>
                      <Avatar
                        avatar={knock.from.avatar}
                        color="#b783d9"
                        name={knock.from.name}
                        size={34}
                      />
                      <div className="vx-friend-main">
                        <b>{knock.from.name}</b>
                        <span className="vx-friend-sub">{minutesAgo(knock.at)}想进你的房间</span>
                      </div>
                      <div className="vx-friend-acts">
                        <button
                          type="button"
                          className="vx-btn vx-btn-small vx-btn-primary"
                          onClick={() => onAcceptKnock?.(knock)}
                        >
                          <DoorOpen size={13} /> 放他进来
                        </button>
                        <button
                          type="button"
                          className="vx-btn vx-btn-small vx-btn-quiet"
                          onClick={() => onDismissKnock?.(knock)}
                        >
                          忽略
                        </button>
                      </div>
                    </div>
                  ))}
                </section>
              ) : null}
            </>
          )
        ) : null}

        {/* ── 添加 ───────────────────────────────────────────── */}
        {tab === "add" ? (
          <>
            <div className="vx-friends-search">
              <Search size={14} />
              <input
                value={query}
                placeholder="输入 8 位 ID 或用户名"
                onChange={(event) => {
                  setQuery(event.target.value);
                  runSearch(event.target.value);
                }}
              />
            </div>
            <input
              className="vx-friends-addnote"
              value={note}
              maxLength={30}
              placeholder="附言（可选，让对方知道你是谁）"
              onChange={(event) => setNote(event.target.value)}
            />
            {feedback ? <p className="vx-friend-feedback">{feedback}</p> : null}
            {results.map((candidate) => {
              const already = snapshot.friends.some((entry) => entry.account.id === candidate.id);
              const sent = snapshot.outgoing.some((entry) => entry.account.id === candidate.id);
              return (
                <div className="vx-friend-row" key={candidate.id}>
                  <Avatar avatar={candidate.avatar} color="#b783d9" name={candidate.name} size={32} />
                  <div className="vx-friend-main">
                    <b>{candidate.name}</b>
                    <span>
                      {candidate.username} · {candidate.id}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="vx-btn vx-btn-small vx-btn-ghost"
                    disabled={already || sent}
                    onClick={() => void addFriend(candidate)}
                  >
                    <UserPlus size={13} /> {already ? "已是好友" : sent ? "已发送" : "加好友"}
                  </button>
                </div>
              );
            })}
            {query && results.length === 0 ? <p className="vx-sheet-hint">没找到这个账号。</p> : null}
            {!query ? (
              <p className="vx-sheet-hint">
                让他把「我的资料 → 我的 ID」那串 8 位数字发给你；也可以直接输用户名。
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="vx-friends-foot">
        {roomCode && !canInvite ? (
          <span>本房由房主邀请好友，你可以用顶部「复制邀请」把房间码发给朋友</span>
        ) : (
          <span>
            {snapshot.outgoing.length > 0 ? `已发出 ${snapshot.outgoing.length} 条请求` : ""}
          </span>
        )}
      </div>

      {menuEntry
        ? (() => {
            const entry = menuEntry;
            const online = entry.presence.state === "online";
            const awayRoom = entry.presence.roomCode;
            const inOtherRoom = Boolean(awayRoom && awayRoom !== roomCode);
            const inMyRoom = Boolean(awayRoom && roomCode && awayRoom === roomCode);
            return (
              <>
                {/* 点遮罩关掉：和"点外面关闭"同一个意思，只是这里有个明确的命中区域 */}
                <div className="vx-friend-scrim" onClick={() => setRow(null)} aria-hidden />
                <div className="vx-friend-sheet" role="menu">
                  <div className="vx-friend-sheet-head">
                    <b>{nameOf(entry)}</b>
                    {/* 显示 8 位 ID：同名好友多的时候，这一个数字才是唯一能确认"没点错人"的 */}
                    <span title={`${entry.account.username} · ${entry.account.id}`}>
                      {entry.account.id}
                    </span>
                    <button
                      type="button"
                      className="vx-icon-btn"
                      aria-label="关闭"
                      onClick={() => setRow(null)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {canInvite && online && roomCode && !inOtherRoom && !inMyRoom ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setRow(null);
                        void doInvite(entry.account);
                      }}
                    >
                      <DoorOpen size={14} /> 邀请进我的房间
                    </button>
                  ) : null}
                  {inOtherRoom ? (
                    <button type="button" role="menuitem" onClick={() => void doKnock(entry.account)}>
                      <DoorOpen size={14} /> 请求进入 {awayRoom} 房
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAliasDraft(entry.alias ?? "");
                      setRow({ id: entry.account.id, kind: "alias" });
                    }}
                  >
                    <Pencil size={14} /> 设置备注名
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="vx-friend-menu-danger"
                    onClick={() => setRow({ id: entry.account.id, kind: "remove" })}
                  >
                    <Trash2 size={14} /> 移除好友
                  </button>
                </div>
              </>
            );
          })()
        : null}
    </aside>
  );
}
