import { useEffect, useState, type FormEvent } from "react";
import { Copy, Download, LogIn, Plus, Settings as SettingsIcon } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { boardEntries } from "../changelog";

import { AVATAR_COLORS, initials, type Identity } from "../identity";
import { CODE_HINT, CODE_PLACEHOLDER, JOIN_PARSE_ERROR, ROOM_CODE_LEN } from "../protocol";
import { saveIdentity } from "../identity";
import { Avatar, Toggle } from "./ui";
import { PenFrame } from "./PigPen";
import landingPigUrl from "../assets/landing-pig.gif?url";

/** 由 ID 稳定推导一个颜色：同一个房间码每次都显示同一种颜色，便于口头对号。 */
export function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

export function Mark({ seed, label, size }: { seed: string; label: string; size: number }) {
  return (
    <span
      className="vx-mark"
      style={{ width: size, height: size, background: colorForId(seed) }}
      aria-hidden
    >
      <span style={{ fontSize: size * 0.4 }}>{initials(label)}</span>
    </span>
  );
}

export function LandingView({
  identity,
  onIdentityChange,
  onCreate,
  onJoin,
  onSettings,
  onCopyId,
}: {
  identity: Identity;
  onIdentityChange: (next: Identity) => void;
  onCreate: () => void;
  onJoin: (raw: string) => boolean;
  onSettings: () => void;
  onCopyId: () => void;
}) {
  /**
   * 首页公告栏：可左右翻阅的过往更新（数据源见 ../changelog.ts，
   * 发版时只改那个文件）。默认显示最新一条。
   */
  const boardItems = boardEntries();
  const [boardIdx, setBoardIdx] = useState(0);
  const boardItem =
    boardItems.length > 0 ? boardItems[boardIdx % boardItems.length] : undefined;
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinText, setJoinText] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(identity.name);
  const viewWidth = typeof window !== "undefined" ? window.innerWidth : 1000;

  // 桌面端显示当前版本号（网页版始终是最新部署，不显示）。
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  useEffect(() => {
    if (!isDesktop) return;
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, [isDesktop]);

  // 网页版首页的"下载客户端"：先读当前部署的更新清单拿到最新安装包地址，
  // 失败则退到稳定短链 /desktop/latest.exe（发布脚本每次部署都放当前版本的副本）。
  const startDownload = async () => {
    try {
      const res = await fetch("/desktop/latest.json");
      const manifest = await res.json();
      const url = manifest?.platforms?.["windows-x86_64"]?.url;
      if (typeof url === "string" && url.startsWith("https://")) {
        window.location.href = url;
        return;
      }
    } catch {
      // 走兜底短链
    }
    window.location.href = "/desktop/latest.exe";
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const ok = onJoin(joinText);
    if (!ok) {
      setJoinError(JOIN_PARSE_ERROR);
      return;
    }
    setJoinError(null);
    setJoinOpen(false);
    setJoinText("");
  };

  const commitName = () => {
    const name = draftName.trim().slice(0, 24) || identity.name;
    onIdentityChange({ ...identity, name });
    saveIdentity({ ...identity, name });
    setEditing(false);
  };

  return (
    <div className="vx-page vx-landing">
      <PenFrame width={viewWidth} />
      <header className="vx-landing-top">
        <span className="vx-wordmark">
          <span className="vx-logo-dot" />
          5blong
          {appVersion ? <span className="vx-version-badge">v{appVersion}</span> : null}
        </span>
        <button
          type="button"
          className="vx-icon-btn"
          onClick={onSettings}
          aria-label="设置"
          title="设置"
        >
          <SettingsIcon size={18} />
        </button>
      </header>

      <main className="vx-landing-main">
        <div className="vx-landing-mascot" aria-hidden="true">
          <img src={landingPigUrl} alt="" width={512} height={512} draggable={false} />
        </div>
        <div className="vx-hero">
          <h1>开个语音房，把链接丢给朋友</h1>
          <p>免注册、免装客户端、免选服务器。音频在彼此之间点对点直连。</p>
        </div>

        <div className="vx-identity">
          <Avatar
            avatar={identity.avatar}
            color={identity.color}
            name={identity.name}
            size={44}
          />
          {editing ? (
            <input
              className="vx-name-input"
              value={draftName}
              maxLength={24}
              autoFocus
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitName();
                if (event.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="vx-identity-name"
              onClick={() => {
                setDraftName(identity.name);
                setEditing(true);
              }}
              title="点击修改昵称"
            >
              {identity.name}
            </button>
          )}
          <button type="button" className="vx-link-btn" onClick={onCopyId} title="复制个人 ID">
            ID {identity.personId}
            <Copy size={12} />
          </button>
        </div>

        <div className="vx-actions">
          <button type="button" className="vx-btn vx-btn-primary" onClick={onCreate}>
            <Plus size={18} /> 创建语音房
          </button>
          <button
            type="button"
            className="vx-btn vx-btn-ghost"
            onClick={() => {
              setJoinError(null);
              setJoinOpen(true);
            }}
          >
            <LogIn size={18} /> 加入语音房
          </button>
        </div>

        {/* 仅网页版显示：桌面端用户已在客户端内（那里显示版本徽标）。 */}
        {!isDesktop ? (
          <div className="vx-download">
            <button
              type="button"
              className="vx-btn vx-btn-ghost"
              onClick={startDownload}
              title="下载 Windows 安装包（约 7 MB，免管理员安装，带自动更新）"
            >
              <Download size={16} /> 下载 Windows 客户端
            </button>
            <p className="vx-download-note">
              <b>推荐装客户端</b>：内存与耗电更低、长时间挂机更稳更流畅，
              支持托盘常驻、快捷静音与自动更新，聊天记录和设置也不会丢。
            </p>
          </div>
        ) : null}

        <ul className="vx-facts">
          <li>建议 2–6 人，最多 8 人</li>
          <li>房主离开即结束房间</li>
          <li>少数严格网络下可能连不通</li>
        </ul>
      </main>

      {/* 公告栏挂在页面根容器（贴场景右下角），不跟着居中的主内容列走 */}
      <aside className="vx-landing-board" aria-label="最新更新">
        <div className="vx-landing-board-face">
          <b className="vx-landing-board-title">
            最新更新
            {boardItem ? <span className="vx-landing-board-ver">v{boardItem.version}</span> : null}
          </b>
          <ul>
            {(boardItem?.lines ?? ["更多内容，敬请期待"]).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {boardItems.length > 1 ? (
            <div className="vx-landing-board-nav">
              <button
                type="button"
                className="vx-board-nav-btn"
                aria-label="上一条更新"
                onClick={() =>
                  setBoardIdx((idx) => (idx + boardItems.length - 1) % boardItems.length)
                }
              >
                ‹
              </button>
              <span className="vx-board-dots" aria-hidden="true">
                {boardItems.map((item, idx) => (
                  <i
                    key={item.version}
                    className={idx === boardIdx ? "vx-board-dot-on" : ""}
                    onClick={() => setBoardIdx(idx)}
                  />
                ))}
              </span>
              <button
                type="button"
                className="vx-board-nav-btn"
                aria-label="下一条更新"
                onClick={() => setBoardIdx((idx) => (idx + 1) % boardItems.length)}
              >
                ›
              </button>
            </div>
          ) : null}
        </div>
        <span className="vx-landing-board-post vx-landing-board-post-l" aria-hidden="true" />
        <span className="vx-landing-board-post vx-landing-board-post-r" aria-hidden="true" />
      </aside>

      {joinOpen ? (
        <div className="vx-modal-backdrop" onClick={() => setJoinOpen(false)}>
          <form className="vx-modal" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
            <h2>加入语音房</h2>
            <p className="vx-modal-sub">粘贴房主发的邀请链接最稳妥，也可以只输{CODE_HINT}</p>
            <input
              className="vx-input"
              value={joinText}
              autoFocus
              spellCheck={false}
              placeholder={CODE_PLACEHOLDER}
              onChange={(event) => {
                setJoinText(event.target.value);
                setJoinError(null);
              }}
            />
            {joinError ? <p className="vx-field-error">{joinError}</p> : null}
            <p className="vx-modal-hint">
              只输{ROOM_CODE_LEN}位房间码也能直接进房；想更私密就让房主发邀请链接。
            </p>
            <div className="vx-modal-actions">
              <button type="button" className="vx-btn vx-btn-quiet" onClick={() => setJoinOpen(false)}>
                取消
              </button>
              <button type="submit" className="vx-btn vx-btn-primary">
                加入
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

export function ConfirmView({
  code,
  hostId,
  identity,
  joining,
  error,
  onJoin,
  onCancel,
  onSettings,
}: {
  code: string;
  hostId: string;
  identity: Identity;
  joining: boolean;
  error: string | null;
  onJoin: (muted: boolean) => void;
  onCancel: () => void;
  onSettings: () => void;
}) {
  const [muted, setMuted] = useState(true);

  return (
    <div className="vx-page vx-confirm">
      <div className="vx-confirm-card">
        <Mark seed={hostId} label={code} size={56} />
        <h1>有人邀请你进语音房</h1>
        <p className="vx-confirm-code">
          房间码 <strong>{code}</strong>
        </p>
        <p className="vx-confirm-sub">
          你将以 <strong>{identity.name}</strong> 的身份加入
        </p>

        <label className="vx-confirm-toggle">
          <span>
            <strong>先静音进入</strong>
            <small>进去以后再开麦，避免一进房就被听到</small>
          </span>
          <Toggle checked={muted} onChange={setMuted} label="先静音进入" />
        </label>

        {error ? <p className="vx-field-error">{error}</p> : null}

        <div className="vx-confirm-actions">
          <button
            type="button"
            className="vx-btn vx-btn-primary vx-btn-wide"
            disabled={joining}
            onClick={() => onJoin(muted)}
          >
            {joining ? "正在进入…" : muted ? "静音加入" : "加入并开麦"}
          </button>
          <button type="button" className="vx-btn vx-btn-quiet" onClick={onCancel}>
            暂不加入
          </button>
        </div>

        <button type="button" className="vx-link-btn" onClick={onSettings}>
          先调整麦克风 / 昵称
        </button>
      </div>
    </div>
  );
}
