import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Ban,
  Carrot,
  ChevronRight,
  ChevronUp,
  Ghost,
  Hand,
  HandMetal,
  Headphones,
  HeadphoneOff,
  HeartHandshake,
  Check,
  Copy as CopyIcon,
  ArrowUpFromLine,
  Laugh,
  Lock,
  LockOpen,
  MessageSquare,
  Mic,
  MicOff,
  MousePointer2,
  PartyPopper,
  PhoneOff,
  Send,
  Settings as SettingsIcon,
  Sparkles,
  UserMinus,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import type { ChatMessage, EngineStatus, MediaLinkState, Member } from "../engine";
import type { Notice } from "../use-voice";
import type { InteractEvent, InteractKind, Invite } from "../protocol";
import type { LucideIcon } from "lucide-react";
import { MonitorUp } from "lucide-react";
import { SHARE_QUALITY_PRESETS, autoTransportFor } from "../screen-share";

/** 可对其他成员做的小猪互动，按顺序展示成一排按钮。 */
const INTERACT_ACTIONS: ReadonlyArray<{ kind: InteractKind; label: string; Icon: LucideIcon }> = [
  { kind: "poke", label: "戳一戳", Icon: MousePointer2 },
  { kind: "wave", label: "打招呼", Icon: Hand },
  { kind: "feed", label: "投喂", Icon: Carrot },
  { kind: "pat", label: "摸一摸", Icon: HandMetal },
  { kind: "tickle", label: "挠痒痒", Icon: Laugh },
  { kind: "hug", label: "抱一抱", Icon: HeartHandshake },
  { kind: "boo", label: "吓一跳", Icon: Ghost },
  { kind: "cheer", label: "撒个花", Icon: PartyPopper },
  { kind: "hoist", label: "吊起来", Icon: ArrowUpFromLine },
];
import { Banner, Spinner, Toggle } from "./ui";
import { ViewportPopover } from "./ViewportPopover";
import { PigActor, PenFrame, PenScatter, useElementSize, ENTRY_TOTAL_MS } from "./PigPen";
import { NpcVisitor, PenPropsLayer, type PenPropEntry } from "./PenProps";
import { Campfire, PenTV, PenTvLightbox } from "./PenTV";
import { NPC_NAME, feetViewportPx, phaseForActor, tvSlotFor } from "../pen";
import type { ScreenShareState, ScreenViewPreference } from "../protocol";
import type { ShareQuality } from "../settings";
import pigJoinUrl from "../assets/pig-join.webp?url";
import pigHoistUrl from "../assets/pig-hoist.webp?url";
import pigDanceUrl from "../assets/pig-dance.webp?url";
import pigIdleUrl from "../assets/pig-idle.webp?url";
import pigWalkUrl from "../assets/pig-walk.webp?url";

interface AudioMenuState {
  peerId: string;
  personId: string;
  self: boolean;
  isHost: boolean;
  /** 被选中的成员是否被房主强制禁言。 */
  serverMuted: boolean;
  name: string;
  x: number;
  y: number;
  volume: number;
  muted: boolean;
  feedCount: number;
}

/** 滑条填充比例（Webkit 不支持原生 progress，用 CSS 变量画渐变）。 */
const rangeStyle = (pct: number): CSSProperties =>
  ({ "--vx-range-pct": `${pct}%` }) as CSSProperties;

