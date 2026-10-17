/**
 * 开黑圈界面：创建/加入弹窗、三栏编制板、记分、使用教程。
 *
 * UI 适配要求（业主强调）：
 * - 全部走 --vx-* 主题变量，浅色/深色自动成立；
 * - 场景是专门的"电竞主题"（game-theme.css），随四时段变色；
 * - 教程弹窗同样只用主题变量，不吃写死颜色。
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Crown, Mic, MicOff, Sparkles, Users, Volume2 } from "lucide-react";

import {
  GAME_ENABLED_LIMIT,
  TEAM_LABEL,
  type GameMember,
  type GameRoomInfo,
  type GameScores,
  type Team,
} from "./game-types";
import { activateEntitlement, loadEntitlement, markTutorialSeen, tutorialSeen, type GameEntitlement } from "./use-game";

const TEAM_ORDER: Team[] = ["attack", "unassigned", "defend"];

// ---------------------------------------------------------------- 创建弹窗

export function GameCreateDialog({
  onCancel,
  onCreate,
  busy,
  error,
}: {
  onCancel: () => void;
  onCreate: (opts: { gameId: string; title: string; map: string; muted: boolean }) => void;
  busy: boolean;
  /** 建房失败的显示位置就在弹窗里（以前错误只在状态里、界面没提示）。 */
  error: string | null;
}) {
  const [title, setTitle] = useState("无畏契约");
  const [map, setMap] = useState("");
  const [gameId, setGameId] = useState("");
  const [muted, setMuted] = useState(false);
  const [entitlement, setEntitlement] = useState<GameEntitlement | null>(() => loadEntitlement());
  const [code, setCode] = useState("");
  const [activating, setActivating] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  /*
   * 创建码被吊销/用尽时：建房被拒 → 错误显示的同时本地权限已被清除，
   * 这里同步刷新状态，让"输入创建码"的激活框重新出现，直接填新码就行。
   */
  useEffect(() => {
    if (error) setEntitlement(loadEntitlement());
  }, [error]);

  const activate = async () => {
    setCodeError(null);
    setActivating(true);
    try {
      const value = await activateEntitlement(code);
      setEntitlement(value);
    } catch (error) {
      setCodeError(error instanceof Error ? error.message : "校验失败");
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="vx-modal-backdrop">
      <div className="vx-modal vx-game-modal">
        <h2>🎮 创建开黑圈</h2>
        <p className="vx-modal-sub">5v5 内战房：一个房间码拉满两队，队内语音自动隔离</p>
        <div className="vx-game-teams-preview">
          <span className="tp-attack">🟠 进攻方 × 5</span>
          <span className="tp-defend">🔵 防守方 × 5</span>
        </div>

        <label className="vx-field">
          <span className="vx-field-label">你的游戏 ID（必填，和游戏里一致）</span>
          <input
            className="vx-input"
            value={gameId}
            maxLength={16}
            placeholder="例如：夜里看江南#8294"
            onChange={(event) => setGameId(event.target.value)}
          />
        </label>

        <div className="vx-game-row">
          <label className="vx-field">
            <span className="vx-field-label">游戏</span>
            <input className="vx-input" value={title} maxLength={16} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="vx-field">
            <span className="vx-field-label">地图（可选）</span>
            <input className="vx-input" value={map} maxLength={16} placeholder="亚海悬城" onChange={(event) => setMap(event.target.value)} />
          </label>
        </div>

        <label className="vx-game-check">
          <input type="checkbox" checked={muted} onChange={(event) => setMuted(event.target.checked)} />
          <span>先静音进房</span>
        </label>

        {error ? <div className="vx-game-error-bar">{error}</div> : null}

        {!entitlement ? (
          <div className="vx-game-entitle">
            <p className="vx-modal-hint">创建开黑圈需要创建码（找管理员开通）</p>
            <div className="vx-game-row">
              <input className="vx-input" value={code} placeholder="BLONG-XXXX" onChange={(event) => setCode(event.target.value)} />
              <button type="button" className="vx-btn vx-btn-ghost" style={{ minWidth: 74 }} disabled={activating || !code.trim()} onClick={() => void activate()}>
                {activating ? "校验中…" : "激活"}
              </button>
            </div>
            {codeError ? <p className="vx-game-error">{codeError}</p> : null}
          </div>
        ) : (
          <p className="vx-modal-hint">已具备创建权限（有效期至 {new Date(entitlement.expiresAt).toLocaleDateString("zh-CN")}）</p>
        )}

        <div className="vx-modal-actions">
          <button type="button" className="vx-btn vx-btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="vx-btn vx-btn-primary"
            disabled={busy || !gameId.trim() || !entitlement}
            onClick={() => onCreate({ gameId, title, map, muted })}
          >
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 加入弹窗

export function GameJoinDialog({
  code,
  onCancel,
  onJoin,
  busy,
  error,
}: {
  /** 已知的房间码（链接带 ?g= 时）；null = 让用户在弹窗里填。 */
  code: string | null;
  onCancel: () => void;
  onJoin: (opts: { code: string; gameId: string; muted: boolean }) => void;
  busy: boolean;
  error: string | null;
}) {
  const [roomCode, setRoomCode] = useState(code ?? "");
  const [gameId, setGameId] = useState("");
  const [muted, setMuted] = useState(false);
  const ready = /^[0-9]{4}$/.test(roomCode.trim()) && gameId.trim().length > 0;
  return (
    <div className="vx-modal-backdrop">
      <div className="vx-modal vx-game-modal">
        <h2>🎮 加入开黑圈</h2>
        <p className="vx-modal-sub">
          {code ? `房间 ${code} · ` : ""}进房后先当待分队，游戏里分好边再认领（进攻 / 防守）
        </p>
        {!code ? (
          <label className="vx-field">
            <span className="vx-field-label">开黑圈房间码（4 位数字）</span>
            <input
              className="vx-input"
              value={roomCode}
              inputMode="numeric"
              maxLength={4}
              placeholder="例如：8294"
              onChange={(event) => setRoomCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
            />
          </label>
        ) : null}
        <label className="vx-field">
          <span className="vx-field-label">你的游戏 ID（必填，和游戏里一致）</span>
          <input
            className="vx-input"
            value={gameId}
            maxLength={16}
            placeholder="例如：夜里看江南#8294"
            onChange={(event) => setGameId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready) onJoin({ code: roomCode.trim(), gameId, muted });
            }}
          />
        </label>
        <label className="vx-game-check">
          <input type="checkbox" checked={muted} onChange={(event) => setMuted(event.target.checked)} />
          <span>先静音进房</span>
        </label>
        {error ? <p className="vx-game-error">{error}</p> : null}
        <div className="vx-modal-actions">
          <button type="button" className="vx-btn vx-btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="vx-btn vx-btn-primary" disabled={busy || !ready} onClick={() => onJoin({ code: roomCode.trim(), gameId, muted })}>
            {busy ? "加入中…" : "进圈"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 使用教程

export function GameTutorial({ onClose }: { onClose: () => void }) {
  const steps = [
    { emoji: "🎮", title: "先填游戏 ID", text: "加入/创建时要求的游戏 ID 必须和游戏里一致，队友才认得你。" },
    { emoji: "🧩", title: "进房先当待分队", text: "所有人先落在「待分队」，能听见全房说话——相当于游戏还没开打。" },
    { emoji: "🎯", title: "游戏里分好边，回来点一下", text: "游戏里你是进攻方，就点「我在进攻方」；防守方同理。点完立刻只听本队。" },
    { emoji: "🔒", title: "队伍之间互不相通", text: "两队之间、队伍与待分队之间互相听不到，不会串麦；想听某队只能加入那队。" },
    { emoji: "🏆", title: "房主记分", text: "房主可以在顶部记分，一局结束点「清零比分」开下一局；编制不受影响。" },
    { emoji: "🔊", title: "音量与降噪", text: "点成员卡调某个人的音量（0~200%，本机记住）；底部拉「增强」救小嗓门；AI降噪默认开。" },
  ];
  return (
    <div className="vx-modal-backdrop" onClick={onClose}>
      <div className="vx-modal vx-game-modal vx-game-tutorial" onClick={(event) => event.stopPropagation()}>
        <h2>🎮 开黑圈怎么玩</h2>
        <p className="vx-modal-sub">30 秒看完，第一次用不迷路</p>
        <ol className="vx-game-steps">
          {steps.map((step) => (
            <li key={step.title}>
              <span className="vx-game-step-emoji">{step.emoji}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="vx-modal-actions">
          <button type="button" className="vx-btn vx-btn-primary" onClick={onClose}>
            开始开黑
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 房间视图

export function GameRoomView({
  room,
  members,
  scores,
  unlocked,
  muted,
  isHost,
  myTeam,
  error,
  onToggleMute,
  onClaim,
  onAssign,
  onKick,
  onScore,
  onResetScores,
  onToggleCap,
  onCopyInvite,
  onLeave,
  micBoost,
  onSetMicBoost,
  nsOn,
  onToggleNs,
  peerVolumes,
  onSetPeerVolume,
}: {
  room: GameRoomInfo;
  members: GameMember[];
  scores: GameScores;
  unlocked: boolean;
  muted: boolean;
  isHost: boolean;
  myTeam: Team;
  error: string | null;
  onToggleMute: () => void;
  onClaim: (team: Team) => void;
  onAssign: (peerId: string, team: Team) => void;
  onKick: (peerId: string) => void;
  onScore: (side: "attack" | "defend", delta: number) => void;
  onResetScores: () => void;
  onToggleCap: () => void;
  onCopyInvite: () => void;
  onLeave: () => void;
  /** 麦克风增强（1~4）。 */
  micBoost: number;
  onSetMicBoost: (value: number) => void;
  /** AI 强降噪开关。 */
  nsOn: boolean;
  onToggleNs: () => void;
  /** 对某游戏 ID 的接收音量（0~2）。 */
  peerVolumes: Record<string, number>;
  onSetPeerVolume: (gameId: string, volume: number) => void;
}) {
  const [manageId, setManageId] = useState<string | null>(null);
  /** 点成员卡弹出的"对方音量"弹层（按成员 id）。 */
  const [volId, setVolId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showTutorial, setShowTutorial] = useState(() => !tutorialSeen());

  const groups = useMemo(
    () =>
      TEAM_ORDER.map((team) => ({
        team,
        members: members.filter((member) => member.team === team),
      })),
    [members],
  );

  const closeTutorial = () => {
    markTutorialSeen();
    setShowTutorial(false);
  };

  useEffect(() => {
    if (!manageId && !volId) return;
    const close = () => {
      setManageId(null);
      setVolId(null);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [manageId, volId]);

  return (
    <div className="vx-game-root">
      <header className="vx-game-head">
        <span className="vx-game-badge">🎮 开黑圈</span>
        <strong>{room.title || "自定义内战"}</strong>
        {room.map ? <span className="vx-game-map">{room.map}</span> : null}
        <span className="vx-game-code">房间 {room.code}</span>
        <button
          type="button"
          className="vx-btn vx-btn-small vx-btn-primary"
          onClick={() => {
            onCopyInvite();
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? "已复制邀请" : "复制邀请"}
        </button>
        <span className="vx-game-count">
          <Users size={14} /> {members.length}/{GAME_ENABLED_LIMIT}
        </span>
        <button type="button" className="vx-icon-btn" title="使用教程" onClick={() => setShowTutorial(true)}>
          <Sparkles size={16} />
        </button>
      </header>

      <div className="vx-game-scorebar">
        <span className="vx-game-score-side vx-game-attack">进攻 {scores.attack}</span>
        <span className="vx-game-score-sep">:</span>
        <span className="vx-game-score-side vx-game-defend">{scores.defend} 防守</span>
        {isHost ? (
          <span className="vx-game-score-actions">
            <button type="button" className="vx-game-mini" onClick={() => onScore("attack", 1)}>
              进攻 +1
            </button>
            <button type="button" className="vx-game-mini" onClick={() => onScore("defend", 1)}>
              防守 +1
            </button>
            <button type="button" className="vx-game-mini" onClick={() => onScore("attack", -1)}>
              进攻 −1
            </button>
            <button type="button" className="vx-game-mini" onClick={() => onScore("defend", -1)}>
              防守 −1
            </button>
            <button type="button" className="vx-game-mini" onClick={onResetScores}>
              清零
            </button>
          </span>
        ) : null}
      </div>

      {error ? <div className="vx-game-error-bar">{error}</div> : null}

      <div className="vx-game-board">
        {groups.map((group) => {
          const isMine = myTeam === group.team;
          return (
            <section
              key={group.team}
              className={`vx-game-lane vx-game-lane-${group.team}${isMine ? " vx-game-lane-mine" : ""}`}
            >
              <header className="vx-game-lane-head">
                <span className="vx-game-lane-name">
                  {group.team === "attack" ? "🟠 进攻方" : group.team === "defend" ? "🔵 防守方" : "🐷 待分队"}
                </span>
                <span className="vx-game-lane-count">
                  {group.members.length}
                  {group.team !== "unassigned" ? `/${unlocked ? 8 : 5}` : ""}
                </span>
                {isMine ? <span className="vx-game-lane-here">你在这里</span> : null}
              </header>
              <div className="vx-game-lane-list">
                {group.members.length === 0 && group.team === "unassigned" ? (
                  <p className="vx-game-lane-empty">都认领了，这里空了</p>
                ) : null}
                {group.members.map((member) => (
                  <article
                    key={member.id}
                    className={`vx-game-card${member.local ? " vx-game-card-me" : ""}${volId === member.id ? " vx-game-card-open" : ""}`}
                    onClick={() => {
                      if (member.local) return;
                      setVolId((current) => (current === member.id ? null : member.id));
                    }}
                    style={{ cursor: member.local ? "default" : "pointer" }}
                  >
                    <span className="vx-game-avatar" aria-hidden="true">
                      {member.gameId.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="vx-game-name" title={member.gameId}>
                      {member.gameId}
                    </span>
                    {member.isHost ? (
                      <span className="vx-game-crown" title="房主">
                        <Crown size={12} />
                      </span>
                    ) : null}
                    {member.muted ? (
                      <span className="vx-game-mic-off" title="已静音">
                        <MicOff size={12} />
                      </span>
                    ) : (
                      <span className="vx-game-mic-on" title="麦克风开启">
                        <Mic size={12} />
                      </span>
                    )}
                    {!member.local ? (
                      <button
                        type="button"
                        className="vx-game-volbtn"
                        title={`调 ${member.gameId} 的音量（只影响你自己）`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setVolId((current) => (current === member.id ? null : member.id));
                        }}
                      >
                        <Volume2 size={13} />
                        <span>{Math.round((peerVolumes[member.gameId] ?? 1) * 100)}%</span>
                      </button>
                    ) : null}
                    {volId === member.id ? (
                      <span className="vx-game-menu vx-game-volmenu" onClick={(event) => event.stopPropagation()}>
                        <span className="vx-game-vol-label">
                          {member.gameId} 的音量{" "}
                          <b>{Math.round((peerVolumes[member.gameId] ?? 1) * 100)}%</b>
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={2}
                          step={0.05}
                          value={peerVolumes[member.gameId] ?? 1}
                          onChange={(event) => onSetPeerVolume(member.gameId, Number(event.target.value))}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            onSetPeerVolume(member.gameId, 1);
                          }}
                        >
                          恢复 100%
                        </button>
                      </span>
                    ) : null}
                    {isHost && !member.local ? (
                      <button
                        type="button"
                        className="vx-game-manage"
                        title="调整这个人的队伍"
                        onClick={(event) => {
                          event.stopPropagation();
                          setManageId((current) => (current === member.id ? null : member.id));
                        }}
                      >
                        ⋯
                      </button>
                    ) : null}
                    {manageId === member.id ? (
                      <span className="vx-game-menu" onClick={(event) => event.stopPropagation()}>
                        {(["attack", "defend", "unassigned"] as Team[]).map((team) => (
                          <button
                            key={team}
                            type="button"
                            onClick={() => {
                              onAssign(member.id, team);
                              setManageId(null);
                            }}
                          >
                            → {TEAM_LABEL[team]}
                          </button>
                        ))}
                        <button type="button" className="vx-game-menu-danger" onClick={() => onKick(member.id)}>
                          移出开黑圈
                        </button>
                      </span>
                    ) : null}
                  </article>
                ))}
                {/* 空位占位：把版面撑起来（业主嫌三栏太空），也直观看到还差几个人 */}
                {group.team !== "unassigned"
                  ? Array.from({ length: Math.max(0, (unlocked ? 8 : 5) - group.members.length) }).map((_, index) => (
                      <div key={`slot-${index}`} className="vx-game-slot" aria-hidden="true">
                        <span className="vx-game-slot-ring" />
                        <span>虚位以待</span>
                      </div>
                    ))
                  : null}
              </div>
              {group.team !== "unassigned" && !isMine ? (
                <button type="button" className="vx-game-claim" onClick={() => onClaim(group.team)}>
                  🎯 我在{TEAM_LABEL[group.team]}
                </button>
              ) : null}
              {group.team === "unassigned" && myTeam !== "unassigned" ? (
                <button type="button" className="vx-game-claim vx-game-claim-quiet" onClick={() => onClaim("unassigned")}>
                  回到待分队（听全房）
                </button>
              ) : null}
            </section>
          );
        })}
      </div>

      <footer className="vx-game-foot">
        <button
          type="button"
          className={`vx-game-mic${muted ? " vx-game-mic-muted" : ""}`}
          onClick={onToggleMute}
          aria-pressed={!muted}
        >
          {muted ? <MicOff size={16} /> : <Mic size={16} />}
          {muted ? "已静音" : "麦克风开着"}
        </button>
        <span className="vx-game-boost" onClick={(event) => event.stopPropagation()}>
            <span className="vx-game-boost-label">
              🎙 增强 <b>{Math.round(micBoost * 100)}%</b>
            </span>
            <input
              type="range"
              min={1}
              max={4}
              step={0.1}
              value={micBoost}
              onChange={(event) => onSetMicBoost(Number(event.target.value))}
              title="你的声音太小？拉高麦克风增强（对方实时听到）"
            />
          </span>
          <button
            type="button"
            className={`vx-game-mini${nsOn ? " vx-game-mini-on" : ""}`}
            onClick={onToggleNs}
            title="RNNoise AI 强降噪：压键盘/风扇/环境声"
          >
            AI降噪 {nsOn ? "开" : "关"}
          </button>
          <span className="vx-game-hint">
          {myTeam === "unassigned"
            ? "你在待分队：能听见全房，两队都听不到你"
            : `你在${TEAM_LABEL[myTeam]}：只听得到本队（对面与待分队都听不到你）`}
          </span>
        {isHost ? (
          <button type="button" className="vx-game-mini" onClick={onToggleCap} title="应对 6v4 这类游戏内真实情况">
            {unlocked ? "恢复每队 5 人" : "解锁每队人数上限"}
          </button>
        ) : null}
        <button type="button" className={`vx-btn vx-btn-small ${isHost ? "vx-btn-danger" : "vx-btn-ghost"}`} onClick={onLeave}>
          {isHost ? "关闭开黑圈" : "离开"}
        </button>
      </footer>

      {showTutorial ? <GameTutorial onClose={closeTutorial} /> : null}
    </div>
  );
}

/** 邀请链接（开黑圈专用 ?g= 参数，与语音房的 ?r=/?i= 区分）。 */
export function gameInviteUrl(code: string): string {
  // 桌面端页面在本地协议（tauri.localhost）下，直接复制会得到别人打不开的地址
  const host = window.location.hostname;
  const desktop = host === "tauri.localhost" || host.endsWith(".tauri.localhost");
  const url = new URL(desktop ? "https://5blong.pages.dev/" : window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("g", code);
  return url.toString();
}

/** 从 URL 里读开黑圈房间码（没有则 null）。 */
export function gameCodeFromUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get("g");
  return value && /^[0-9]{4}$/.test(value) ? value : null;
}

/** 版本标识（放在页脚，便于验收时确认跑的是哪个包）。 */
export function gameStyleVars(): CSSProperties {
  return {} as CSSProperties;
}
