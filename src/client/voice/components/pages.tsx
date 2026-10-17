import { useEffect, useState, type FormEvent } from "react";
import { Copy, Download, History, LogIn, Plus, Settings as SettingsIcon } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { boardEntries } from "../changelog";
import type { LastRoom, SessionSummary } from "../session-stats";

import { AVATAR_COLORS, initials, type Identity } from "../identity";
import { CODE_HINT, CODE_PLACEHOLDER, JOIN_PARSE_ERROR, JOIN_WAIT_HINT, ROOM_CODE_LEN } from "../protocol";
import { saveIdentity } from "../identity";
import { Avatar, Spinner, Toggle } from "./ui";
import { PenFrame } from "./PigPen";
import { HealthCheck } from "./HealthCheck";
import type { VoiceSettings } from "../settings";
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
  joining = false,
  retrying = false,
  error = null,
  onCancelJoin,
  onDismissError,
  lastRoom = null,
  onCreateGame,
  onJoinGame,
}: {
  identity: Identity;
  onIdentityChange: (next: Identity) => void;
  onCreate: () => void;
  onJoin: (raw: string) => boolean;
  onSettings: () => void;
  onCopyId: () => void;
  /** 已提交进房、正在连接（含超时后的自动重拨）。 */
  joining?: boolean;
  /** 处于自动重拨阶段（换新线路重试），文案要说清"还在努力"。 */
  retrying?: boolean;
  /** 引擎算出来的真实失败原因。**必须显示**，否则进房失败完全静默。 */
  error?: string | null;
  onCancelJoin?: () => void;
  onDismissError?: () => void;
  /** 上次房间（本机记忆；null = 没有或不展示）。 */
  lastRoom?: LastRoom | null;
  /** 开黑圈：创建（需要创建码）/ 加入（输房间码）。 */
  onCreateGame: () => void;
  onJoinGame: () => void;
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
  /** 开黑圈预告弹窗。 */
  const [teaseOpen, setTeaseOpen] = useState(false);
  const [joinText, setJoinText] = useState("");
  /**
   * 只负责"输入格式对不对"。进房失败的**真实原因**由引擎给出（`error` prop）——
   * 以前这里只有一份组件内 state，首页没接引擎的 `joinError`，于是输房间码
   * 进不去时一个字都不显示：弹窗一关就什么都没有（实测就是这个现象）。
   */
  const [parseError, setParseError] = useState<string | null>(null);
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
    // 上一次的失败原因先清掉，避免它盖住这一次的结果。
    onDismissError?.();
    const ok = onJoin(joinText);
    if (!ok) {
      setParseError(JOIN_PARSE_ERROR);
      return;
    }
    /*
     * 格式没问题 → 交棒给引擎。这里**只关弹窗、不清输入**：
     * 进房成不成要等引擎回报（可能是几秒，也可能要重拨半分钟），
     * 首页上那两条（进行中 / 失败原因）由 props 驱动；
     * 输入留着，失败后用户点一下就能重试。
     */
    setParseError(null);
    setJoinOpen(false);
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
          {/*
            进房中禁用这两个按钮：重复点"加入"会再跑一次 joinRoom，
            把 welcome 超时重置掉（等于自己把进房越拖越久）。
          */}
          {lastRoom && !joining ? (
            <button
              type="button"
              className="vx-btn vx-btn-ghost vx-last-room"
              onClick={() => {
                setParseError(null);
                onDismissError?.();
                onJoin(lastRoom.code);
              }}
              title="回到你上次的房间（房主在线才能进）"
            >
              <History size={18} /> 上次房间 {lastRoom.code} · 一键重进
            </button>
          ) : null}
          <button
            type="button"
            className="vx-btn vx-btn-primary"
            disabled={joining}
            onClick={onCreate}
          >
            <Plus size={18} /> 创建语音房
          </button>
          <button
            type="button"
            className="vx-btn vx-btn-ghost"
            disabled={joining}
            onClick={() => {
              setParseError(null);
              onDismissError?.();
              setJoinOpen(true);
            }}
          >
            <LogIn size={18} /> 加入语音房
          </button>
        </div>

        {/*
          开黑圈入口：与语音房**明确分区**（业主反馈"三个按钮没用过软件的会搞混"）。
          文案直接说清"打游戏的用这个"，创建/加入两个动作直接摆出来，不用再进一层。
        */}
        <div className="vx-game-entry">
          <div className="vx-game-entry-text">
            <strong>🎮 开黑圈 · 5v5 分队内战房</strong>
            <span>要分进攻/防守两队、队内语音互相隔离的内战用这个；平时连麦聊天，上面的「语音房」就够了</span>
            <button type="button" className="vx-link-btn vx-game-entry-what" onClick={() => setTeaseOpen(true)}>
              这是什么？
            </button>
          </div>
          <div className="vx-game-entry-actions">
            <button type="button" className="vx-btn vx-btn-small vx-btn-primary" onClick={onCreateGame}>
              创建开黑圈
            </button>
            <button type="button" className="vx-btn vx-btn-small vx-btn-ghost" onClick={onJoinGame}>
              加入开黑圈
            </button>
          </div>
        </div>

        {teaseOpen ? (
          <div className="vx-modal-backdrop" onClick={() => setTeaseOpen(false)}>
            <div className="vx-modal" onClick={(event) => event.stopPropagation()}>
              <h2>🎮 开黑圈</h2>
              <p className="vx-modal-sub">5v5 自定义内战房 · 一个房间码拉满两队</p>
              <p className="vx-modal-body">
                专为无畏契约、CS2 这类游戏自定义设计：进游戏分好边，回来点一下自己的边，
                <strong>队内语音自动隔离</strong>——对面听不到你们，你们也听不到对面。
                待分队可以听全房（当裁判用）。
              </p>
              <p className="vx-modal-hint">
                创建需要创建码（找管理员开通）；加入直接输入 4 位房间码。
              </p>
              <div className="vx-modal-actions">
                <button type="button" className="vx-btn vx-btn-primary" onClick={() => setTeaseOpen(false)}>
                  知道了
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/*
          进房的"进行中"与"失败原因"。这两条就是以前缺的那块：
          输房间码是直接进房的（不经过确认页），失败原因以前没有任何组件渲染，
          所以表现成"点完没反应、也没提示"。
        */}
        {joining ? (
          <div className="vx-landing-note vx-landing-note-busy" role="status">
            <Spinner size={15} />
            <span className="vx-landing-note-text">
              <b>{retrying ? "连接不畅，正在自动换线路重试…" : "正在进入房间…"}</b>
              <small>{JOIN_WAIT_HINT}</small>
            </span>
            {onCancelJoin ? (
              <button type="button" className="vx-link-btn" onClick={onCancelJoin}>
                取消
              </button>
            ) : null}
          </div>
        ) : null}

        {!joining && error ? (
          <div className="vx-landing-note vx-landing-note-error" role="alert">
            <span className="vx-landing-note-text">
              <b>没能进入房间</b>
              <small>{error}</small>
            </span>
            {/* 手输房间码失败时给一个「再试一次」：网络抖动重试一次往往就通
                （引擎侧信令瞬时失败还会自动换连接重试 3 次） */}
            {joinText.trim() ? (
              <button
                type="button"
                className="vx-link-btn vx-link-btn-strong"
                onClick={() => {
                  onDismissError?.();
                  void onJoin(joinText);
                }}
              >
                再试一次
              </button>
            ) : null}
            {onDismissError ? (
              <button type="button" className="vx-link-btn" onClick={onDismissError}>
                知道了
              </button>
            ) : null}
          </div>
        ) : null}

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
              <b>推荐装客户端</b>：共享屏幕更清晰流畅——浏览器会把切到后台的
              标签页降帧（系统级限制，网页端无解），客户端走系统采集不受限；
              另有内存耗电更低、托盘常驻、快捷静音与自动更新，聊天记录和设置也不会丢。
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
                setParseError(null);
                onDismissError?.();
              }}
            />
            {parseError ? <p className="vx-field-error">{parseError}</p> : null}
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
  settings,
}: {
  code: string;
  hostId: string;
  identity: Identity;
  joining: boolean;
  error: string | null;
  onJoin: (muted: boolean) => void;
  onCancel: () => void;
  onSettings: () => void;
  /** 交给"一键体检"用（麦克风采集约束）。 */
  settings: VoiceSettings;
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

        {/* 等待期最长可达 ~36 秒（12s 超时 × 3 次拨号）：说清在等、别重复点。 */}
        {joining ? (
          <p className="vx-confirm-wait">
            <Spinner size={14} />
            <span>{JOIN_WAIT_HINT}</span>
          </p>
        ) : null}

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

        <div className="vx-confirm-tools">
          <HealthCheck settings={settings} triggerLabel="先检查设备" triggerClass="vx-link-btn" />
          <button type="button" className="vx-link-btn" onClick={onSettings}>
            先调整麦克风 / 昵称
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 今晚小结

function fmtDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec} 秒`;
  return sec === 0 ? `${min} 分钟` : `${min} 分 ${sec} 秒`;
}

function fmtSpoken(seconds: number): string {
  return seconds >= 60 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`;
}

