/**
 * 账号面板（登录/注册 + 我的资料）与好友抽屉。
 *
 * 视觉沿用首页那套「纸面 + 木框」，不引入白底卡片——见 styles.css 里的
 * .vx-sheet / .vx-sheet-* 类。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, LogOut, Search, UserPlus, X } from "lucide-react";

import landingPigUrl from "../assets/landing-pig.webp?url";

import { Avatar } from "./ui";
import type { AccountAdapter, AccountError, AccountProfile, FriendsSnapshot } from "../account/types";
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

interface FriendsDrawerProps {
  open: boolean;
  adapter: AccountAdapter;
  snapshot: FriendsSnapshot;
  onClose: () => void;
  onChanged: () => void;
  /** 当前所在房间（用于显示"在 2354 房"） */
  roomCode?: string | null;
  onInvite?: (account: AccountProfile) => void;
}

export function FriendsDrawer({
  open,
  adapter,
  snapshot,
  onClose,
  onChanged,
  roomCode,
  onInvite,
}: FriendsDrawerProps) {
  const [tab, setTab] = useState<"friends" | "requests" | "add">("friends");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AccountProfile[]>([]);
  const [note, setNote] = useState("");
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
      return;
    }
    // popover 语义：点卡片外面关闭；点在卡片内或好友按钮上不关
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".vx-friends")) return;
      if (target.closest(".vx-friends-btn")) return;
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

  if (!open) return null;

  const pending = snapshot.incoming.length;
  const friendIds = new Set(snapshot.friends.map((entry) => entry.account.id));

  return (
    <aside className="vx-friends" aria-label="好友">
      <div className="vx-friends-head">
        <div className="vx-friends-title">
          <b>好友</b>
          <span>{snapshot.friends.length} 位</span>
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
          className={tab === "requests" ? "vx-friends-tab-on" : ""}
          onClick={() => setTab("requests")}
        >
          请求 {pending > 0 ? <b className="vx-friends-badge">{pending}</b> : null}
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
        {tab === "friends" ? (
          snapshot.friends.length === 0 ? (
            <div className="vx-friends-empty">
              <EmptyArt variant="pig" />
              <b>还没有好友</b>
              <p>用 8 位 ID 搜人，或在房间里点成员加好友</p>
            </div>
          ) : (
            snapshot.friends.map((entry) => {
              const online = entry.presence.state === "online";
              const inOtherRoom = Boolean(
                entry.presence.roomCode && entry.presence.roomCode !== roomCode,
              );
              return (
                <div className="vx-friend-row" key={entry.account.id}>
                  <span className={`vx-friend-dot${online ? " vx-friend-dot-on" : ""}`} aria-hidden />
                  <Avatar
                    avatar={entry.account.avatar}
                    color="#b783d9"
                    name={entry.account.name}
                    size={34}
                  />
                  <div className="vx-friend-main">
                    <b>{entry.account.name}</b>
                    <span className="vx-friend-sub">
                      {online ? (
                        inOtherRoom ? (
                          <>
                            在 <i className="vx-friend-room">{entry.presence.roomCode}</i> 房间
                          </>
                        ) : (
                          "在线"
                        )
                      ) : (
                        "离线"
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="vx-friend-act"
                    disabled={!online || inOtherRoom || !roomCode}
                    title={
                      inOtherRoom
                        ? "对方在别的房间里"
                        : roomCode
                          ? "把对方请进我的房间"
                          : "先建一个房间，才能邀请"
                    }
                    onClick={() => onInvite?.(entry.account)}
                  >
                    邀请
                  </button>
                </div>
              );
            })
          )
        ) : null}

        {tab === "requests" ? (
          snapshot.incoming.length === 0 ? (
            <div className="vx-friends-empty">
              <EmptyArt variant="leaf" />
              <b>没有待处理的请求</b>
              <p>别人加你时会出现在这里</p>
            </div>
          ) : (
            snapshot.incoming.map((request) => (
              <div className="vx-friend-row vx-friend-row-req" key={request.account.id}>
                <Avatar avatar={request.account.avatar} color="#b783d9" name={request.account.name} size={34} />
                <div className="vx-friend-main">
                  <b>{request.account.name}</b>
                  <span className="vx-friend-sub">
                    {request.account.username} · {request.account.id}
                  </span>
                </div>
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
            ))
          )
        ) : null}

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
            {note ? <p className="vx-sheet-hint">{note}</p> : null}
            {results.map((candidate) => {
              const already = friendIds.has(candidate.id);
              return (
                <div className="vx-friend-row" key={candidate.id}>
                  <Avatar avatar={candidate.avatar} color="#b783d9" name={candidate.name} size={32} />
                  <div className="vx-friend-main">
                    <b>{candidate.name}</b>
                    <span>{candidate.username} · {candidate.id}</span>
                  </div>
                  <button
                    type="button"
                    className="vx-btn vx-btn-small vx-btn-ghost"
                    disabled={already}
                    onClick={() => {
                      void adapter.addFriend(candidate.id).then((result) => {
                        setNote(
                          result.error
                            ? ACCOUNT_ERROR_TEXT[result.error]
                            : "已发送请求，等对方同意",
                        );
                        onChanged();
                      });
                    }}
                  >
                    <UserPlus size={13} /> {already ? "已是好友" : "加好友"}
                  </button>
                </div>
              );
            })}
            {query && results.length === 0 ? <p className="vx-sheet-hint">没找到这个账号。</p> : null}
          </>
        ) : null}
      </div>

      <div className="vx-friends-foot">
        <span>{snapshot.outgoing.length > 0 ? `已发出 ${snapshot.outgoing.length} 条请求` : ""}</span>
      </div>
    </aside>
  );
}
