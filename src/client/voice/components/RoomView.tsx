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
  Candy,
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
  Moon,
  Music,
  RefreshCw,
  Snowflake,
  Lock,
  LockOpen,
  MessageSquare,
  Mic,
  MicOff,
  Megaphone,
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
  Gift,
  UserPlus,
} from "lucide-react";

import type { ChatMessage, EngineStatus, MediaLinkState, Member } from "../engine";
import type { Notice } from "../use-voice";
import type { InteractEvent, InteractKind, Invite } from "../protocol";
import { GROUP_INTERACT_COOLDOWN_MS } from "../protocol";

/** 多久没被互动就算"发呆"（头顶冒 z z）。 */
const IDLE_MOOD_MS = 180_000;
import type { SceneThemeId } from "../scene-theme";
import type { LucideIcon } from "lucide-react";
import { MonitorUp } from "lucide-react";
import { SHARE_QUALITY_PRESETS, autoTransportFor, perViewerBitrate } from "../screen-share";
import { isTauriRuntime, listLoopbackTargets, listShareWindows } from "../loopback";

/**
 * 可对其他成员做的小猪互动，按顺序展示成一排按钮。
 * 「打招呼」按场景主题换皮：雪原＝扔雪球、万圣夜＝丢南瓜（同一位置同一动作，
 * 只改标签与图标，零新增 UI 成本）。
 */
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
  // 2026-10-18：「请客」一人触发全场受益；「哄睡」是这套玩具里唯一"静"的动作
  { kind: "treat", label: "请客", Icon: Candy },
  { kind: "lull", label: "哄睡", Icon: Moon },
];
import { Banner, Spinner, Toggle } from "./ui";
import { ViewportPopover } from "./ViewportPopover";
import { PigActor, PenFrame, PenScatter, useElementSize, ENTRY_TOTAL_MS } from "./PigPen";
import { Fireworks } from "./Fireworks";
import { NpcVisitor, PenPropsLayer, type PenPropEntry } from "./PenProps";
import { Campfire, PenTV, PenTvLightbox } from "./PenTV";
import { NPC_NAME, feetViewportPx, phaseForActor, tvSlotFor } from "../pen";
import type { ScreenShareState, ScreenViewPreference } from "../protocol";
import type { ShareQuality } from "../settings";
// 音量滑块上限（值导入）：自己 300% / 别人 200%
import { MIC_VOLUME_MAX, PEER_VOLUME_MAX } from "../settings";
import pigJoinUrl from "../assets/pig-join.webp?url";
import pigHoistUrl from "../assets/pig-hoist.webp?url";
import pigDanceUrl from "../assets/pig-dance.webp?url";
import pigIdleUrl from "../assets/pig-idle.webp?url";
import pigWalkUrl from "../assets/pig-walk.webp?url";