/**
 * 房间结束后的"今晚小结"卡片。
 * 数据来自本机 10 秒粒度的采样（session-stats.ts），只有时长/人次这类统计，
 * 没有任何内容；谁说了多久房内本来就互相可见，趣味榜只是把它变得好看了点。
 */
export function SessionSummaryCard({
  summary,
  onClose,
}: {
  summary: SessionSummary;
  onClose: () => void;
}) {
  const top = summary.speakers[0];
  const quiet = summary.speakers.length >= 2 ? summary.speakers[summary.speakers.length - 1] : undefined;
  const showTop = top && top.seconds >= 10;
  const showQuiet = quiet && showTop && quiet.id !== top?.id;
  return (
    <div className="vx-overlay vx-summary-overlay" onClick={onClose}>
      <div className="vx-overlay-card vx-summary-card" onClick={(event) => event.stopPropagation()}>
        <b className="vx-summary-title">🌙 今晚小结</b>
        <p className="vx-summary-line">
          聊了 {fmtDuration(summary.endedAt - summary.startedAt)} · 最多 {summary.peakMembers}{" "}
          人同圈 · 进出 {summary.totalJoins} 人次
        </p>
        {showTop ? (
          <p className="vx-summary-line vx-summary-fun">
            🏆 话痨王：<strong>{top.name}</strong>（说了 {fmtSpoken(top.seconds)}）
          </p>
        ) : null}
        {showQuiet ? (
          <p className="vx-summary-line vx-summary-fun">
            🤫 最安静：<strong>{quiet.name}</strong>（只说了 {fmtSpoken(quiet.seconds)}）
          </p>
        ) : null}
        {summary.peakMembers <= 1 ? (
          <p className="vx-summary-line vx-summary-fun">🌱 下次多喊几个朋友来，更热闹</p>
        ) : null}
        <button type="button" className="vx-btn vx-btn-primary vx-btn-wide" onClick={onClose}>
          回到首页
        </button>
      </div>
    </div>
  );
}
