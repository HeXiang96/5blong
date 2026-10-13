import { useState, type FormEvent } from "react";
import { Copy, LogIn, Plus, Settings as SettingsIcon } from "lucide-react";

import { AVATAR_COLORS, initials, type Identity } from "../identity";
import { CODE_HINT, CODE_PLACEHOLDER, JOIN_PARSE_ERROR, ROOM_CODE_LEN } from "../protocol";
import { saveIdentity } from "../identity";
import { Avatar, Toggle } from "./ui";
import { PenFrame } from "./PigPen";
import { Pig } from "./Pig";

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
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinText, setJoinText] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(identity.name);
  const viewWidth = typeof window !== "undefined" ? window.innerWidth : 1000;

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
          <Pig color={identity.color} pose="front" uid="landing" />
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

        <ul className="vx-facts">
          <li>建议 2–6 人，最多 8 人</li>
          <li>房主离开即结束房间</li>
          <li>少数严格网络下可能连不通</li>
        </ul>
      </main>

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