export function RoomView({
  status,
  members,
  speaking,
  messages,
  invite,
  notice,
  chatOpen,
  unread,
  displayNames,
  isHost,
  maxMembers,
  onCopyCode,
  onCopyInvite,
  onToggleMute,
  onToggleChat,
  onLeave,
  onSettings,
  onSend,
  onDismissNotice,
  micVolume,
  onSetMicVolume,
  onSetPeerVolume,
  onTogglePeerMuted,
  onGetPeerAudio,
  processing,
  captureLive,
  onSetNoiseSuppression,
  onSetProcessingFlag,
  penEvents,
  onReportPenActor,
  getPenPosition,
  audioBlocked,
  onResumeAudio,
  mediaStates,
  roomLocked,
  deaf,
  interactions,
  feedCounts,
  onToggleDeaf,
  onKick,
  onForceMute,
  onToggleLock,
  onInteract,
  screenShare,
  shareStream,
  sharePc,
  onStartShare,
  onStopShare,
  shareQuality,
  onSetShareQuality,
  shareTransport,
  onSetShareTransport,
  shareViewMode,
  onSetShareViewMode,
}: {
  status: EngineStatus;
  members: Member[];
  speaking: string[];
  messages: ChatMessage[];
  invite: Invite | null;
  notice: Notice | null;
  chatOpen: boolean;
  unread: number;
  displayNames: Map<string, string>;
  isHost: boolean;
  maxMembers: number;
  onCopyCode: () => void;
  onCopyInvite: () => Promise<boolean>;
  onToggleMute: () => void;
  onToggleChat: () => void;
  onLeave: () => void;
  onSettings: () => void;
  onSend: (text: string) => void;
  onDismissNotice: () => void;
  micVolume: number;
  onSetMicVolume: (volume: number) => void;
  onSetPeerVolume: (peerId: string, volume: number) => void;
  onTogglePeerMuted: (peerId: string) => boolean;
  onGetPeerAudio: (peerId: string) => { volume: number; muted: boolean };
  processing: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };
  /** 回声消除 / 自动增益是否已实时应用到当前麦克风轨道（引擎回读确认）。 */
  captureLive: { echoCancellation: boolean; autoGainControl: boolean };
  onSetNoiseSuppression: (on: boolean) => void;
  onSetProcessingFlag: (
    key: "echoCancellation" | "autoGainControl",
    value: boolean,
  ) => void;
  /** 猪圈事件（房主广播下来，各端同步播放）。 */
  penEvents: PenPropEntry[];
  /** 猪把当前位置报给引擎（横向 0~1 + 纵深 0~1）。 */
  onReportPenActor: (id: string, x: number, lane: number) => void;
  /** 取某头猪最近上报的横向位置，用来把"摸一摸"的互动对准它。 */
  getPenPosition: (id: string) => number | undefined;
  /** 取某头猪最近上报的纵深（0=最远 1=最近）。 */
  /** 对方的音频被浏览器拦下了（用户听不见别人说话）。 */
  audioBlocked: boolean;
  /** 借一次点击恢复远端音频播放。 */
  onResumeAudio: () => void;
  /** 与每个成员的媒体连接状态（用于猪头顶网络点）。 */
  mediaStates: Record<string, MediaLinkState>;
  /** 房间是否上锁。 */
  roomLocked: boolean;
  /** 本机是否闭听。 */
  deaf: boolean;
  /** 最近的小猪互动（戳/打招呼/投喂）。 */
  interactions: { key: number; event: InteractEvent }[];
  /** 本机对各成员（按个人 ID）的投喂次数。 */
  feedCounts: Record<string, number>;
  onToggleDeaf: () => void;
  onKick: (id: string) => void;
  onForceMute: (id: string, muted: boolean) => void;
  onToggleLock: () => void;
  onInteract: (peerId: string, personId: string, kind: InteractKind) => void;
  /** 屏幕共享状态（房主权威广播；null = 电视不在场）。 */
  screenShare: ScreenShareState | null;
  /** 电视正在播的画面流（观看端订阅 / 共享者本机采集）。 */
  shareStream: MediaStream | null;
  /** 订阅端连接（观众放大层拉链路数据用；共享者本机为 null）。 */
  sharePc?: RTCPeerConnection | null;
  /** 开播（参数为画质档位）。 */
  onStartShare: (quality: ShareQuality) => void;
  /** 停播。 */
  onStopShare: () => void;
  /** 本机选的画质档位。 */
  shareQuality: ShareQuality;
  /** 改画质档位（落盘，下次开播生效）。 */
  onSetShareQuality: (quality: ShareQuality) => void;
  /** 屏幕共享传输方式（auto 自动 / p2p 直连 / sfu 转发）与切换。 */
  shareTransport: "p2p" | "sfu" | "auto";
  onSetShareTransport: (transport: "p2p" | "sfu" | "auto") => void;
  /** 观众端画质偏好（自动 / 清晰优先 / 流畅优先）与切换。 */
  shareViewMode: ScreenViewPreference;
  onSetShareViewMode: (mode: ScreenViewPreference) => void;
}) {
  const self = members.find((member) => member.local) ?? null;
  const muted = self?.muted ?? true;
  const [copied, setCopied] = useState<"code" | "invite" | null>(null);

  // ------------------------------------------------------------ 围炉看 TV

  /** 放大层开关。 */
  const [tvExpanded, setTvExpanded] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const tvLive = screenShare !== null;
  const selfSharing = tvLive && self !== null && screenShare.sharerId === self.id;
  const tvOccupied = tvLive && !selfSharing;

  useEffect(() => {
    if (!tvLive) setTvExpanded(false);
  }, [tvLive]);

  useEffect(() => {
    if (!shareMenuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShareMenuOpen(false);
    };
    // 点菜单和共享按钮以外的地方也关（按钮自身的 onClick 负责开/关切换）
    const onDown = (event: PointerEvent) => {
      const t = event.target as HTMLElement | null;
      if (t?.closest(".vx-share-menu") || t?.closest(".vx-ctl")) return;
      setShareMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [shareMenuOpen]);

  /*
   * 成员第一次出现在名册的时刻：新成员入圈要播"空降入场"。
   * 关键规则：
   * - 首次渲染时名册里**已经在房**的成员（房主等）不播——对进房的
   *   客人来说，"房主本来就在"，不该跟着一起空降；
   * - 自己（本端用户）首次进房要播——"我来了"的仪式感；
   * - 之后再出现的新成员（后续进房的人）都要播。
   * 成员离开就清掉记录——断线重连回来会再空降一次，算是意外之喜。
   */
  const joinAtRef = useRef(new Map<string, number>());
  const seededRef = useRef(false);
  const joinAt = useMemo(() => {
    const map = joinAtRef.current;
    const now = Date.now();
    /*
     * 种子时刻 = 名册"首次非空"的那一帧（握手期间名册可能先空后满，
     * 不能用空名册那一帧当种子，否则房主随后的出现会被误判成新成员）。
     */
    const firstRoster = !seededRef.current && members.length > 0;
    if (members.length > 0) seededRef.current = true;
    for (const member of members) {
      if (map.has(member.id)) continue;
      map.set(member.id, firstRoster && !member.local ? -ENTRY_TOTAL_MS : now);
    }
    for (const id of [...map.keys()]) {
      if (!members.some((member) => member.id === id)) map.delete(id);
    }
    return new Map(map);
  }, [members]);

  // 预加载核心状态素材（入圈/吊起来/蹦迪/待机/走路），避免状态切换时白屏等图。
  useEffect(() => {
    for (const url of [pigJoinUrl, pigHoistUrl, pigDanceUrl, pigIdleUrl, pigWalkUrl]) {
      const img = new Image();
      img.src = url;
    }
  }, []);

  const speakingSet = useMemo(() => new Set(speaking), [speaking]);
  const { ref: stageRef, width: stageWidth, height: stageHeight } = useElementSize<HTMLElement>();

  /** 舞台底边到视口底部的距离（px）：视口脚部带 → 舞台内 bottom 的换算用。 */
  const stageBottomGap = useMemo(() => {
    const rect = stageRef.current?.getBoundingClientRect();
    return rect ? Math.max(0, window.innerHeight - rect.bottom) : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageWidth, stageHeight]);

  /** 各猪的围观位（仅房主端驱动走位；确定性排布，访客靠位置广播跟随）。 */
  const tvTargets = useMemo(() => {
    const map = new Map<string, { x: number; bottomPx: number; delayMs: number; faceLeft: boolean }>();
    if (!isHost || !tvLive) return map;
    const ids = members.map((member) => member.id);
    for (const member of members) {
      const slot = tvSlotFor(member.id, ids);
      map.set(member.id, {
        x: slot.x,
        bottomPx: feetViewportPx(slot.lane, window.innerHeight) - stageBottomGap,
        delayMs: slot.delayMs,
        faceLeft: slot.faceLeft,
      });
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, tvLive, members, stageBottomGap]);

  /*
   * 动作阶段（走过去 / 正在吃 / 使劲 / 闻一闻）是按时间戳推算的，
   * 所以要有个时钟推着重渲染，否则阶段不会自己往前走。
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (penEvents.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 400);
    return () => window.clearInterval(timer);
  }, [penEvents.length]);

  /**
   * DDY 这次出场要做什么。
   *
   * - "feed"：最近的 DDY 丢菜事件（定时丢菜，或成员点"投喂"）——走到蔬菜
   *   落点旁把菜抛出去。出场窗口与 4.4s 的走位动画对齐（前留 1.2s 入场）。
   * - "pat"：最近的"摸一摸"互动——走到目标猪身边弯腰摸两下，窗口同样是 4.4s。
   * 两者同时发生时取较晚的那个。
   */
  const npcShow = useMemo(() => {
    let best: { mission: "feed" | "pat"; ts: number; x: number } | null = null;
    for (const entry of penEvents) {
      const event = entry.event;
      if (event.kind !== "toss" || event.npc !== NPC_NAME) continue;
      if (now < event.ts - 1200 || now > event.ts + 4200) continue;
      if (!best || event.ts > best.ts) best = { mission: "feed", ts: event.ts, x: event.veg.x };
    }
    for (const item of interactions) {
      if (item.event.kind !== "pat") continue;
      const ts = item.event.ts;
      if (now < ts || now > ts + 4400) continue;
      const px = getPenPosition(item.event.to);
      if (px === undefined) continue;
      if (!best || ts > best.ts) best = { mission: "pat", ts, x: px };
    }
    return best;
  }, [penEvents, interactions, now, getPenPosition]);

  /** 每头猪最近一次"冲着它来"的互动（戳/打招呼/投喂），用于头顶气泡。 */
  const reactionByActor = useMemo(() => {
    const map = new Map<string, InteractEvent>();
    for (const item of interactions) map.set(item.event.to, item.event);
    return map;
  }, [interactions]);

  /** 该猪此刻要吃的那棵菜在哪（横向 0~1 + 落地高度 px）；没有就返回 undefined。 */
  const eatTarget = useCallback(
    (actorId: string): { x: number; bottomPx: number } | undefined => {
      // 最近一次"这头猪吃"发生在什么时候：比它早的菜都已经吃掉了
      let lastEatAt = 0;
      for (const entry of penEvents) {
        const event = entry.event;
        if (event.kind !== "eat") continue;
        if ((event.actor === actorId || event.actor === "*") && event.ts > lastEatAt) {
          lastEatAt = event.ts;
        }
      }
      // 取还没被吃掉的那棵（最新的）
      let best: { x: number; bottomPx: number } | undefined;
      let bestTs = -1;
      for (const entry of penEvents) {
        const event = entry.event;
        if (event.kind !== "toss") continue;
        if (event.ts <= lastEatAt) continue;
        if (event.ts > bestTs) {
          bestTs = event.ts;
          // 与 PenPropsLayer 的蔬菜定位完全一致（视口脚部带 8%~50%）
          best = {
            x: event.veg.x,
            bottomPx: feetViewportPx(event.veg.lane, window.innerHeight) - stageBottomGap,
          };
        }
      }
      return best;
    },
    [penEvents, stageHeight],
  );
  const listRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");
  const [audioMenu, setAudioMenu] = useState<AudioMenuState | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);

  const openAudioMenu = (event: ReactMouseEvent, member: Member) => {
    event.stopPropagation();
    const audio = member.local
      ? { volume: micVolume, muted: false }
      : onGetPeerAudio(member.id);
    setAudioMenu({
      peerId: member.id,
      personId: member.personId,
      self: member.local,
      isHost: member.isHost,
      serverMuted: member.serverMuted ?? false,
      name: displayNames.get(member.id) ?? member.name,
      x: event.clientX,
      y: event.clientY,
      volume: audio.volume,
      muted: audio.muted,
      feedCount: member.local ? 0 : feedCounts[member.personId] ?? 0,
    });
  };

  /** 对菜单里的成员发起互动，并顺手关菜单（投喂/戳一下不需要重复点）。 */
  const interactMenu = (kind: InteractKind) => {
    if (!audioMenu) return;
    onInteract(audioMenu.peerId, audioMenu.personId, kind);
    if (kind === "feed") {
      setAudioMenu((current) =>
        current ? { ...current, feedCount: current.feedCount + 1 } : current,
      );
    }
    closeAudioMenu();
  };

  const closeAudioMenu = () => setAudioMenu(null);

  const changeMenuVolume = (value: number) => {
    setAudioMenu((current) => (current ? { ...current, volume: value, muted: false } : current));
    if (audioMenu?.self) onSetMicVolume(value);
    else if (audioMenu) onSetPeerVolume(audioMenu.peerId, value);
  };

  const toggleMenuMute = () => {
    if (!audioMenu || audioMenu.self) return;
    const muted = onTogglePeerMuted(audioMenu.peerId);
    setAudioMenu({ ...audioMenu, muted });
  };

  useEffect(() => {
    if (!audioMenu && !voiceOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeAudioMenu();
        setVoiceOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [audioMenu, voiceOpen]);

  /*
   * 全局热键。
   *
   * 这是「开黑」场景的刚需：人在游戏窗口里，要闭嘴只能切回来点按钮。
   * Ctrl+Shift+M 是语音工具的通行约定（Discord 起），尽量别改。
   *
   * 只在**非输入状态**下生效，否则聊天框里按快捷键会误触。
   * 用 event.code 判断字母键：中文输入法或大写锁定时 key 可能不是 "m"。
   */
  useEffect(() => {
    const onHotkey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      // 正在输入框/可编辑区域里打字时不抢键
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;

      if (event.code === "KeyM") {
        event.preventDefault();
        if (!(self?.serverMuted ?? false)) onToggleMute();
      } else if (event.code === "KeyC") {
        event.preventDefault();
        onToggleChat();
      } else if (event.code === "KeyD") {
        event.preventDefault();
        onToggleDeaf();
      }
    };
    window.addEventListener("keydown", onHotkey);
    return () => window.removeEventListener("keydown", onHotkey);
  }, [onToggleMute, onToggleChat, onToggleDeaf, self?.serverMuted]);

  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, chatOpen]);

  const flash = (which: "code" | "invite") => {
    setCopied(which);
    window.setTimeout(() => setCopied(null), 1400);
  };

  const submitChat = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    onSend(draft);
    setDraft("");
  };

  // 标签页标题：有人说话时显示是谁，否则显示人数；离开房间恢复默认标题。
  useEffect(() => {
    const talking = members.filter((m) => !m.local && speakingSet.has(m.id) && !m.muted);
    let title: string;
    if (talking.length > 0) {
      const names = talking
        .slice(0, 2)
        .map((m) => displayNames.get(m.id) ?? m.name)
        .join("、");
      const more = talking.length > 2 ? ` 等 ${talking.length} 人` : "";
      title = `● ${names}${more} 正在说话 · 5blong`;
    } else {
      title = `${members.length} 人在房间 · 5blong`;
    }
    document.title = title;
    return () => {
      document.title = "5blong · 临时语音房";
    };
  }, [members, speakingSet, displayNames]);

  const statusLabel =
    status === "connected"
      ? "已连接"
      : status === "reconnecting"
        ? "重连中…"
        : status === "error"
          ? "连接失败"
          : "连接中…";

  return (
    <div className="vx-page vx-room">
      {audioMenu || voiceOpen ? createPortal(
        <div
          className="vx-menu-backdrop"
          onClick={() => {
            closeAudioMenu();
            setVoiceOpen(false);
          }}
        />,
        document.body,
      ) : null}
      {audioMenu ? (
        <>
          <ViewportPopover
            key={audioMenu.peerId}
            x={audioMenu.x}
            y={audioMenu.y}
            label={audioMenu.self ? "麦克风音量" : `${audioMenu.name}的音量与互动`}
          >
            <div className="vx-member-menu-head">
              {audioMenu.self ? (
                <Mic size={15} />
              ) : audioMenu.muted ? (
                <VolumeX size={15} />
              ) : (
                <Volume2 size={15} />
              )}
              <strong>{audioMenu.self ? "麦克风音量" : audioMenu.name}</strong>
            </div>
            <div className="vx-member-menu-row">
              <input
                type="range"
                className="vx-range"
                style={rangeStyle((audioMenu.volume / (audioMenu.self ? 2 : 1)) * 100)}
                min={0}
                max={audioMenu.self ? 2 : 1}
                step={0.01}
                value={audioMenu.volume}
                onChange={(event) => changeMenuVolume(Number(event.target.value))}
              />
              <span className="vx-member-menu-value">
                {audioMenu.self
                  ? audioMenu.volume > 1
                    ? `增强 ${Math.round(audioMenu.volume * 100)}%`
                    : `${Math.round(audioMenu.volume * 100)}%`
                  : audioMenu.muted
                    ? "已静音"
                    : `${Math.round(audioMenu.volume * 100)}%`}
              </span>
            </div>
            {audioMenu.self ? (
              <p className="vx-member-menu-hint">100% 为原始音量，再往上是麦克风增强</p>
            ) : (
              <>
                <button
                  type="button"
                  className={`vx-menu-btn${audioMenu.muted ? " vx-menu-btn-active" : ""}`}
                  onClick={toggleMenuMute}
                >
                  {audioMenu.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                  {audioMenu.muted ? "取消静音 TA" : "本地静音 TA"}
                </button>

                <div className="vx-menu-divider" />
                <div className="vx-interact-row">
                  {INTERACT_ACTIONS.map(({ kind, label, Icon }) => (
                    <button
                      key={kind}
                      type="button"
                      className="vx-interact-btn"
                      onClick={() => interactMenu(kind)}
                    >
                      <Icon size={15} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                <p className="vx-member-menu-hint">你已经投喂了 {audioMenu.feedCount} 次</p>

                {isHost && !audioMenu.isHost ? (
                  <>
                    <div className="vx-menu-divider" />
                    <button
                      type="button"
                      className={`vx-menu-btn${audioMenu.serverMuted ? " vx-menu-btn-active" : ""}`}
                      onClick={() => {
                        onForceMute(audioMenu.peerId, !audioMenu.serverMuted);
                        closeAudioMenu();
                      }}
                    >
                      {audioMenu.serverMuted ? <Mic size={14} /> : <Ban size={14} />}
                      {audioMenu.serverMuted ? "解除禁言" : "禁言（关麦）"}
                    </button>
                    <button
                      type="button"
                      className="vx-menu-btn vx-menu-btn-danger"
                      onClick={() => {
                        onKick(audioMenu.peerId);
                        closeAudioMenu();
                      }}
                    >
                      <UserMinus size={14} />
                      踢出房间
                    </button>
                  </>
                ) : null}
                {audioMenu.serverMuted ? (
                  <p className="vx-member-menu-hint vx-hint-warn">TA 已被房主禁言</p>
                ) : null}
              </>
            )}
          </ViewportPopover>
        </>
      ) : null}
      {/*
        顶栏改成挂在木栏上的"猪圈公告牌"：
        房间码就是猪圈的铭牌号，状态/人数/邀请/设置都长在牌子上，
        不再是一条飘在圈外的白色工具栏。
      */}
      <header className="vx-room-top">
        <div className="vx-signboard">
          <span className="vx-sign-hanger vx-sign-hanger-l" aria-hidden="true" />
          <span className="vx-sign-hanger vx-sign-hanger-r" aria-hidden="true" />
          <span className="vx-sign-screw vx-sign-screw-l" aria-hidden="true" />
          <span className="vx-sign-screw vx-sign-screw-r" aria-hidden="true" />

          <span className="vx-sign-brand">
            <span className="vx-logo-dot" />
            5blong
          </span>

          {invite ? (
            <button
              type="button"
              className="vx-sign-code"
              onClick={() => {
                onCopyCode();
                flash("code");
              }}
              title="点击复制房间码"
            >
              <span className="vx-sign-code-label">圈号</span>
              <span className="vx-sign-code-value">{invite.code}</span>
              {/*
                这里原来写"复制 / 已复制"两个汉字，和右边的"复制邀请"重复了同一件事，
                顶部条于是有两个都像主操作的按钮。改成一个小图标：默认复制、点了变勾。
              */}
              <span className="vx-sign-code-state" aria-hidden="true">
                {copied === "code" ? <Check size={12} /> : <CopyIcon size={12} />}
              </span>
            </button>
          ) : null}

          <span className={`vx-sign-conn vx-conn-${status}`}>
            <span className="vx-conn-dot" />
            {statusLabel}
          </span>

          <span className="vx-sign-count" title={`房间人数上限 ${maxMembers} 人`}>
            <Users size={14} /> {members.length}/{maxMembers}
          </span>

          {invite ? (
            <button
              type="button"
              className="vx-btn vx-btn-small vx-btn-primary vx-sign-btn"
              onClick={() => {
                void onCopyInvite().then((ok) => {
                  if (ok) flash("invite");
                });
              }}
            >
              {copied === "invite" ? "已复制邀请链接" : "复制邀请"}
            </button>
          ) : null}

          {isHost ? (
            /*
             * 锁房按钮：以前只有 title 提示，锁上之后界面上**看不到"已锁"这件事**，
             * 房主自己都不知道当前锁着没有。现在加一个可见的状态文字。
             */
            <button
              type="button"
              className={`vx-sign-lock${roomLocked ? " vx-sign-lock-on" : ""}`}
              onClick={onToggleLock}
              aria-pressed={roomLocked}
              aria-label={roomLocked ? "房间已上锁，点击解锁" : "点击锁定房间，不再接受新成员"}
              title={roomLocked ? "房间已上锁，点击解锁" : "上锁后不再接受新成员加入（点击上锁）"}
            >
              {roomLocked ? <Lock size={16} /> : <LockOpen size={16} />}
              {roomLocked ? <span className="vx-sign-lock-text">已锁</span> : null}
            </button>
          ) : roomLocked ? (
            <span className="vx-sign-lock vx-sign-lock-on" title="房间已上锁，暂不接受新成员">
              <Lock size={16} />
              <span className="vx-sign-lock-text">已锁</span>
            </span>
          ) : null}

          <button
            type="button"
            className="vx-sign-settings"
            onClick={onSettings}
            aria-label="设置"
            title="设置"
          >
            <SettingsIcon size={17} />
          </button>
        </div>
      </header>

      {notice ? (
        <Banner kind={notice.kind} onClose={onDismissNotice}>
          {notice.text}
        </Banner>
      ) : null}

      {/*
        音频被自动播放策略拦下时，给一个**必须点到的**恢复入口。
        这个提示不能只是文字：用户不点就永远听不见别人说话。
      */}
      {audioBlocked ? (
        <button type="button" className="vx-audio-blocked" onClick={onResumeAudio}>
          <VolumeX size={16} />
          <span>听不到对方的声音？点这里恢复</span>
        </button>
      ) : null}

      <main className="vx-stage" ref={stageRef}>
        {/* 整页猪圈：木栏围住整个房间区域，猪在整片场地里走动 */}
        <PenFrame width={stageWidth} />

        {status === "connecting" || status === "preparing" || status === "reconnecting" ? (
          <div className="vx-stage-status">
            <Spinner size={22} />
            <span>
              {status === "preparing"
                ? "正在准备麦克风…"
                : status === "reconnecting"
                  ? "正在重新连接…"
                  : "正在进入房间…"}
            </span>
          </div>
        ) : null}

        {members.map((member, index) => {
          const active = speakingSet.has(member.id) && !member.muted;
          const label = displayNames.get(member.id) ?? member.name;
          const { action, phase } = phaseForActor(
            penEvents.map((entry) => entry.event),
            member.id,
            now,
          );
          return (
            <PigActor
              actorId={member.id}
              key={member.id}
              index={index}
              total={members.length}
              stageWidth={stageWidth}
              stageHeight={Math.max(120, stageHeight - 96)}
              color={member.color}
              speaking={active}
              sleeping={member.muted}
              deafened={member.deafened ?? false}
              isHost={member.isHost}
              label={label}
              action={action}
              phase={phase}
              targetX={eatTarget(member.id)}
              tvTarget={tvTargets.get(member.id)}
              watching={tvLive}
              mediaState={member.local ? undefined : mediaStates[member.id]}
              reaction={reactionByActor.get(member.id)}
              entryAt={joinAt.get(member.id)}
              followEnabled={!isHost}
              feedCount={member.local ? 0 : feedCounts[member.personId] ?? 0}
              onReportPosition={(x, lane) => onReportPenActor(member.id, x, lane)}
              badges={
                <>
                  {member.isHost ? <b>房主</b> : null}
                  {member.local ? <b>我</b> : null}
                  {member.deafened ? <b className="vx-plate-deaf">闭听</b> : null}
                  {!member.hasMic ? <b className="vx-plate-quiet">收听</b> : null}
                </>
              }
              onSelect={(event) => openAudioMenu(event, member)}
            />
          );
        })}

        {/* 地面点缀放在猪之后：这样猪在草地"后面"走动，而不是盖在草上 */}
        <PenScatter seed={invite ? invite.code.length * 7 + invite.code.charCodeAt(0) : 3} />

        {/* 道具层：投喂落下的蔬菜 */}
        <PenPropsLayer entries={penEvents} stageBottomGap={stageBottomGap} now={now} />

        {/* DDY 本尊：从右侧走进来，到目标位置丢菜或抚摸，再走回去 */}
        <NpcVisitor
          name={NPC_NAME}
          active={npcShow !== null}
          mission={npcShow?.mission ?? "feed"}
          targetX={npcShow?.x ?? 0.8}
          stageWidth={stageWidth}
        />

        {/* 围炉看投影：篝火在两翼猪群中间靠后（常驻）；投影仪共享时从天而降，
            光束打到坡上内嵌的幕布。猪在道具/光束之后走动。 */}
        <Campfire stageWidth={stageWidth} stageBottomGap={stageBottomGap} />
        <PenTV
          state={screenShare}
          stream={shareStream}
          stageWidth={stageWidth}
          stageHeight={stageHeight}
          stageBottomGap={stageBottomGap}
          paused={tvExpanded}
          onExpand={() => setTvExpanded(true)}
        />

        {tvExpanded && screenShare ? (
          <PenTvLightbox
            state={screenShare}
            stream={shareStream}
            pc={sharePc}
            sharerName={displayNames.get(screenShare.sharerId) ?? "成员"}
            viewMode={shareViewMode}
            onViewMode={onSetShareViewMode}
            isSharer={selfSharing}
            onClose={() => setTvExpanded(false)}
          />
        ) : null}

        {invite && members.length === 1 ? (
          <div className="vx-empty vx-empty-pen">
            <span className="vx-empty-pigs" aria-hidden="true">
              <WaitingPigHead />
              <WaitingPigHead />
              <WaitingPigHead />
            </span>
            <p>圈里只有你一头</p>
            {/*
              文案要和真实流程一致：拿到链接的人会先看到确认页（写清谁邀请、
              用什么名字、要不要先静音），点一下才进房。原来写"他们一点开就进圈了"
              与实现不符，会让人以为链接是"点开即入"。
            */}
            <span>把链接发给朋友，他们确认一下就进圈了</span>
            <button type="button" className="vx-btn vx-btn-small vx-btn-primary" onClick={() => void onCopyInvite()}>
              复制邀请链接
            </button>
          </div>
        ) : null}
      </main>

      <footer className="vx-controls">
        <div className="vx-controls-tray">
        <div className="vx-mic-anchor">
          <div className={`vx-mic-pill${muted ? " vx-mic-pill-muted" : ""}`}>
            <button
              type="button"
              className="vx-mic-main"
              onClick={onToggleMute}
              disabled={self?.serverMuted ?? false}
              aria-pressed={!muted}
              title={
                self?.serverMuted
                  ? "你已被房主禁言，暂时不能开麦"
                  : self?.hasMic
                    ? muted
                      ? "取消静音（Ctrl+Shift+M）"
                      : "静音（Ctrl+Shift+M）"
                    : "没有可用的麦克风"
              }
            >
              {muted ? <MicOff size={20} /> : <Mic size={20} />}
              <span>{muted ? "已静音" : "麦克风开"}</span>
            </button>
            <span className="vx-mic-sep" />
            <button
              type="button"
              className={`vx-mic-expand${voiceOpen ? " vx-mic-expand-on" : ""}`}
              onClick={() => setVoiceOpen((open) => !open)}
              aria-label="语音快捷设置"
              title="语音快捷设置"
              aria-expanded={voiceOpen}
            >
              <ChevronUp size={18} />
            </button>
          </div>

          {voiceOpen ? (
            <div className="vx-voice-panel" onClick={(event) => event.stopPropagation()}>
              <div className="vx-voice-volume">
                <div className="vx-voice-volume-head">
                  <span className="vx-voice-volume-label">
                    <Mic size={14} /> 麦克风音量
                  </span>
                  <strong>
                    {micVolume > 1
                      ? `增强 ${Math.round(micVolume * 100)}%`
                      : `${Math.round(micVolume * 100)}%`}
                  </strong>
                </div>
                <input
                  type="range"
                  className="vx-range"
                  style={rangeStyle((micVolume / 2) * 100)}
                  min={0}
                  max={2}
                  step={0.01}
                  value={micVolume}
                  onChange={(event) => onSetMicVolume(Number(event.target.value))}
                />
                <div className="vx-voice-scale">
                  <span>0</span>
                  <span>100%</span>
                  <span>增强 200%</span>
                </div>
              </div>

              <div className="vx-voice-rows">
                <div className="vx-voice-row">
                  <span className="vx-voice-row-label">
                    <Sparkles size={15} /> AI 智能降噪
                  </span>
                  <Toggle
                    checked={processing.noiseSuppression}
                    label="AI 智能降噪"
                    onChange={onSetNoiseSuppression}
                  />
                </div>
                <div className="vx-voice-row">
                  <span className="vx-voice-row-label">回声消除</span>
                  <div className="vx-voice-row-side">
                    {processing.echoCancellation && !captureLive.echoCancellation ? (
                      <span className="vx-voice-tag" title="当前浏览器不支持通话中修改，下次进房生效">
                        重进生效
                      </span>
                    ) : null}
                    <Toggle
                      checked={processing.echoCancellation}
                      label="回声消除"
                      onChange={(next) => onSetProcessingFlag("echoCancellation", next)}
                    />
                  </div>
                </div>
                <div className="vx-voice-row">
                  <span className="vx-voice-row-label">自动增益</span>
                  <div className="vx-voice-row-side">
                    {processing.autoGainControl && !captureLive.autoGainControl ? (
                      <span className="vx-voice-tag" title="当前浏览器不支持通话中修改，下次进房生效">
                        重进生效
                      </span>
                    ) : null}
                    <Toggle
                      checked={processing.autoGainControl}
                      label="自动增益"
                      onChange={(next) => onSetProcessingFlag("autoGainControl", next)}
                    />
                  </div>
                </div>
              </div>

              <button
                type="button"
                className="vx-voice-more"
                onClick={() => {
                  setVoiceOpen(false);
                  onSettings();
                }}
              >
                <SettingsIcon size={15} /> 完整语音设置
                <ChevronRight size={15} />
              </button>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className={`vx-ctl${selfSharing ? " vx-ctl-on" : ""}${tvOccupied ? " vx-ctl-disabled" : ""}`}
          onClick={() => {
            if (selfSharing) {
              onStopShare();
              return;
            }
            if (tvOccupied) return;
            setShareMenuOpen((open) => !open);
          }}
          disabled={tvOccupied}
          aria-pressed={selfSharing}
          title={
            selfSharing
              ? "停止共享屏幕"
              : tvOccupied
                ? `电视被 ${displayNames.get(screenShare!.sharerId) ?? "别人"} 占着`
                : "共享屏幕到小电视"
          }
        >
          <span className="vx-ctl-icon">
            <MonitorUp size={20} />
          </span>
          <span>{selfSharing ? "停共享" : "共享"}</span>
        </button>

        {shareMenuOpen ? (
          <div className="vx-share-menu" onClick={(event) => event.stopPropagation()}>
            <p className="vx-share-menu-title">共享画质</p>
            {(Object.keys(SHARE_QUALITY_PRESETS) as ShareQuality[]).map((key) => {
              const preset = SHARE_QUALITY_PRESETS[key];
              return (
                <button
                  key={key}
                  type="button"
                  className={`vx-share-quality${shareQuality === key ? " vx-share-quality-on" : ""}`}
                  onClick={() => onSetShareQuality(key)}
                >
                  <strong>{preset.label}</strong>
                  <span>60 帧 · {Math.round(preset.maxBitrate / 1000)} kbps</span>
                </button>
              );
            })}
            <p className="vx-share-menu-title">
              共享方式
              <span className="vx-share-help" tabIndex={0} aria-label="两种共享方式的优缺点说明">
                ?
                <span className="vx-share-tip" role="tooltip">
                  <b>自动（推荐）</b>：1~2 位观众走直连（画质最好），3 人及以上自动切
                  SFU 转发——直连的上行是"码率 × 观众数"，人多会把自家宽带上行打爆。
                  <br />
                  <b>P2P 直连</b>：画面在成员间直接传输，不绕服务器，
                  同网/国内延迟低、画质最好；双方网络都打不通直连时可能连不上。
                  <br />
                  <b>SFU 转发</b>：画面经服务器中转，连接成功率高、更稳定，
                  但要绕一道路由，画质和流畅度受线路影响，且消耗转发流量。
                </span>
              </span>
            </p>
            <div className="vx-share-transport">
              {(
                [
                  { key: "auto", name: "自动", desc: "按人数选直连/转发" },
                  { key: "p2p", name: "P2P 直连", desc: "画质最好 · 延迟最低" },
                  { key: "sfu", name: "SFU 转发", desc: "连接成功率兜底" },
                ] as const
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`vx-share-quality${shareTransport === item.key ? " vx-share-quality-on" : ""}`}
                  onClick={() => onSetShareTransport(item.key)}
                >
                  <strong>{item.name}</strong>
                  <span>{item.desc}</span>
                </button>
              ))}
            </div>
            <p className="vx-share-menu-hint">
              本次将用{autoTransportFor(shareTransport, members.length).transport === "sfu" ? "SFU 转发" : "P2P 直连"}
              ：{autoTransportFor(shareTransport, members.length).reason}
            </p>
            <button
              type="button"
              className="vx-btn vx-btn-small vx-btn-primary vx-share-start"
              onClick={() => {
                setShareMenuOpen(false);
                onStartShare(shareQuality);
              }}
            >
              选择窗口开始共享
            </button>
            <p className="vx-share-menu-hint">全房间同看一块幕布，同一时间一人共享</p>
          </div>
        ) : null}

        <button
          type="button"
          className={`vx-ctl${deaf ? " vx-ctl-on vx-ctl-deaf" : ""}`}
          onClick={onToggleDeaf}
          aria-pressed={deaf}
          title={
            deaf
              ? "取消闭听（恢复声音）（Ctrl+Shift+D）"
              : "闭听：同时闭麦并暂时不听任何人（Ctrl+Shift+D）"
          }
        >
          <span className="vx-ctl-icon">
            {deaf ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
          </span>
          <span>{deaf ? "已闭听" : "闭听"}</span>
        </button>

        <button
          type="button"
          className={`vx-ctl${chatOpen ? " vx-ctl-on" : ""}`}
          onClick={onToggleChat}
          aria-pressed={chatOpen}
          title="房间聊天（Ctrl+Shift+C）"
        >
          <span className="vx-ctl-icon">
            <MessageSquare size={20} />
            {unread > 0 ? <span className="vx-badge">{unread > 99 ? "99+" : unread}</span> : null}
          </span>
          <span>聊天</span>
        </button>

        <button type="button" className="vx-ctl vx-ctl-danger" onClick={onLeave}>
          <PhoneOff size={20} />
          <span>{isHost ? "结束房间" : "离开"}</span>
        </button>
        </div>
      </footer>

      <aside className={`vx-chat${chatOpen ? " vx-chat-open" : ""}`} aria-hidden={!chatOpen}>
        <div className="vx-chat-head">
          <span>房间聊天</span>
          <button type="button" className="vx-icon-btn" onClick={onToggleChat} aria-label="关闭聊天">
            <X size={18} />
          </button>
        </div>
        <div className="vx-chat-list" ref={listRef}>
          {messages.length === 0 ? (
            <p className="vx-chat-empty">还没有消息。发言会在所有人屏幕上高亮。</p>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`vx-msg${message.self ? " vx-msg-self" : ""}`}>
                {!message.self ? <span className="vx-msg-name">{message.name}</span> : null}
                <span className="vx-msg-bubble">{message.text}</span>
                <span className="vx-msg-time">
                  {new Date(message.ts).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))
          )}
        </div>
        <form className="vx-chat-form" onSubmit={submitChat}>
          <input
            className="vx-input"
            value={draft}
            maxLength={500}
            placeholder="说点什么…"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="vx-icon-btn vx-icon-btn-primary" aria-label="发送">
            <Send size={16} />
          </button>
        </form>
      </aside>
    </div>
  );
}

/** 空圈等待示意用的小猪头（业主点名保留的原版，不要动它）。 */
function WaitingPigHead() {
  return (
    <svg viewBox="0 0 64 58" aria-hidden="true">
      <path d="M15 17 C9 7 13 -2 23 4 C27 8 26 15 23 19 Z" fill="#f092a8" />
      <path d="M49 17 C55 7 51 -2 41 4 C37 8 38 15 41 19 Z" fill="#f092a8" />
      <ellipse cx="32" cy="31" rx="24" ry="22" fill="#f8b8c4" />
      <ellipse cx="23" cy="28" rx="3.2" ry="4.2" fill="#4a2b34" />
      <ellipse cx="41" cy="28" rx="3.2" ry="4.2" fill="#4a2b34" />
      <circle cx="24.2" cy="26.4" r="1.1" fill="#ffffff" />
      <circle cx="42.2" cy="26.4" r="1.1" fill="#ffffff" />
      <ellipse cx="32" cy="41" rx="9" ry="7" fill="#f5a7b9" />
      <ellipse cx="28.6" cy="41" rx="1.7" ry="2.6" fill="#c77f93" />
      <ellipse cx="35.4" cy="41" rx="1.7" ry="2.6" fill="#c77f93" />
    </svg>
  );
}