interface AudioMenuState {
  peerId: string;
  personId: string;
  /** 对方账号 ID（8 位）；未登录 / 旧客户端没有 → 不显示"加好友" */
  accountId?: string;
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
  onOpenFeedback,
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
  onRetryLink,
  topic,
  onSetTopic,
  sceneTheme,
  screenShare,
  shareStream,
  sharePc,
  onStartShare,
  onStopShare,
  shareQuality,
  onSetShareQuality,
  shareTransport,
  onSetShareTransport,
  shareAudio,
  onSetShareAudio,
  shareAppPid,
  onSetShareAppPid,
  shareViewMode,
  onSetShareViewMode,
  shareLatency,
  onSetShareLatency,
  onWatchScreen,
  selfAccountId = null,
  friendAccountIds,
  onAddFriend,
}: {
  status: EngineStatus;
  members: Member[];
  speaking: string[];
  messages: ChatMessage[];
  invite: Invite | null;
  notice: Notice | null;
  /** 打开意见反馈弹窗（错误提示条上的「反馈此问题」入口） */
  onOpenFeedback: (errorText?: string) => void;
  chatOpen: boolean;
  unread: number;
  displayNames: Map<string, string>;
  isHost: boolean;
  maxMembers: number;
  onCopyCode: () => Promise<boolean>;
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
  /** 手动重连某个成员的语音链路（自动自愈失败后的兜底）。 */
  onRetryLink: (peerId: string) => void;
  /** 房主铭牌公告（全房可见；空串 = 没设）。 */
  topic: string;
  /** 房主修改公告（访客端不触发）。 */
  onSetTopic: (text: string) => void;
  /** 当前场景主题（个人偏好，随首页设置走；仅用于互动动作换皮）。 */
  sceneTheme: SceneThemeId | "";
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
  /** 共享时是否带系统声音 / 声音来源（null = 自动）。 */
  shareAudio: boolean;
  onSetShareAudio: (on: boolean) => void;
  shareAppPid: number | null;
  onSetShareAppPid: (pid: number | null) => void;
  /** 观众端画质偏好（自动 / 清晰优先 / 流畅优先）与切换。 */
  shareViewMode: ScreenViewPreference;
  onSetShareViewMode: (mode: ScreenViewPreference) => void;
  shareLatency: "low" | "balanced" | "smooth";
  onSetShareLatency: (mode: "low" | "balanced" | "smooth") => void;
  /** 观众看不看共享：灯箱打开=watch（满码率），关掉=preview（低码率缩略）。 */
  onWatchScreen: (state: "watch" | "preview" | "off") => void;
  /** 自己的账号 ID（未登录 null）：决定要不要显示"加好友" */
  selfAccountId?: string | null;
  /** 已经是好友的账号 ID 集合 */
  friendAccountIds?: Set<string>;
  /** 加好友（只在双方都登录时可用；不影响房内任何权限） */
  onAddFriend?: (accountId: string) => Promise<boolean>;
}) {
  const self = members.find((member) => member.local) ?? null;
  const muted = self?.muted ?? true;
  const [copied, setCopied] = useState<"code" | "invite" | null>(null);
  /** 房主铭牌公告的行内编辑态。 */
  const [topicEditing, setTopicEditing] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  // ------------------------------------------------------------ 围炉看 TV

  /** 放大层开关。 */
  const [tvExpanded, setTvExpanded] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  /** 共享声音来源候选（仅桌面客户端）：打开共享菜单时现拉一次"正在出声的应用"。 */
  const [shareApps, setShareApps] = useState<{ pid: number; name: string }[]>([]);
  const shareDesktop = isTauriRuntime();
  const tvLive = screenShare !== null;
  const selfSharing = tvLive && self !== null && screenShare.sharerId === self.id;
  const tvOccupied = tvLive && !selfSharing;

  useEffect(() => {
    if (!tvLive) setTvExpanded(false);
  }, [tvLive]);

  useEffect(() => {
    if (!shareMenuOpen || !shareDesktop) return;
    /*
     * 候选来源分两层：
     * 1. 「此刻正在出声」的程序（最准，选它一定采得到声音）；
     * 2. 一个都没出声时，退回「所有有窗口的程序」——否则"指定应用"点下去
     *    候选为空，按钮看起来像坏了（业主实测反馈）。
     */
    void (async () => {
      const audible = await listLoopbackTargets();
      if (audible.length > 0) {
        setShareApps(audible);
        return;
      }
      const windows = await listShareWindows();
      const seen = new Set<number>();
      setShareApps(
        windows
          .filter((w) => (seen.has(w.pid) ? false : (seen.add(w.pid), true)))
          .map((w) => ({ pid: w.pid, name: w.title })),
      );
    })();
  }, [shareMenuOpen, shareDesktop]);

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

  /**
   * 每头猪最近一次被互动的时刻。
   * 不能直接用 interactions（3.2 秒就过期了）——这里单独记，供"发呆 3 分钟"
   * 的情绪气泡判断；全房动作（to="*"）不算"有人在理它"。
   */
  const lastInteractAtRef = useRef(new Map<string, number>());
  useEffect(() => {
    for (const item of interactions) {
      const { to, ts } = item.event;
      if (to === "*") continue;
      if (ts > (lastInteractAtRef.current.get(to) ?? 0)) lastInteractAtRef.current.set(to, ts);
    }
  }, [interactions]);

  /**
   * 情绪/状态用的慢时钟：5 秒一跳。动作时钟是 400ms（仅在有事发生时跑），
   * 发呆判定不需要那个精度，别让它常驻抢主线程。
   */
  const [idleTick, setIdleTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setIdleTick(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  /** 情绪气泡：被投喂够多 → ♥；很久没人理 → z z（互动气泡优先，这里让位）。 */
  const moodFor = useCallback(
    (memberId: string, feedCount: number, joinAtMs: number, asleep: boolean): "love" | "zzz" | undefined => {
      if (reactionByActor.has(memberId)) return undefined;
      if (feedCount >= 3) return "love";
      // 静音已经是"趴下睡觉"的姿势了，再叠一个 z z 气泡是重复表达
      if (asleep) return undefined;
      const last = Math.max(lastInteractAtRef.current.get(memberId) ?? 0, joinAtMs);
      return idleTick - last > IDLE_MOOD_MS ? "zzz" : undefined;
    },
    [reactionByActor, idleTick],
  );

  /** 全房动作是否正在播（蹦迪 2.6s / 烟花 3.2s）：直接看事件窗口，不做额外状态。 */
  const groupFx = useMemo(() => {
    let party = false;
    let fireworks = 0;
    for (const item of interactions) {
      if (item.event.to !== "*") continue;
      if (item.event.kind === "party") party = true;
      // 用时间戳做 key：再次触发时重新挂载 canvas，烟花从头发射
      if (item.event.kind === "fireworks") fireworks = Math.max(fireworks, item.event.ts);
    }
    return { party, fireworks };
  }, [interactions]);

  /**
   * 全房动作的冷却倒计时（秒）。
   *
   * 原来是"静默置灰 30 秒"——用户点了看不出发生了什么（尤其在系统开启
   * 「减少动态效果」时，动画被 CSS 关掉，等于零反馈），只感觉"点了没反应、
   * 而且要等好久"。现在把剩余秒数直接写在按钮上，一秒一跳。
   */
  const [coolLeft, setCoolLeft] = useState(0);
  /**
   * 截止时间单独存在 ref 里：互动事件只在 interactions 里活 3.2 秒，
   * 若把倒计时挂在事件上，事件一过期倒计时就冻住（实测冻在 27 秒）。
   */
  const groupCoolDeadline = useRef(0);
  useEffect(() => {
    let latest = 0;
    for (const item of interactions) {
      if (item.event.to === "*") latest = Math.max(latest, item.event.ts);
    }
    if (latest) {
      groupCoolDeadline.current = Math.max(groupCoolDeadline.current, latest + GROUP_INTERACT_COOLDOWN_MS);
    }
    const update = () => {
      const left = Math.max(0, Math.ceil((groupCoolDeadline.current - Date.now()) / 1000));
      setCoolLeft(left);
      return left;
    };
    if (update() === 0) return;
    const timer = window.setInterval(() => {
      if (update() === 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [interactions]);
  const groupCooling = coolLeft > 0;

  /**
   * 全房动作的即时文字反馈：不依赖任何动画，所以"减少动态效果"下同样可见。
   * 事件在 interactions 里活 3.2 秒，随之自动消失。
   */
  const groupToast = useMemo(() => {
    let latest: { kind: InteractKind; ts: number } | null = null;
    for (const item of interactions) {
      if (item.event.to !== "*") continue;
      if (!latest || item.event.ts > latest.ts) latest = { kind: item.event.kind, ts: item.event.ts };
    }
    if (!latest) return null;
    return latest.kind === "party" ? "🎉 全场蹦迪！" : "🎆 烟花绽放！";
  }, [interactions]);

  /** 场景换皮：雪原＝扔雪球，万圣夜＝丢南瓜，春节＝发红包（同位置同动作，只换标签与图标）。 */
  const interactActions = useMemo(() => {
    if (sceneTheme === "snow") {
      return INTERACT_ACTIONS.map((a) => (a.kind === "wave" ? { ...a, label: "扔雪球", Icon: Snowflake } : a));
    }
    if (sceneTheme === "halloween") {
      return INTERACT_ACTIONS.map((a) => (a.kind === "wave" ? { ...a, label: "丢南瓜", Icon: Ghost } : a));
    }
    if (sceneTheme === "spring") {
      return INTERACT_ACTIONS.map((a) => (a.kind === "wave" ? { ...a, label: "发红包", Icon: Gift } : a));
    }
    return INTERACT_ACTIONS;
  }, [sceneTheme]);

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
  /** 本次打开菜单里是否已发出好友请求（按菜单实例重置） */
  const [friendSent, setFriendSent] = useState(false);
  /** 当前面板对应成员的网络链路状态（连接中/失败时给"重新连接"入口）。 */
  const menuLinkState = audioMenu && !audioMenu.self ? mediaStates[audioMenu.peerId] : undefined;
  const [voiceOpen, setVoiceOpen] = useState(false);

  const openAudioMenu = (event: ReactMouseEvent, member: Member) => {
    event.stopPropagation();
    const audio = member.local
      ? { volume: micVolume, muted: false }
      : onGetPeerAudio(member.id);
    setFriendSent(false);
    setAudioMenu({
      peerId: member.id,
      personId: member.personId,
      ...(member.accountId ? { accountId: member.accountId } : {}),
      self: member.local,
      isHost: member.isHost,
      serverMuted: member.serverMuted ?? false,
      name: displayNames.get(member.id) ?? member.name,
      x: event.clientX,
      y: event.clientY,
      volume: audio.volume,
      muted: audio.muted,
      feedCount: member.local ? 0 : feedCounts[member.id] ?? 0,
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
                style={rangeStyle((audioMenu.volume / (audioMenu.self ? MIC_VOLUME_MAX : PEER_VOLUME_MAX)) * 100)}
                min={0}
                max={audioMenu.self ? MIC_VOLUME_MAX : PEER_VOLUME_MAX}
                step={0.01}
                value={audioMenu.volume}
                onChange={(event) => changeMenuVolume(Number(event.target.value))}
              />
              <span className="vx-member-menu-value">
                {audioMenu.muted && !audioMenu.self
                  ? "已静音"
                  : audioMenu.volume > 1
                    ? `增强 ${Math.round(audioMenu.volume * 100)}%`
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

                {/* 这条语音腿断了/还在连：给出明确状态和手动重连入口。
                    自动自愈会自己跑（5 秒宽限 + 最多 3 次重拨），这里是人肉兜底。 */}
                {menuLinkState === "connecting" || menuLinkState === "failed" ? (
                  <>
                    <div className="vx-menu-divider" />
                    <div className="vx-link-warn">
                      <span className="vx-link-warn-text">
                        {menuLinkState === "failed" ? "与 TA 的语音链路已断开" : "与 TA 的语音链路连接中…"}
                      </span>
                      <button
                        type="button"
                        className="vx-menu-btn vx-link-retry"
                        onClick={() => onRetryLink(audioMenu.peerId)}
                      >
                        <RefreshCw size={14} /> 重新连接
                      </button>
                    </div>
                  </>
                ) : null}

                {selfAccountId && audioMenu.accountId && audioMenu.accountId !== selfAccountId ? (
                  <>
                    <div className="vx-menu-divider" />
                    <button
                      type="button"
                      className="vx-menu-btn"
                      disabled={friendAccountIds?.has(audioMenu.accountId) || friendSent}
                      onClick={() => {
                        const target = audioMenu.accountId;
                        if (!target || !onAddFriend) return;
                        void onAddFriend(target).then((ok) => {
                          if (ok) setFriendSent(true);
                        });
                      }}
                      title="用账号加对方为好友（与房主/闭听权限无关）"
                    >
                      <UserPlus size={14} />
                      {friendAccountIds?.has(audioMenu.accountId)
                        ? "已是好友"
                        : friendSent
                          ? "请求已发送"
                          : "加好友"}
                    </button>
                  </>
                ) : null}

                <div className="vx-menu-divider" />
                <div className="vx-interact-row">
                  {interactActions.map(({ kind, label, Icon }) => (
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

                {/*
                  全房热闹（2026-10-22 从底栏挪进来）：蹦迪/烟花是**全房动作**，
                  不挑目标成员，所以固定用 "*"。冷却与底栏时期一致（房主 30 秒）。
                */}
                <div className="vx-menu-divider" />
                <div className="vx-interact-row">
                  <button
                    type="button"
                    className={`vx-interact-btn${groupCooling ? " vx-interact-btn-disabled" : ""}`}
                    onClick={() => {
                      onInteract("*", "", "party");
                      closeAudioMenu();
                    }}
                    disabled={groupCooling}
                    title={groupCooling ? `刚热闹过，还要等 ${coolLeft} 秒` : "全场一起跳三下（30 秒一次）——所有人都会蹦"}
                  >
                    <Music size={15} />
                    <span>{groupCooling ? `蹦迪 ${coolLeft}s` : "蹦迪"}</span>
                  </button>
                  <button
                    type="button"
                    className={`vx-interact-btn${groupCooling ? " vx-interact-btn-disabled" : ""}`}
                    onClick={() => {
                      onInteract("*", "", "fireworks");
                      closeAudioMenu();
                    }}
                    disabled={groupCooling}
                    title={groupCooling ? `刚热闹过，还要等 ${coolLeft} 秒` : "放一场全屏烟花（30 秒一次）"}
                  >
                    <Sparkles size={15} />
                    <span>烟花</span>
                  </button>
                </div>

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
                // copyText 里已经有成功/失败两条提示；这里只按真实结果决定要不要打勾
                void onCopyCode().then((ok) => {
                  if (ok) flash("code");
                });
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

          {/*
            房主铭牌公告：房主可写一句话挂在铭牌上（全房可见，随 roster/welcome 捎带）。
            访客只读；房主点击编辑，公告上的 × 只清空不改其它。
          */}          {(topic || isHost) && !topicEditing ? (
            <span
              className={`vx-topic${topic ? "" : " vx-topic-empty"}`}
              role={isHost ? "button" : undefined}
              tabIndex={isHost ? 0 : undefined}
              onClick={() => {
                if (isHost) {
                  setTopicDraft(topic);
                  setTopicEditing(true);
                }
              }}
              onKeyDown={(e) => {
                if (isHost && (e.key === "Enter" || e.key === " ")) {
                  setTopicDraft(topic);
                  setTopicEditing(true);
                }
              }}
              title={isHost ? "点击设置房间公告" : topic || undefined}
            >
              <Megaphone size={13} />
              <span className="vx-topic-text">{topic || "设公告"}</span>
              {isHost && topic ? (
                <span
                  className="vx-topic-clear"
                  role="button"
                  tabIndex={-1}
                  aria-label="清除公告"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetTopic("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.stopPropagation();
                      onSetTopic("");
                    }
                  }}
                >
                  <X size={11} />
                </span>
              ) : null}
            </span>
          ) : null}
          {topicEditing ? (
            <form
              className="vx-topic vx-topic-editing"
              onSubmit={(e) => {
                e.preventDefault();
                onSetTopic(topicDraft);
                setTopicEditing(false);
              }}
            >
              <input
                className="vx-input vx-topic-input"
                value={topicDraft}
                autoFocus
                maxLength={60}
                placeholder="今晚聊什么（一句公告）"
                onChange={(e) => setTopicDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setTopicEditing(false);
                }}
              />
              <button type="submit" className="vx-btn vx-btn-small vx-btn-primary">
                好
              </button>
            </form>
          ) : null}

          <span className={`vx-sign-conn vx-conn-${status}`}>
            <span className="vx-conn-dot" />
            {statusLabel}
          </span>

          {/*
            场景主题：个人偏好（首页右上角调色板切换），房内不再提供切换入口。
          */}

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
          {notice.kind === "error" ? (
            <button
              type="button"
              className="vx-banner-feedback"
              onClick={() => onOpenFeedback(notice.text)}
            >
              反馈此问题
            </button>
          ) : null}
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

      <main className={`vx-stage${groupFx.party ? " vx-stage-party" : ""}`} ref={stageRef}>
        {/* 全房动作的文字反馈：不依赖动画，"减少动态效果"下也一定看得见 */}
        {groupToast ? (
          <div className="vx-group-toast" role="status">
            {groupToast}
          </div>
        ) : null}
        {/* 全屏烟花：Canvas 粒子（升空 → 绽放 → 熄灭），播完自动停 rAF */}
        {groupFx.fireworks ? <Fireworks key={groupFx.fireworks} /> : null}
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
              party={groupFx.party}
              mood={moodFor(
                member.id,
                member.local ? 0 : feedCounts[member.id] ?? 0,
                joinAt.get(member.id) ?? 0,
                member.muted,
              )}
              entryAt={joinAt.get(member.id)}
              followEnabled={!isHost}
              feedCount={member.local ? 0 : feedCounts[member.id] ?? 0}
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
          onExpand={() => {
            setTvExpanded(true);
            // 点开才要满码率：共享者那边按这个把这一路升上去
            onWatchScreen("watch");
          }}
        />

        {tvExpanded && screenShare ? (
          <PenTvLightbox
            state={screenShare}
            stream={shareStream}
            pc={sharePc}
            sharerName={displayNames.get(screenShare.sharerId) ?? "成员"}
            viewMode={shareViewMode}
            onViewMode={onSetShareViewMode}
            latency={shareLatency}
            onLatency={onSetShareLatency}
            isSharer={selfSharing}
            onClose={() => {
              setTvExpanded(false);
              // 关灯箱退回缩略档：剩下的画面只是小幕布上的缩略图
              onWatchScreen("preview");
            }}
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
              // 没检测到麦时点它什么也不会发生，禁用比骗人好（评审 #1）
              disabled={(self?.serverMuted ?? false) || self?.hasMic === false}
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
              {muted || self?.hasMic === false ? <MicOff size={20} /> : <Mic size={20} />}
              <span>
                {self?.serverMuted
                  ? "已禁言"
                  : self?.hasMic === false
                    ? "未接麦"
                    : muted
                      ? "已静音"
                      : "麦克风开"}
              </span>
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
          aria-haspopup="menu"
          aria-expanded={selfSharing ? undefined : shareMenuOpen}
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
            <div className="vx-share-qgrid">
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
                  <span>
                    {preset.fps}fps · {Math.round(preset.maxBitrate / 1000)}k
                  </span>
                </button>
              );
            })}
            </div>
            <p className="vx-share-menu-title">共享声音</p>
            {/* 原来这两组用 "?" 气泡解释，但菜单为了不顶出屏幕改成了可滚动，
                绝对定位的气泡会被裁掉（业主实拍：只剩一条深色块）。改成常显一行短说明。 */}
            <p className="vx-share-menu-hint">
              自动：采整机声音并排除本应用语音（游戏、浏览器、音乐都能录到）
            </p>
            {shareDesktop ? (
              <>
                {/* 三选一做成一行小胶囊：两列网格放三项会剩一个单独换行，
                    菜单也被撑高到看不见顶（业主实拍反馈） */}
                <div className="vx-share-tri" role="radiogroup" aria-label="共享声音来源">
                  {(
                    [
                      { key: "off", name: "不带", tip: "只共享画面，不采集任何声音" },
                      { key: "auto", name: "自动", tip: "整机声音，排除本应用语音（最稳，游戏/浏览器/音乐都能录到）" },
                      { key: "app", name: "指定", tip: "只采某一个程序（精确隔离；部分游戏抓不到声音）" },
                    ] as const
                  ).map((item) => {
                    const on =
                      item.key === "off"
                        ? !shareAudio
                        : shareAudio && (item.key === "auto" ? shareAppPid === null : shareAppPid !== null);
                    return (
                      <button
                        key={item.key}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        title={item.tip}
                        className={`vx-share-quality${on ? " vx-share-quality-on" : ""}`}
                        onClick={() => {
                          if (item.key === "off") {
                            onSetShareAudio(false);
                            onSetShareAppPid(null);
                            return;
                          }
                          onSetShareAudio(true);
                          if (item.key === "auto") {
                            onSetShareAppPid(null);
                            return;
                          }
                          /*
                           * 切到「指定应用」一定得落一个具体 pid，否则这一项在
                           * 界面上等于没选中（原来列表为空时点了毫无反应，
                           * 就是"按钮用不了"的现场）。没有候选就退而求其次，
                           * 用当前进程列表的第一项；还空就保持原状不再骗人。
                           */
                          const first = shareApps[0];
                          // -1 = "指定，但还没选到程序"：让胶囊能高亮、并显示缺候选的提示，
                          // 而不是点了像没反应（业主反馈"这个按钮根本用不了"）
                          onSetShareAppPid(first ? first.pid : -1);
                        }}
                      >
                        <strong>{item.name}</strong>
                      </button>
                    );
                  })}
                </div>
                {shareAudio && shareAppPid !== null && shareApps.length === 0 ? (
                  <p className="vx-share-menu-hint">
                    没检测到可采集的程序：先让游戏/视频出点声，再重新打开本菜单
                  </p>
                ) : null}
              </>
            ) : (
              <p className="vx-share-menu-hint">网页版只能采整机声音；要"只共享某个应用的声音"请用桌面客户端</p>
            )}
            {shareDesktop && shareAudio && shareAppPid !== null ? (
              <select
                className="vx-input"
                value={shareAppPid > 0 ? String(shareAppPid) : ""}
                onChange={(event) => onSetShareAppPid(event.target.value ? Number(event.target.value) : null)}
              >
                {/* 这一项原来指向"自动"，选完 pid 变 null，整个下拉连带自己消失；
                    切回自动请点上方的"自动"胶囊 */}
                <option value="" disabled>
                  选择一个程序…
                </option>
                {shareApps.map((app) => (
                  <option key={app.pid} value={String(app.pid)}>
                    {app.name}
                  </option>
                ))}
                {/* 上次选过但这个程序此刻没出声：仍然保留它，避免选项跳空 */}
                {shareApps.every((app) => app.pid !== shareAppPid) ? (
                  <option value={String(shareAppPid)}>上次选择的应用（此刻没出声）</option>
                ) : null}
              </select>
            ) : null}
            <p className="vx-share-menu-title">共享方式</p>
            {/*
              原来这段话挂在"?"气泡里：一是读不到（菜单可滚动后气泡被裁），
              二是写的是"观众 ≤4 走直连"，与 autoTransportFor 的 ≤2 不符（业主评审确认）。
              改成常显一行，并只讲取舍不复述阈值——阈值由下面那句"将走…"按真实人数给出。
            */}
            <p className="vx-share-menu-hint">
              自动：观众多时改走转发，省自家上行；直连画质最好但吃上行
            </p>
            <div className="vx-share-tri" role="radiogroup" aria-label="共享方式">
              {(
                [
                  { key: "auto", name: "自动", tip: "按观众数选直连/转发" },
                  { key: "p2p", name: "直连", tip: "直连：画质最好、延迟最低" },
                  { key: "sfu", name: "转发", tip: "转发：连接成功率高，多人更省上行" },
                ] as const
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="radio"
                  aria-checked={shareTransport === item.key}
                  title={item.tip}
                  className={`vx-share-quality${shareTransport === item.key ? " vx-share-quality-on" : ""}`}
                  onClick={() => onSetShareTransport(item.key)}
                >
                  <strong>{item.name}</strong>
                </button>
              ))}
            </div>
            <p className="vx-share-menu-hint">
              {(() => {
                const decision = autoTransportFor(shareTransport, members.length);
                const viewers = Math.max(0, members.length - 1);
                if (decision.transport === "sfu") {
                  return `将走转发 · ${viewers} 位观众 · 不占你家上行（由服务器分发）`;
                }
                const perViewer = Math.round(perViewerBitrate(shareQuality, viewers) / 1000);
                return `将走直连 · ${viewers} 位观众 · 每人约 ${perViewer} Mbps（合计约 ${perViewer * Math.max(1, viewers)} Mbps 上行）`;
              })()}
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

      <aside className={`vx-chat${chatOpen ? " vx-chat-open" : ""}`} aria-hidden={!chatOpen}
          inert={!chatOpen}>
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
