import { Peer } from "peerjs";
import type { DataConnection, MediaConnection } from "peerjs";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
// RNNoise 的 worklet 脚本与 wasm（Vite 以 ?url 产出带哈希的静态资源）。
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

import {
  GROUP_INTERACT_COOLDOWN_MS,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  HOST_SILENCE_TIMEOUT_MS,
  MAX_MEMBERS,
  ROOM_CODE_LEN,
  WELCOME_TIMEOUT_MS,
  buildInviteUrl,
  decideAdmission,
  guestPeerId,
  hostPeerId,
  hostPeerIdForCode,
  isGroupInteractKind,
  isRoomCode,
  isValidPeerId,
  makeRoomCode,
  normalizeCode,
  parseGuestMessage,
  parseHostMessage,
  randomIndex,
  randomToken,
  rejectText,
  signGuestProof,
  signHostProof,
  shouldReportWelcomeTimeout,
  verifyHostProof,
  type Invite,
  type HostMessage,
  type InteractEvent,
  type InteractKind,
  type PenPose,
  type ScreenSharePublication,
  type ScreenWatchState,
  type ScreenShareState,
  type ScreenViewPreference,
  type WireMember,
} from "./protocol";
import { applyAudioProfile, opusSdpTransform } from "./audio-profile";
import { forgetAutoplayElement, onAutoplayBlocked } from "./media-unlock";
import { backgroundTimerMode } from "./background-ticker";
import { sessionScopedId, type Identity } from "./identity";
import {
  RESOLUTION_LADDER_LABEL,
  boostScreenOfferSdp,
  createJitterBufferTuner,
  createScreenSenderTuner,
  applyScreenSenderParams,
  healScreenConnection,
  jitterTargetFor,
  perViewerBitrate,
  probeHardwareEncoders,
  screenHintFor,
  type HardwareCodecProbe,
  type ScreenSenderTuner,
  type ShareLatency,
  type ShareQuality,
  type TunePoint,
} from "./screen-share";
import { NPC_NAME, PenDirector, VEGETABLE_KINDS, type PenEvent } from "./pen";
import { readPenSnapshots } from "./pen-registry";
import {
  SOUND_NOTES,
  shouldPlaySound,
  type SoundEvent,
  type SoundKind,
} from "./sounds";
import { Timers } from "./timers";
import { VoiceActivityDetector } from "./voice-activity";
import type { AudioProcessing, VoiceSettings } from "./settings";
// 音量上限（值导入）：UI、持久化、引擎共用一份，见 settings.ts 的说明
import { MIC_VOLUME_MAX, PEER_VOLUME_MAX } from "./settings";
import { bindSpeaker, openMic, resumeAudio } from "./devices";
import { ensureIceServers, iceServers } from "./ice";
import { latestChangelog } from "./changelog";
import { isTauriRuntime } from "./loopback";
import { SessionStatsRecorder, STATS_SAMPLE_SEC, type SessionSummary } from "./session-stats";

/*
 * ICE 配置已迁到 ./ice.ts（STUN 兜底 + 由服务端 /ice 签发 Cloudflare TURN 短期凭据）。
 *
 * 为什么必须搬走：这里原先写死的是 OpenRelay 的公开静态凭据，而该服务已关停
 * （openrelay.metered.ca 现解析到 192.0.2.1，RFC 5737 的不可路由黑洞地址）。
 * 后果不是"限速"，而是**任何需要中继的组合都彻底建不起连接**——
 * 表现为"同机能进、跨网怎么都进不去"。同时长密钥写死在前端本身也不该做。
 *
 * 仍然成立的三条前提（对应"同设备有声、跨网无声"）：
 * - 同一台设备两端走 host candidate（本机 / 局域网地址），不碰 STUN/TURN，必通；
 * - 跨网要先靠 STUN 拿到公网映射地址（srflx）才有打洞的资格。Google STUN 在大陆
 *   基本不可用，所以兜底表里补了 miwifi / bilibili 两个国内可达的；
 * - 对称 NAT / 公司网 / 校园网 / 运营商 CGNAT 靠 STUN 打不通，**必须**有 TURN。
 *   这正是这次要修的那一环。
 */

/**
 * 信令服务器线路（按顺序尝试）。
 *
 * 背景（2026-10-15 测试者实测）：PeerJS 客户端默认连 `wss://0.peerjs.com/peerjs`，
 * 部分网络直达不了（校内网/公司网/代理规则/DNS 污染），报错就是"没能进入房间"。
 * 而这些网络通常**能打开本站**，所以第一条线路借我们自己的域名（Worker 里
 * `/peerjs*` 做了透明转发，协议不变）；**最后一条走直连**，万一我们的中转
 * 出问题也不至于全断。本地开发没有 Worker，直接用直连。
 */
const SIGNAL_ROUTES: { host: string; port: number; secure: boolean; key: string; label: string }[] = import.meta.env.DEV
  ? [{ host: "0.peerjs.com", port: 443, secure: true, key: "peerjs", label: "peerjs-cloud" }]
  : [
      { host: "5blong.pages.dev", port: 443, secure: true, key: "peerjs", label: "own-domain" },
      { host: "0.peerjs.com", port: 443, secure: true, key: "peerjs", label: "peerjs-cloud" },
    ];

/** 信令瞬时失败的换连接重试：次数与退避（毫秒）。 */
const SIGNAL_RETRY_ATTEMPTS = 3;
const SIGNAL_RETRY_BACKOFF_MS = 700;
/** openPeer 的返回值之一：换连接重试（不是给用户看的文案）。 */
const SIGNAL_RETRY = "retry-signal";

/**
 * 信令连接的**瞬时**失败要不要重试。
 *
 * 公共 PeerJS 云（0.peerjs.com）偶发抖动很正常；这类错误发生时连接还没建立，
 * 换一条连接往往立刻就好。**以前这里直接判死**（只给"网络不稳定"四个字、没有重试），
 * 2026-10-15 有测试者卡在这一步 —— 现在交给调用方换连接重试。
 *
 * 注意 `peer-unavailable`（房主不在线）**不在**此列：那是确定性结论，重试只拖时间。
 */
export function isRetryableSignalingError(type: string): boolean {
  return type === "network" || type === "socket-error" || type === "socket-closed";
}

/**
 * 访客首次加入时的"整体重拨"次数。
 * 公共 PeerJS 云免费、信令延迟波动大（实测 4~35 秒），一次 welcome 超时
 * 不代表房主不在线：销毁 Peer、换新访客 ID 重拨，常常一次就通。
 * 全部尝试都失败才提示"房主没有响应"。
 */
const MAX_DIAL_ATTEMPTS = 3;
/**
 * 进房成功之后，与房主的连接掉线时最多自动重连几次。
 * 房主正常结束房间时，重连也会很快失败（信令层找不到房主），不会让用户久等。
 */
const MAX_RECONNECT = 2;
/** 进房后断线重连时，等房主 welcome 的超时（比首次加入短，失败尽快让用户知道）。 */
const RECONNECT_WELCOME_MS = 7000;
/**
 * 访客之间媒体协商的错峰间隔。
 * 新人进房时若立刻向所有成员发起媒体协商，会在几秒内产生几十条信令，
 * 把公共云的消息队列打爆，反而把后续访客的进房握手拖过超时。
 * 与房主的媒体连接仍然立即建立，访客间逐个错峰。
 */
const MEDIA_STAGGER_MS = 1200;

/**
 * 语音腿自愈参数。
 *
 * 背景：语音是 mesh，每一对成员之间各有一条独立连接。某一条腿断了，
 * 别人照样听得到那个人，只有你听不到——这正是 2026-10-19 线上遇到的问题。
 * 原先只监听 ICE 状态、不自愈，"断开"会永远停在"连接中"。
 *
 * 为什么是重拨而不是 restartIce：PeerJS 的 MediaConnection 不支持重协商，
 * restartIce 产生的新 ufrag 没法再走一遍 offer/answer，实测不可靠；
 * 关掉旧 call 重新 peer.call() 才能真的重建链路。
 */
/** 掉线判定宽限：ICE disconnected 常常几秒内自恢复，先等再动手。 */
const VOICE_HEAL_GRACE_MS = 5000;
/** 重拨后的观察窗：这么久还没连上就进入下一轮。 */
const VOICE_HEAL_RETRY_MS = 6000;
/** 最多重拨几次（含让位给对侧的那一轮）。到顶就停在 failed，交给用户手动重试。 */
const VOICE_HEAL_MAX = 3;
/** 非发起侧先等这么久，把首轮重拨让给 myId 较小的一侧，避免双方同时拨。 */
const VOICE_HEAL_PEER_DELAY_MS = 2500;
/**
 * 建链超时：ICE 一直停在 checking（对端 NAT 不通、UDP 被墙、TURN 不可用）时，
 * 浏览器可能要几十秒才报 failed，而"连接中"会一直卡着——实测线上就卡在这里。
 * 超过这个时间还没连上，就当作失败，直接进入重拨。
 */
const VOICE_CONNECT_TIMEOUT_MS = 9000;
/**
 * 语音流停滞判定（兜底用，不是主力）。
 *
 * 为什么不能判得太急：FPS 游戏里"几十秒不说话"完全正常。对端若启用了
 * Opus 的 DTX（静音不发包），我们的 18 秒阈值会把**健康链路**判成故障并重拨——
 * 重拨那几秒本身就会"突然没声音"，等于我们制造了故障。
 *
 * 现在的口径：
 * - 看**收包数**（packetsReceived）而不是字节数——静音帧很小，但包数是硬的；
 * - 阈值放宽到 8 次 × 6 秒 ≈ 48 秒：足够跨过一整段静默，又能在真出问题时兜住；
 * - 链路真断（ICE failed/disconnected）由 ICE 判定负责，不靠这里；
 *   这里只负责"ICE 还显示连接、但媒体确实死了"这种假绿。
 */
const MEDIA_FLOW_POLL_MS = 6000;
const MEDIA_FLOW_STALL_LIMIT = 8;

export type EngineStatus =
  | "idle"
  | "preparing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type EndReason = "host-left" | "rejected" | "network" | "closed";

export interface Member {
  id: string;
  personId: string;
  /** 会话级短标识，用于同人多窗口时的重名消歧。 */
  sessionId: string;
  name: string;
  avatar: string;
  color: string;
  muted: boolean;
  hasMic: boolean;
  isHost: boolean;
  local: boolean;
  /** 被房主强制禁言（本人无法自行解除）。 */
  serverMuted?: boolean;
  /** 是否闭听（戴耳罩，闭听时一定静音）。 */
  deafened?: boolean;
  /** 该端是否报了 AV1 **硬件解码**（决定共享者能不能上 AV1；缺省 = 不能）。 */
  av1Decode?: boolean;
  /**
   * 对方账号 ID（8 位，可选）。只用于「加好友」按钮——未登录 / 旧客户端没有，
   * **不参与任何进房或权限判断**。
   */
  accountId?: string;
}

export interface ChatMessage {
  id: string;
  name: string;
  text: string;
  ts: number;
  self: boolean;
}

export interface EngineEvents {
  status: (status: EngineStatus, detail?: string) => void;
  members: (members: Member[]) => void;
  speaking: (ids: string[]) => void;
  chat: (message: ChatMessage) => void;
  ended: (reason: EndReason, detail?: string) => void;
  /** 房间已就绪时回调，用于拿到邀请信息。 */
  ready: (invite: Invite) => void;
  /** 猪圈里发生了一件事（房主广播，含房主自己）。 */
  pen: (event: PenEvent) => void;
  /** 房主广播的权威猪位快照（访客据此平滑跟随；房主端不会收到）。 */
  penPoses?: (poses: PenPose[], ts: number) => void;
  /** 房间标志变化（例如是否上锁）。 */
  roomFlags: (flags: { locked: boolean }) => void;
  /** 成员间的小猪互动（戳一戳 / 打招呼 / 投喂）。 */
  interact: (event: InteractEvent) => void;
  /** 该响一声提示音（房主统一广播，这样全房间同时听到）。 */
  sound: (event: SoundEvent) => void;
  /**
   * 某个成员的音频被浏览器拦下了、没能播放。
   * 界面必须让用户知道并能一键恢复，否则就是"别人说话我听不见"。
   */
  playbackBlocked: (peerId: string, detail: string) => void;
  /**
   * 自己这边的麦克风有问题（音频引擎没跑起来 / 轨道被静音）：
   * 不发这条事件的话，表现就是"别人听不见我，但我这边一切正常"。
   */
  micProblem?: (detail: string) => void;
  /**
   * 成员进出房间（带名字）。
   *
   * 原来的提示只有一声提示音，视觉上只有 `1/8` 悄悄变成 `2/8`——
   * 房主在别的窗口时很容易错过，不知道有人进来了。
   * 现在额外发一条带名字的事件，界面可以用提示条明说"XXX 进圈了"。
   */
  rosterChange: (change: { kind: "join" | "leave"; name: string }) => void;
  /**
   * 与某个成员的媒体 P2P 连接状态变化，用于界面区分"直连 / 中继 / 连不通"。
   */
  mediaState: (peerId: string, state: MediaLinkState) => void;
  /** 房主铭牌公告变化（房主本地修改与访客收到广播都会触发；空串 = 清除）。 */
  topic?: (text: string) => void;
  /**
   * 屏幕共享状态变化（房主权威广播；null = 停播，电视回雪花）。
   * **与语音链路完全隔离**：这条回调的实现里绝不允许碰音频/PeerJS 媒体。
   */
  screenShare?: (state: ScreenShareState | null) => void;
  /**
   * 观众端收到共享者的 P2P 直连画面流（仅 P2P 模式；SFU 模式走订阅）。
   * 实现里同样不碰音频链路，只把流交给界面。
   */
  screenStream?: (stream: MediaStream, call: MediaConnection) => void;
}

/** 与单个成员的媒体连接状态（供界面诊断跨网无声）。 */
export type MediaLinkState = "connecting" | "connected" | "relay" | "failed";

interface GuestRecord {
  conn: DataConnection;
  member: Member;
  nonce: string;
  lastSeen: number;
  joined: boolean;
  /** 同 ID 断线重连（此前已在房间对外宣布过），重连不再播加入提示音。 */
  rejoined?: boolean;
}

/**
 * 语音活动判定的参数与实现都搬到了 `voice-activity.ts`（纯逻辑，可单测）。
 * 这里只保留"多久采一次、多久上报一次"这两个调度参数。
 */
/** 采样间隔：越小起音越跟得上（原来的 120ms 是延迟的主要来源之一）。 */
const SPEAKING_POLL_MS = 50;
/** 收音上报的最小间隔，避免闪烁把动画打得乱跳；起音不节流。 */
const SPEAKING_EMIT_MS = 100;

let rnnoiseWarmed = false;
/**
 * 预热 AI 降噪（RNNoise）的 worklet/wasm 资源：App 一打开就静默预取
 * （不需要麦克风权限），进房开启智能降噪时秒生效，不用现场下 ~300KB。
 * 采集约束（回声消除/自动增益）按 Web 标准只能在采集激活时生效，
 * 无法在页面打开时"预设"——这个预热只管降噪资源本身。
 */
export function preloadRnnoise(): void {
  if (rnnoiseWarmed || typeof fetch === "undefined") return;
  rnnoiseWarmed = true;
  void fetch(rnnoiseWasmUrl, { cache: "force-cache" }).catch(() => {});
  void fetch(rnnoiseSimdWasmUrl, { cache: "force-cache" }).catch(() => {});
  void fetch(rnnoiseWorkletUrl, { cache: "force-cache" }).catch(() => {});
}

/*
 * 猪位广播用 Worker 计时：浏览器会把后台标签页的 setInterval 节流到
 * 一分钟一次（5 分钟后），而 Worker 的计时器不受节流——房主切后台，
 * 访客依然每 600ms 收到猪位，画面不会冻结。
 */
let stopPoseTicker: (() => void) | null = null;
function startPoseTicker(onTick: () => void): void {
  stopPoseTicker?.();
  if (typeof Worker === "undefined") {
    // 单测 / 无 Worker 环境：退化为普通定时器
    const id = setInterval(onTick, 50);
    stopPoseTicker = () => clearInterval(id);
    return;
  }
  const source =
    "let t=null;onmessage=(e)=>{if(e.data==='start'&&!t)t=setInterval(()=>postMessage(0),600);" +
    "if(e.data==='stop'&&t){clearInterval(t);t=null;}}";
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
  worker.onmessage = () => onTick();
  worker.postMessage("start");
  stopPoseTicker = () => worker.terminate();
}
/*
 * 心跳用 Worker 计时，理由与猪位广播相同，但后果更严重：
 * 主线程定时器在页面隐藏时会被节流到约一分钟一次，而房主收不到 ping
 * 就会把人移出房间——"切出去看个消息回来就被踢"就是这个原因。
 */
let stopHeartbeatTicker: (() => void) | null = null;
function startHeartbeatTicker(onTick: () => void): void {
  stopHeartbeatTicker?.();
  if (typeof Worker === "undefined") {
    const id = setInterval(onTick, HEARTBEAT_MS);
    stopHeartbeatTicker = () => clearInterval(id);
    return;
  }
  const source =
    `let t=null;onmessage=(e)=>{if(e.data==='start'&&!t)t=setInterval(()=>postMessage(0),${HEARTBEAT_MS});` +
    "if(e.data==='stop'&&t){clearInterval(t);t=null;}}";
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
  worker.onmessage = () => onTick();
  worker.postMessage("start");
  stopHeartbeatTicker = () => worker.terminate();
}
function stopHeartbeatTickerFn(): void {
  stopHeartbeatTicker?.();
  stopHeartbeatTicker = null;
}

function stopPoseTickerFn(): void {
  stopPoseTicker?.();
  stopPoseTicker = null;
}

export class VoiceMesh {
  private peer: Peer | null = null;
  private localStream: MediaStream | null = null;

  private hosting = false;
  private myId = "";
  private hostId = "";
  private code = "";
  private roomKey = "";
  private me: Member | null = null;
  private joined = false;

  private guests = new Map<string, GuestRecord>();
  private members = new Map<string, Member>();
  private hostConn: DataConnection | null = null;

  private calls = new Map<string, MediaConnection>();
  /**
   * 每条语音腿的自愈状态（按 peerId）。
   * timer=0 表示没有在等待；attempts 到顶后不再自动重拨，交给用户手动重试。
   */
  private readonly voiceHeals = new Map<string, { attempts: number; timer: number }>();
  private audio = new Map<string, HTMLAudioElement>();
  /**
   * 临时压低"房间语音播放"的系数（1 = 不压低）。
   *
   * 用途：共享声音回退到整机回环时（老系统拿不到进程级采集），
   * 共享音频里会含房间语音 → 观众听到回声。压到 15% 后那一路几乎不可闻，
   * 共享者仍能听清别人说话的关键信息。
   */
  private duckFactor = 1;
  private monitors = new Map<string, Monitor>();
  private speaking = new Set<string>();

  private ctx: AudioContext | null = null;
  /** statechange 监听只注册一次，避免每次重建发送链都叠加。 */
  private ctxWatched = false;
  /** 各语音腿的 inbound 字节采样，用于发现"连着但没数据"。 */
  private readonly flowSamples = new Map<
    string,
    { packets: number; acks: number; stalls: number; sawPackets: boolean }
  >();
  private micEndedNotified = false;
  /** 每条腿最近一次"确实收到 RTP 音频"的时间，用于判活时豁免。 */
  private readonly lastMediaAt = new Map<string, number>();
  /**
   * 单向不通计数：ICE 通了、对方也有麦，但**累计收包恒为 0**。
   *
   * 为什么必须单独记（2026-10-22 业主现场）：ab/cd 都正常，
   * "a 听不到 e、e 却听得到 a" —— 这是 typo 层面看不见的**半条腿**。
   * 原来的判活规则是"任一方向有进展就算活"，而 e 收 a 正常时会持续回 RTCP，
   * 于是 a 这边 acks 一直在涨 → 判成健康 → 永不重拨，一直没声音。
   */
  private readonly inboundZeroPolls = new Map<string, number>();
  /**
   * 播放链失效计数：**包还在到**，但我这边出不了声。
   *
   * 现场症状："突然某一个人没声音了，可别人都听得见他。"
   * RTP 一直在到（getStats 里 inbound 包在涨），所以任何"看包"的判据都判它健康；
   * 真正坏的是本机的播放链——<audio> 被浏览器暂停/清空 srcObject（换音频设备、
   * 系统睡眠恢复、输出设备被拔出都会这样），而 srcObject 只在 stream 事件里设一次，
   * 不会自己恢复。这里靠"元素是否还在播"来发现并重建。
   */
  private readonly playbackMisses = new Map<string, number>();
  /** 每一路最近一次收到的远端流（播放链重建时要重新接一遍）。 */
  private readonly remoteStreams = new Map<string, MediaStream>();
  /** 兜底补拨的节流时间戳（每成员 5 秒最多一次）。 */
  private readonly lastDialAt = new Map<string, number>();
  /** 本地诊断事件环形缓冲（最多 300 条，导出诊断包时带上）。 */
  private readonly diagLog: { at: string; kind: string; detail: string }[] = [];
  private dialWatchTimer = 0;
  private mediaFlowTimer = 0;
  /** 所有定时器的登记表（按 interval / timeout 分开，各自用对应的 clear）。 */
  private readonly timers = new Timers();
  private heartbeatTimer = 0;
  private speakingTimer = 0;
  private speakingEmitAt = 0;
  /** 被节流时安排的"补发"定时器，保证停止事件不会丢。 */
  private speakingEmitTimer = 0;
  /** 上一次语音采样的时刻，用来算与帧率无关的平滑系数。 */
  private lastSpeakingPollAt = 0;
  private memberEmitQueued = false;

  /** 上一次播放各类提示音的时刻，用来做节流。 */
  private lastSoundAt = new Map<SoundKind, number>();
  /** 猪圈导演，只有房主使用（事件必须所有人看到，所以由房主统一产出）。 */
  private readonly pen = new PenDirector();
  /** 各端上报的猪的横向位置（0~1），用来挑最近的猪去吃菜。 */
  private penActorX = new Map<string, number>();
  /** 各猪最近上报的纵深（0=最远 1=最近），仅本机视图用。 */
  private penActorLane = new Map<string, number>();
  /**
   * 全房动作（蹦迪/烟花）上一次成功分发的时刻，房主权威限流。
   * 这类动作全房同时看到，不限流就会被刷屏；30 秒一次足够"暖场"用。
   */
  private lastGroupInteractAt = 0;
  /**
   * 等待 welcome 的超时定时器。
   * 必须在收到 welcome 时清掉：否则进房成功 8 秒后它照样触发，
   * 界面会显示"连接失败"，但人其实一直在房间里（实测就是这么个怪现象）。
   */
  private welcomeDeadline = 0;

  private hostLastSeen = 0;
  private reconnectAttempt = 0;
  /**
   * 首次加入过程中已进行的整体重拨次数（每次 welcome 超时 +1）。
   * 与 reconnectAttempt 区分：后者用于进房成功之后的断线重连。
   */
  private dialAttempts = 0;
  /** 房间是否已上锁（仅房主有意义）。 */
  private locked = false;
  /**
   * 屏幕共享状态（房主权威；一台电视，同时最多一个共享者）。
   * 只是房间状态上的一个可空字段——成员表、语音、媒体连接都不读它。
   */
  private screenShareState: ScreenShareState | null = null;
  /**
   * 本机硬件编解码预检（WebCodecs，进程内缓存）。
   *
   * 用途有二：① 加入房间时把"本机支持 AV1 硬解吗"报给房主/全员（hello 与 roster
   * 的 av1Decode 字段）；② 自己开共享时判断能不能上 AV1（还要求**所有观众**都支持）。
   */
  private hwProbe: HardwareCodecProbe | null = null;
  /** 预检的并发去重（host/join 与 sendHello 都可能会要）。 */
  private hwProbePromise: Promise<HardwareCodecProbe> | null = null;
  /** 本机是否支持 AV1 硬解（join 前探一次；没探到 = false）。 */
  private myAv1Decode = false;
  /** 各观众对当前共享会话的画质偏好（key = 成员 id）。 */
  private viewerScreenPrefs = new Map<string, ScreenViewPreference>();
  /** 本机作为观众时选的画质偏好（点了"清晰优先/流畅优先"后本地留着）。 */
  private localScreenPref: ScreenViewPreference = "auto";
  /**
   * P2P 观众端的自适应抖动缓冲停止函数（按连接记录）。
   * 原先是开播时设一次固定的 600ms，同城嫌大、跨城可能不够。
   */
  private viewerJitters = new WeakMap<MediaConnection, () => void>();
  /** 本机是否闭听（deaf：同时闭麦且不听任何人）。 */
  private deafened = false;
  /** 是否正在等房主的 welcome（用于断线重连时的超时判定）。 */
  private awaitingWelcome = false;
  /** 正在进行进房后的断线重连（防止心跳超时与 close 事件重复触发）。 */
  private reconnecting = false;
  private destroyed = false;
  /**
   * 与 sendHello 配对保存的 nonce，用于校验 welcome 里的房主证明。
   *
   * 必须和其他字段一起声明在类顶部：tsconfig 开了 useDefineForClassFields，
   * 字段按声明顺序在构造时初始化；如果声明在方法后面，方法里访问到的会是
   * undefined，抛出的 TypeError 又会被 `void this.sendHello(conn)` 吞掉，
   * 表现为"访客连上了却一直进不去"。
   */
  private nonces = new Map<DataConnection, string>();

  // ------------------------------------------------- 发送侧音频处理链
  /** 经过降噪/增益处理后真正发给同伴的流（来自 MediaStreamAudioDestination）。 */
  private outgoingStream: MediaStream | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private nsNode: AudioWorkletNode | null = null;
  private micGainNode: GainNode | null = null;
  /** 发送链尾部的软限幅（见 buildOutgoing 注释）。 */
  private micLimiterNode: DynamicsCompressorNode | null = null;
  /**
   * 每个成员的本地收听增益链：source → gain → limiter → MediaStreamDestination
   * → <audio>（element.volume 固定 1）。
   *
   * 为什么不用 element.volume：`HTMLMediaElement.volume` 合法区间只有 0~1，
   * **超过 100% 会被浏览器拒绝**——于是"把对方音量拉到 200%"这个功能一直是假的
   * （2026-10-15 业主实测：对方麦小、拉满也没用）。Web Audio 的 GainNode 没有
   * 这个限制，后面串一个 DynamicsCompressor 当软限幅，>100% 时也不会硬削爆音。
   */
  private peerChains = new Map<
    string,
    { source: MediaStreamAudioSourceNode; gain: GainNode; limiter: DynamicsCompressorNode | null; dest: MediaStreamAudioDestinationNode }
  >();
  /**
   * 远端流的"泵"元素（静音、不出声）。
   *
   * ⚠️ 2026-10-16 全员无声事故的根因（Chromium 已知缺陷
   * issues.chromium.org/40094084）：**远端** WebRTC 音频流若只接进 WebAudio
   * （createMediaStreamSource→…→MediaStreamDestination→<audio>），而原始流
   * 没有被任何 media element 消费，Chromium 就不会去"拉动"解码器——表现是
   * RTP 包照常到达、getStats 里 energy=0、MediaStreamAudioSourceNode 读到的
   * 全是零样本静音，于是**双向都听不到对方**。本地采集流没有这个问题，
   * 所以发送链（麦克风）一直正常， receiving 链全军覆没。
   *
   * 修复＝把原始远端流同时挂到一个 muted 的 audio 元素上并 play()，
   * 让浏览器的 WebRTCAudioRenderer 开始 pull；增益链照常出声，泵元素静音
   * 不会重复出声（业界标准做法，Cacophony 等库同款）。
   * 必须持有引用（Map），否则元素被 GC 后拉动又会停止。
   */
  private pumpEls = new Map<string, HTMLAudioElement>();
  private outDestNode: MediaStreamAudioDestinationNode | null = null;
  private nsEnabled = false;

  /** 每个成员的本地收听音量（0..1）与本地静音，只影响本机。 */
  private peerVolumes = new Map<string, number>();
  private peerMuted = new Set<string>();
  /** 当前选定的扬声器设备（空串 = 系统默认）。创建远端元素时按它绑定。 */
  private speakerDeviceId = "";

  constructor(private readonly events: EngineEvents) {}

  // ---------------------------------------------------------------- 公共 API

  get roomCode(): string {
    return this.code;
  }

  /** 是否已经真正进入房间（房主 = 身份注册成功；访客 = 握手通过并获得名册）。 */
  get isJoined(): boolean {
    return this.joined;
  }

  get isHost(): boolean {
    return this.hosting;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get isDeafened(): boolean {
    return this.deafened;
  }

  get invite(): Invite | null {
    if (!this.hosting || !this.code || !this.hostId) return null;
    return { code: this.code, hostId: this.hostId, roomKey: this.roomKey };
  }

  /**
   * 房主建房。房间码冲突时自动换码重试。
   *
   * `prefer` 用于"恢复上次的房间"：第一次尝试用指定房号（房主 peer id 由房号推导，
   * 断开后是空的，能重新占回来），钥匙沿用旧的，老邀请链接才不会失效。
   * 指定房号被别人占了就退回随机房号——不会卡死。
   */
  async host(
    identity: Identity,
    settings: VoiceSettings,
    muted: boolean,
    prefer?: { code?: string; roomKey?: string },
  ): Promise<void> {
    if (this.destroyed) return;
    this.hosting = true;
    /*
     * 房主权威猪位广播：房主本地在模拟所有猪（每个 PigActor 都在上报），
     * 定期把这些位置播给访客，让全房看到的是同一片猪圈。
     * 用 Worker 计时驱动（后台不被节流）。
     */
    startPoseTicker(() => this.broadcastPoses());
    // 这里仍在用户点击的手势里，趁机解锁音频（否则远端流到达时会被自动播放策略拦下）
    this.unlockAudio();
    this.events.status("preparing");
    await this.acquireMic(settings, muted);
    await this.buildOutgoing(settings);
    this.loadPeerAudioSettings(settings);
    // PeerJS 只在构造 Peer 那一刻读 config，所以 TURN 凭据必须在这之前就绪。
    // 超时上限 2.5s，拿不到就先用纯 STUN 开始打洞——不为了中继把建房卡住。
    await ensureIceServers();
    // 硬件编解码预检（不碰权限、只问 WebCodecs）：名册里要带上"本机能否 AV1 硬解"
    await this.startHardwareProbe();

    let attempt = 0;
    while (!this.destroyed && attempt < 3) {
      attempt += 1;
      const want = attempt === 1 ? prefer?.code : undefined;
      const code = want && isRoomCode(want) ? normalizeCode(want) : makeRoomCode(randomIndex);
      // 房主注册在由房间码推导的固定 ID 上：访客只输房间码也能定位到房主，
      // 不需要任何注册后端。ID 被占用（撞码/有人蹲守）时 openPeer 返回
      // "retry"，下面的循环换新码重来。
      const id = hostPeerIdForCode(code);
      const outcome = await this.openPeerWithRetry(() => id);

      if (this.destroyed) return;
      if (outcome === "open") {
        this.code = code;
        this.hostId = id;
        // 恢复房间时沿用旧钥匙，否则旧邀请链接会失效
        this.roomKey = (attempt === 1 && prefer?.roomKey) || randomToken(24);
        this.myId = id;
        this.me = {
          id,
          personId: identity.personId,
          sessionId: sessionScopedId(),
          name: identity.name,
          avatar: identity.avatar,
          color: identity.color,
          muted,
          hasMic: !!this.localStream,
          isHost: true,
          local: true,
          ...(this.myAv1Decode ? { av1Decode: true } : {}),
          // 自己这条也要带账号 ID，否则别人看到的"房主"永远没有 ID（加不了好友）
          ...(this.accountId ? { accountId: this.accountId } : {}),
        };
        this.members.set(id, this.me);
        const monitorStream = this.outgoingStream ?? this.localStream;
        if (monitorStream) {
          this.monitor(id, monitorStream, true);
          this.startSpeakingLoop();
        }
        this.startHeartbeat();
        this.joined = true;

        this.emitMembers();
        this.events.status("connected");
        this.events.ready({ code, hostId: id, roomKey: this.roomKey });
        this.startRoomTelemetry();
        this.startSessionStats();
        return;
      }

      this.dropPeer();
      if (outcome === "retry") continue;
      this.events.status("error", outcome);
      return;
    }

    if (!this.destroyed) {
      this.events.status("error", "创建房间失败，请重试");
    }
  }

  /** 访客加入。handshake 失败会以 error 状态结束，由 UI 提示。 */
  async join(
    target: { code: string; hostId: string; roomKey: string },
    identity: Identity,
    settings: VoiceSettings,
    muted: boolean,
  ): Promise<void> {
    if (this.destroyed) return;
    this.hosting = false;
    this.dialAttempts = 0;
    this.code = normalizeCode(target.code);
    this.roomKey = target.roomKey;
    // 这里仍在用户点击的手势里，趁机解锁音频（否则远端流到达时会被自动播放策略拦下）
    this.unlockAudio();
    this.events.status("preparing");
    await this.acquireMic(settings, muted);
    await this.buildOutgoing(settings);
    this.loadPeerAudioSettings(settings);
    /*
     * 进房握手本身也是一条 RTCPeerConnection（PeerJS 数据通道），同样要过 ICE。
     * 跨网打洞失败时如果没有可用 TURN，这里就会一直建不起连接、超时 ×3 —— 
     * 这正是"跨网进不去"的现场。故与建房一样，先把凭据备好。
     */
    await ensureIceServers();
    // 握手包里要报"本机能否 AV1 硬解"，共享者据此判断能不能上 AV1
    await this.startHardwareProbe();

    const outcome = await this.openPeerWithRetry(() => guestPeerId(randomToken(12)));
    if (this.destroyed) return;
    if (outcome !== "open") {
      this.events.status(
        "error",
        outcome === SIGNAL_RETRY
          ? "连不上中转服务器（网络波动或网络受限）——换个网络（如手机热点）或稍后再试"
          : outcome,
      );
      return;
    }

    this.myId = this.peer?.id ?? "";
    this.me = {
      id: this.myId,
      personId: identity.personId,
      sessionId: sessionScopedId(),
      name: identity.name,
      avatar: identity.avatar,
      color: identity.color,
      muted,
      hasMic: !!this.localStream,
      isHost: false,
      local: true,
      ...(this.myAv1Decode ? { av1Decode: true } : {}),
      ...(this.accountId ? { accountId: this.accountId } : {}),
    };
    this.members.set(this.myId, this.me);
    this.emitMembers();
    // 访客也要监控自己（处理后）的流，否则本地"正在说话"高亮永远不会触发。
    const selfStream = this.outgoingStream ?? this.localStream;
    if (selfStream) {
      this.monitor(this.myId, selfStream, true);
      this.startSpeakingLoop();
    }

    // 两种进房方式：邀请链接里带 hostId 就直接用；只输房间码则由房间码
    // 推导出房主 ID（房主就注册在这个固定 ID 上）。
    const hostId = target.hostId || hostPeerIdForCode(this.code);
    if (!isValidPeerId(hostId)) {
      // 邀请链接被截断/改写过时，早点说清楚，别让用户盯着"正在进入…"。
      this.events.status("error", "邀请链接不完整或已损坏，请让房主重新发一次");
      return;
    }
    this.hostId = hostId;
    this.dialHost();
  }

  /**
   * 探一次本机硬件编解码能力（WebCodecs，进程内缓存 + 并发去重）。
   * 结果进 `hwProbe` / `myAv1Decode`，用于：报到名册（双端判断 AV1）与开播选码。
   */
  private startHardwareProbe(): Promise<HardwareCodecProbe> {
    this.hwProbePromise ??= probeHardwareEncoders("fhd1080").then((probe) => {
      this.hwProbe = probe;
      this.myAv1Decode = probe.decAv1;
      return probe;
    });
    return this.hwProbePromise;
  }

  /**
   * 房间进行中更新自己的资料（设置页改昵称/头像/颜色）。
   * 之前只写 localStorage，正在运行会话里的铭牌一直是旧名字——
   * 这里改完立即更新成员记录并同步给全房。
   */
  updateIdentity(identity: Identity): void {
    if (!this.me || this.destroyed) return;
    this.me = {
      ...this.me,
      name: identity.name,
      avatar: identity.avatar,
      color: identity.color,
    };
    this.members.set(this.myId, this.me);
    this.emitMembers();
    if (this.hosting) {
      this.broadcastHost({ t: "roster", members: this.roster() });
    } else {
      this.send(this.hostConn, {
        t: "identity",
        name: identity.name,
        avatar: identity.avatar,
        color: identity.color,
      });
    }
  }

  setMuted(muted: boolean): void {
    // 被房主强制禁言期间，本人不能自行开麦（房主解禁后才可以）。
    if (!muted && this.me?.serverMuted) return;
    const changed = this.me ? this.me.muted !== muted : false;
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) track.enabled = !muted;
    }
    if (!this.me) return;
    this.me.muted = muted;
    this.speaking.delete(this.myId);
    this.emitMembers();
    this.emitSpeaking();

    if (this.hosting) {
      const record = this.me;
      this.members.set(this.myId, record);
      this.broadcastHost({ t: "roster", members: this.roster() });
      /*
       * 房主切换自己的麦克风也要响一声，而且全房间都该听见。
       * 之前只处理了访客的 muted 消息，导致房主自己关麦时没有任何提示音。
       */
      if (changed) this.emitSound(muted ? "mute" : "unmute", this.myId);
    } else {
      this.send(this.hostConn, { t: "muted", muted, deafened: this.deafened });
    }
  }

  sendChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.me) return;
    const ts = Date.now();
    if (this.hosting) {
      const id = randomToken(9);
      const message: ChatMessage = {
        id,
        name: this.me.name,
        text: trimmed,
        ts,
        self: true,
      };
      // 房主的消息要发给所有人，且不回给房主自己。
      this.events.chat(message);
      this.broadcastHost({ t: "chat", id, name: this.me.name, text: trimmed, ts });
      return;
    }
    this.send(this.hostConn, { t: "chat", text: trimmed });
  }

  // ------------------------------------------------------------ 房间遥测（仅房主）

  /** 房主进房后启动：每 ~10 秒把房间快照经信令 WebSocket 顺路上报。 */
  private startRoomTelemetry(): void {
    if (this.roomTelemetry || this.destroyed || !this.code) return;
    this.roomTelemetry = {
      sessionId: randomToken(12),
      code: this.code,
      createdAt: new Date().toISOString(),
      members: new Map(),
      events: [],
      share: { active: false, totalS: 0, transport: "", last: "" },
      timer: 0,
    };
    this.roomTelemetry.timer = this.timers.every(10_000, () => {
      void this.sendRoomSnapshot();
    });
    void this.sendRoomSnapshot();
  }

  private stopRoomTelemetry(): void {
    if (!this.roomTelemetry) return;
    this.timers.cancel(this.roomTelemetry.timer);
    this.roomTelemetry = null;
  }

  // ------------------------------------------------- 今晚小结（本地采样统计）

  /** 本地会话统计（每个客户端各自采样，见 session-stats.ts）。 */
  private stats: SessionStatsRecorder | null = null;
  private statsTimer = 0;
  private lastSummary: SessionSummary | null = null;

  /** 进房成功后启动：每 2 秒采样一次名册 + 说话状态，供"今晚小结"（粒度粗了短会话全 0）。 */
  private startSessionStats(): void {
    if (this.statsTimer || this.destroyed) return;
    this.stats = new SessionStatsRecorder();
    this.stats.begin();
    this.sampleSessionStats();
    // 小结采样同样走 Worker：被节流会让统计粒度从 2 秒变成 1 分钟
    this.statsTimer = this.timers.everyBackground(STATS_SAMPLE_SEC * 1000, () => this.sampleSessionStats());
  }

  private sampleSessionStats(): void {
    if (!this.stats) return;
    const members = [...this.members.values()].map((m) => ({ id: m.id, name: m.name, local: m.local }));
    this.stats.observe(members, this.speaking);
  }

  /** 停止统计。keepSummary=true（正常结束）时保留小结供 UI 展示。 */
  private stopSessionStats(keepSummary: boolean): void {
    if (this.statsTimer) {
      this.timers.cancel(this.statsTimer);
      this.statsTimer = 0;
    }
    if (keepSummary) {
      this.lastSummary = this.stats?.finish() ?? this.lastSummary;
    }
    this.stats = null;
  }

  /**
   * 取"今晚小结"（房间结束后由界面读取）。
   * 幂等：没开过统计（没真正进过房）返回 null；结束时刻以第一次调用为准。
   */
  getSessionSummary(): SessionSummary | null {
    if (!this.lastSummary && this.stats) {
      this.lastSummary = this.stats.finish();
      this.stopSessionStats(false);
    }
    return this.lastSummary;
  }

  // ------------------------------------------------------- 房主铭牌公告

  /** 房主铭牌公告（只有房主能改；随 welcome / roster 捎带给全房）。 */
  private topic = "";

  // ------------------------------------------------------- 场景主题
  // 2026-10-22 起主题改为**个人偏好**（本地设置 + 落盘，见 use-voice/settings），
  // 引擎不再同步：不广播、不接收、不进名册。协议里的 theme 字段仅为老客户端保留。


  /** 房主设置公告（≤60 字）。广播 roster（捎带 topic）并通知本机界面。 */
  setTopic(text: string): void {
    if (!this.hosting || this.destroyed) return;
    const next = text.replace(/\s+/g, " ").trim().slice(0, 60);
    if (next === this.topic) return;
    this.topic = next;
    this.events.topic?.(this.topic);
    // 改公告本身也值得全房知道：捎带在下一次 roster 里，这里立即广播一次。
    this.broadcastHost({ t: "roster", members: this.roster(), topic: this.topic || undefined });
  }

  /** 记一条房间事件（进会话档案的异常流水）。 */
  private pushRoomEvent(kind: string, detail: string): void {
    /*
     * 本地诊断环形缓冲：与房间遥测解耦——遥测只上报汇总，
     * 而排障需要"最近发生了什么"的原始序列（导出诊断包时用）。
     */
    this.diagLog.push({ at: new Date().toISOString(), kind, detail: detail.slice(0, 180) });
    if (this.diagLog.length > 300) this.diagLog.splice(0, this.diagLog.length - 300);

    const t = this.roomTelemetry;
    if (!t) return;
    t.events.push({ at: new Date().toISOString(), kind, detail: detail.slice(0, 180) });
    if (t.events.length > 40) t.events.splice(0, t.events.length - 40);
  }

  /**
   * 组装并上报一份房间快照。
   * 成员的 RTT/抖动/丢包来自各自媒体连接的 getStats；说话时长按 10 秒粗粒度累计；
   * 已离开的成员保留在成员表里（leftAt 标记），历史面板能看到完整进出。
   */
  private async sendRoomSnapshot(): Promise<void> {
    const t = this.roomTelemetry;
    const socket = (this.peer as unknown as { socket?: { send?: (m: unknown) => void } } | null)?.socket;
    if (!t || !socket || typeof socket.send !== "function" || this.destroyed) return;
    const nowIso = new Date().toISOString();

    const seen = new Set<string>();
    const membersPayload: unknown[] = [];
    for (const member of this.members.values()) {
      const key = member.sessionId || member.id;
      seen.add(member.id);
      let stat = t.members.get(key);
      if (!stat) {
        stat = {
          peerId: member.id, name: member.name, joinedAt: nowIso, leftAt: null,
          rttSum: 0, rttCount: 0, rttMax: 0, jitterMax: 0, lossPct: 0,
          link: member.local ? "self" : "connecting", reconnects: 0, speakingS: 0,
          runtime: isTauriRuntime() ? "client" : "web", version: latestChangelog()?.version ?? "",
        };
        t.members.set(key, stat);
      }
      stat.name = member.name;
      /*
       * 断线重连的成员：会话档是同一个 key，但 peerId 已经换新。
       * 必须清掉上一段会话留下的"离开"标记并更新 peerId——否则面板会永远显示
       * "已离开"、RTT 也不更新（2026-10-16 实测：访客重连后在后台档案一直显示已离开）。
       */
      if (stat.leftAt || stat.peerId !== member.id) {
        stat.leftAt = null;
        stat.peerId = member.id;
      }
      if (!member.local) {
        const pc = this.calls.get(member.id)?.peerConnection ?? null;
        if (pc) {
          try {
            const stats = await pc.getStats();
            let rttMs: number | null = null;
            let jitterMs: number | null = null;
            let lost = 0;
            let received = 0;
            stats.forEach((report) => {
              if (report.type === "candidate-pair") {
                // 同上：RTT 也要取在用的那条，否则可能量到备用中继对的往返
                const pair = VoiceMesh.chosenPair(stats);
                const rtt = pair?.currentRoundTripTime;
                if (typeof rtt === "number") rttMs = Math.round(rtt * 1000);
              }
              if (report.type === "inbound-rtp" && report.kind === "audio") {
                jitterMs = Math.round(((report as { jitter?: number }).jitter ?? 0) * 1000);
                lost += (report as { packetsLost?: number }).packetsLost ?? 0;
                received += (report as { packetsReceived?: number }).packetsReceived ?? 0;
              }
            });
            if (typeof rttMs === "number") {
              stat.rttSum += rttMs;
              stat.rttCount += 1;
              stat.rttMax = Math.max(stat.rttMax, rttMs);
            }
            if (typeof jitterMs === "number") stat.jitterMax = Math.max(stat.jitterMax, jitterMs);
            if (received + lost > 0) stat.lossPct = Math.round((lost / (received + lost)) * 1000) / 10;
          } catch {
            /* getStats 不可用：跳过本成员本次采样 */
          }
        }
        stat.link = this.roomLinkState.get(member.id) ?? stat.link;
      } else {
        stat.link = "self";
      }
      if (this.speaking.has(member.id)) stat.speakingS += 10;
      membersPayload.push({
        key, name: stat.name, joinedAt: stat.joinedAt, leftAt: stat.leftAt,
        rttSum: stat.rttSum, rttCount: stat.rttCount, rttMax: stat.rttMax,
        jitterMax: stat.jitterMax, lossPct: stat.lossPct, link: stat.link,
        reconnects: stat.reconnects, speakingS: stat.speakingS,
        runtime: stat.runtime, version: stat.version,
      });
    }
    // 已离开的成员：标记离开时间（保留在快照里，历史面板能看到完整进出）
    for (const stat of t.members.values()) {
      if (!seen.has(stat.peerId) && !stat.leftAt) stat.leftAt = nowIso;
    }
    // 排除掉完全没进过房间的幽灵条目（理论上不会出现）
    const departed = [...t.members.values()].filter((m) => m.leftAt && !seen.has(m.peerId));
    for (const stat of departed) {
      membersPayload.push({
        key: stat.peerId, name: stat.name, joinedAt: stat.joinedAt, leftAt: stat.leftAt,
        rttSum: stat.rttSum, rttCount: stat.rttCount, rttMax: stat.rttMax,
        jitterMax: stat.jitterMax, lossPct: stat.lossPct, link: stat.link,
        reconnects: stat.reconnects, speakingS: stat.speakingS,
        runtime: stat.runtime, version: stat.version,
      });
    }

    const share = this.getScreenShareState();
    if (share) {
      t.share.active = true;
      t.share.transport = share.transport === "sfu" ? "SFU" : "P2P";
      t.share.last = share.quality ?? "";
    }

    const payload = {
      sessionId: t.sessionId,
      code: t.code,
      createdAt: t.createdAt,
      runtime: isTauriRuntime() ? "client" : "web",
      version: latestChangelog()?.version ?? "",
      members: membersPayload.slice(0, 64),
      events: t.events.slice(-20),
      share: { active: t.share.active, totalS: t.share.totalS, transport: t.share.transport, last: t.share.last },
    };
    t.events = [];
    try {
      socket.send({ type: "ROOM-SNAPSHOT", payload });
    } catch {
      /* 发送失败静默：下一轮快照会补 */
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopRoomTelemetry();
    this.stopSessionStats(true);
    stopPoseTickerFn();
    this.stopHeartbeat();

    this.timers.clear();
    this.welcomeDeadline = 0;

    for (const call of this.calls.values()) {
      try {
        call.close();
      } catch {
        /* noop */
      }
    }
    this.calls.clear();
    this.closeScreenCalls();

    for (const guest of this.guests.values()) {
      try {
        guest.conn.close();
      } catch {
        /* noop */
      }
    }
    this.guests.clear();

    try {
      this.hostConn?.close();
    } catch {
      /* noop */
    }
    this.hostConn = null;

    this.dropPeer();

    for (const monitor of this.monitors.values()) {
      try {
        monitor.source.disconnect();
        monitor.analyser.disconnect();
      } catch {
        /* noop */
      }
    }
    this.monitors.clear();

    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
    this.teardownOutgoingGraph();

    for (const el of this.audio.values()) {
      el.pause();
      el.srcObject = null;
      el.remove();
    }
    this.audio.clear();
    /*
     * 泵元素必须一起收：它们 muted 但又持有远端 MediaStream（连解码器），
     * 只清 audio 不清 pumpEls 会让每次进出房间都在 body 上留下几个 `<audio>`，
     * 长会话反复进退房时内存和音频句柄持续上涨。
     */
    for (const pump of this.pumpEls.values()) {
      try {
        pump.pause();
        pump.srcObject = null;
        pump.remove();
      } catch {
        /* noop */
      }
    }
    this.pumpEls.clear();
    this.voiceHeals.clear();
    this.lastMediaAt.clear();
    this.lastDialAt.clear();
    this.roomLinkState.clear();

    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  // ------------------------------------------------------------ peer 生命周期

  /**
   * 建立 peer 并等 open：信令瞬时失败时**换一条连接重试**（退避 0.7s / 1.4s）。
   * 三次都失败才把可读错误交给界面，并附"换个网络试试"的建议。
   */
  private async openPeerWithRetry(nextId: () => string): Promise<string> {
    let last = SIGNAL_RETRY;
    for (let attempt = 0; attempt < SIGNAL_RETRY_ATTEMPTS; attempt += 1) {
      if (this.destroyed) return "已离开房间";
      if (attempt > 0) {
        this.dropPeer();
        await new Promise<void>((resolve) =>
          this.timers.after(SIGNAL_RETRY_BACKOFF_MS * attempt, resolve),
        );
        if (this.destroyed) return "已离开房间";
      }
      // 逐次换线路：前几次借我们的域名，最后一次直连公共云
      const route = SIGNAL_ROUTES[Math.min(attempt, SIGNAL_ROUTES.length - 1)]!;
      const outcome = await this.openPeer(nextId(), route);
      if (outcome !== SIGNAL_RETRY) return outcome;
      last = outcome;
    }
    return last;
  }

  /** 建立 peer 并等 open。返回值是 "open"、可重试标记或给用户看的错误文案。 */
  private openPeer(id: string, route = SIGNAL_ROUTES[0]!): Promise<string> {
    return new Promise<string>((resolve) => {
      if (this.destroyed) {
        resolve("已离开房间");
        return;
      }
      const peer = new Peer(id, {
        host: route.host,
        port: route.port,
        secure: route.secure,
        key: route.key,
        debug: 0,
        config: { iceServers: iceServers(), iceCandidatePoolSize: 0 },
      });
      this.peer = peer;

      let settled = false;
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        this.timers.cancel(timeout);
        resolve(value);
      };

      const timeout = this.timers.after(WELCOME_TIMEOUT_MS, () => {
        finish("连接信令服务器超时，请检查网络后重试");
      });

      peer.on("open", () => {
        peer.on("connection", (conn) => this.onIncomingConnection(conn));
        peer.on("call", (call) => this.onIncomingCall(call));
        peer.on("disconnected", () => {
          // 信令掉线不影响已建立的 P2P 媒体；尝试恢复信令以便继续接纳新成员。
          try {
            peer.reconnect();
          } catch {
            /* noop */
          }
        });
        finish("open");
      });

      peer.on("error", (error: { type?: string; message?: string }) => {
        const type = error?.type ?? "unknown";
        /*
         * peer 已经 open 之后才到的错误：上面那个 `finish` 有 settled 守卫，
         * 全都会被丢掉（`peer-unavailable` 就是这么消失的）。交给专门的分支处理，
         * 否则访客只能干等 12 秒超时 ×3 才知道"房主不在线"。
         */
        if (settled) {
          this.onLatePeerError(type, String(error?.message ?? ""));
          return;
        }
        if (type === "unavailable-id") {
          finish("retry");
          return;
        }
        if (type === "invalid-id") {
          // 生成出来的 ID 不合 PeerJS 规则（历史上 randomToken 的 -/_ 就踩过这里）。
          // 必须让它显形，否则表现为"一直连不上"这种最难查的症状。
          finish("房间标识不合规，请刷新页面重试（若持续出现请反馈）");
          return;
        }
        if (type === "peer-unavailable") {
          finish("房主不在线，邀请可能已失效");
          return;
        }
        if (isRetryableSignalingError(type)) {
          // 交给调用方换连接重试（见 openPeerWithRetry）：瞬时抖动不该直接判死
          finish(SIGNAL_RETRY);
          return;
        }
        if (type === "browser-incompatible") {
          /*
           * PeerJS 在**构造 Peer 时**就地做的能力检测（还没有任何网络请求）：
           * `new RTCPeerConnection()` 或 `createDataChannel()` 失败就报这个错。
           * 现实里三种成因：① 在 QQ/微信等 App 内置浏览器里打开（内核阉割）；
           * ② 隐私插件 / VPN 把 WebRTC 屏蔽了（防 IP 泄漏类，很常见）；
           * ③ 浏览器太老。所以提示要给出可操作的办法，而不是只说"不支持"。
           */
          const hasRtc =
            typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === "function";
          finish(
            hasRtc
              ? "WebRTC 被浏览器扩展拦住了（防泄漏类插件最常见）——先用无痕窗口打开试试，能进就去扩展里关掉它的 WebRTC 拦截"
              : "当前浏览器没有 WebRTC——请换用 Chrome / Edge 打开，或下载桌面客户端",
          );
          return;
        }
        finish(`连接异常：${type}`);
      });
    });
  }

  /**
   * peer 已经 open（信令连上了）之后才到达的错误。
   *
   * 唯一要立刻处理的是 `peer-unavailable`：它由 PeerJS 信令服务器在
   * "目标 ID 不在注册表里"时下发（协议里的 Expire），消息形如
   * `Could not connect to peer <id>`。以前这个分支被 `openPeer` 的 settled
   * 守卫吞掉，访客只能等满 12 秒超时再自动重拨（最多 3 次 ≈ 36 秒）才看到一句
   * "房主没有响应"——这就是实测里"点了没反应、也没有任何提示"的现场。
   *
   * 现在：还有重拨机会就**立刻**换新 ID 重拨（省掉 12 秒空等），
   * 机会用完就直接把原因说清楚。只认"打不通房主"这一条——
   * 访客之间的媒体呼叫失败不该把整个进房判死，所以必须核对错误里的目标 ID。
   */
  private onLatePeerError(type: string, message: string): void {
    if (type !== "peer-unavailable") return;
    if (this.destroyed || this.joined || !this.hostId) return;
    // 消息里没带 ID（个别版本不填）时不敢下判断：宁可按老路走超时，也不误杀。
    if (!message.includes(this.hostId)) return;
    if (this.dialAttempts >= MAX_DIAL_ATTEMPTS - 1) {
      this.clearWelcomeDeadline();
      this.events.status("error", "房主不在线，邀请可能已失效");
      return;
    }
    // 在 peer 自己的事件回调里销毁 peer 不安全，挪到下一个 tick。
    this.timers.after(0, () => {
      if (this.destroyed || this.joined) return;
      void this.redialWithFreshPeer();
    });
  }

  private dropPeer(): void {
    const peer = this.peer;
    this.peer = null;
    if (!peer) return;
    try {
      peer.removeAllListeners();
      peer.destroy();
    } catch {
      /* noop */
    }
  }

  // ------------------------------------------------------------------- 房主侧

  private onIncomingConnection(conn: DataConnection): void {
    if (!this.hosting) {
      // 访客之间不需要数据通道：名册由房主下发，避免成员互相伪造状态。
      conn.on("open", () => {
        try {
          conn.close();
        } catch {
          /* noop */
        }
      });
      return;
    }

    conn.on("data", (data) => void this.onGuestData(conn, data));
    conn.on("close", () => this.evictGuest(conn.peer, "closed"));
    conn.on("error", () => this.evictGuest(conn.peer, "closed"));
  }

  private async onGuestData(conn: DataConnection, data: unknown): Promise<void> {
    const message = parseGuestMessage(data);
    if (!message) return;

    if (message.t === "hello") {
      await this.handleHello(conn, message);
      return;
    }

    const guest = this.guests.get(conn.peer);
    if (!guest) return;
    // "joined" 本身就是把访客从"握手通过"推进到"已加入"的唯一消息，必须在
    // joined=false 时放行。若用 `!guest.joined` 提前 return，下面的
    // case "joined" 永远不可达，访客永远进不了名册——这正是实测日志里
    // 反复出现 HOST msg-dropped-not-joined、房主侧一直停在 1/8 的根因。
    if (!guest.joined && message.t !== "joined") return; // 未通过握手的连接拿不到任何服务
    guest.lastSeen = Date.now();

    switch (message.t) {
      case "joined": {
        // 访客确认已就绪。这里同时刷新 lastSeen：这条消息可能因 DataChannel
        // 打开时序而比首条 ping 先到，若不计入，刚进房的人会在 6 秒后被误判掉线。
        guest.lastSeen = Date.now();
        this.announceJoin(conn.peer);
        break;
      }
      case "chat": {
        // 用名册里的权威昵称与 id 覆盖，访客无法冒充他人说话。
        const id = randomToken(9);
        const name = guest.member.name;
        this.broadcastHost({ t: "chat", id, name, text: message.text, ts: Date.now() });
        this.events.chat({ id, name, text: message.text, ts: Date.now(), self: false });
        break;
      }
      case "identity": {
        // 访客在设置里改了资料：更新成员记录并重新广播名单
        const guestRecord = this.guests.get(conn.peer);
        const guestMember = guestRecord ? this.members.get(guestRecord.member.id) : null;
        if (!guestMember || !guestRecord) break;
        this.members.set(guestRecord.member.id, {
          ...guestMember,
          name: message.name,
          avatar: message.avatar,
          color: message.color,
        });
        this.emitMembers();
        this.broadcastHost({ t: "roster", members: this.roster() });
        break;
      }

      case "muted": {
        // 被房主强制禁言的人不能自行开麦：忽略开麦请求，并把他压回静音。
        if (guest.member.serverMuted && !message.muted) {
          guest.member.muted = true;
          this.send(conn, { t: "force-mute", id: guest.member.id, muted: true });
          this.broadcastHost({ t: "roster", members: this.roster() });
          break;
        }
        const wasMuted = guest.member.muted;
        guest.member.muted = message.muted;
        guest.member.deafened = message.deafened ?? false;
        this.emitMembers();
        this.broadcastHost({ t: "roster", members: this.roster() });
        // 开关麦克风全房间都该听见（房主统一广播，保证同时响）
        if (wasMuted !== message.muted) {
          this.emitSound(message.muted ? "mute" : "unmute", guest.member.id, guest.member.id);
        }
        break;
      }
      case "speaking": {
        this.setSpeaking(guest.member.id, message.speaking);
        break;
      }
      case "interact": {
        this.handleInteract(guest.member.id, message.to, message.kind);
        break;
      }
      case "screen-share-start": {
        // 权威互斥：电视已被占用时忽略请求，并把当前状态再广播一次，
        // 让输家从广播里看到"sharer 不是我"，自行停止发布。
        if (this.screenShareState) {
          this.broadcastHost({ t: "screen-share", state: this.screenShareState });
          break;
        }
        const pub = message.session;
        this.applyScreenShare(
          {
            active: true,
            sharerId: guest.member.id,
            sessionId: pub.sessionId,
            trackName: pub.trackName,
            trackNameAudio: pub.hasAudio ? pub.trackNameAudio : "",
            label: pub.label,
            startedAt: Date.now(),
            transport: pub.transport,
            ...(pub.simulcast ? { simulcast: true } : {}),
            ...(pub.quality ? { quality: pub.quality } : {}),
          },
          true,
        );
        break;
      }
      case "screen-share-stop": {
        // 只有共享者本人（或房主代管）能停。
        if (this.screenShareState?.sharerId === guest.member.id) {
          this.applyScreenShare(null, true);
        }
        break;
      }
      case "screen-pref": {
        // 观众的画质偏好：共享者是房主 → 本地应用；是访客 → 转给他那条连接
        // （访客之间没有数据直连，必须由房主转一手）。
        this.routeScreenPref(guest.member.id, message.mode);
        break;
      }
      case "screen-watch": {
        // 同上：谁在看共享，房主要负责转给共享者（省的是**共享者**的上行）
        this.routeScreenWatch(guest.member.id, message.state);
        break;
      }
      case "account": {
        /*
         * 访客进房之后才登录：把账号 ID 补进他的成员记录，然后重播名册。
         * 不这么做的话，别人看他永远是"没有 ID"，菜单里的「加好友」不出现
         * ——这正是 2026-10-26 "登录了也加不了房主/成员"的一半原因。
         */
        const record = this.members.get(guest.member.id);
        if (record) {
          this.members.set(record.id, {
            ...record,
            accountId: message.accountId,
            // 顺手带上来的资料（旧客户端没有，解析后是 undefined）
            ...(message.name ? { name: message.name } : {}),
            ...(message.avatar ? { avatar: message.avatar } : {}),
          });
          this.emitMembers();
          this.broadcastHost({ t: "roster", members: this.roster() });
        }
        break;
      }
      case "ping": {
        this.send(conn, { t: "pong", ts: message.ts });
        break;
      }
      default:
        break;
    }
  }

  private async handleHello(
    conn: DataConnection,
    message: Extract<ReturnType<typeof parseGuestMessage>, { t: "hello" }>,
  ): Promise<void> {
    const peerId = conn.peer;
    const expected = await signGuestProof(this.roomKey, message.nonce, peerId, this.code);
    // 两种访客都放行：持邀请链接者 proof 与 expected 一致；只输房间码者没有
    // roomKey、proof 为空（房主 ID 由房间码推导，能连上即说明知道房间码）。
    // 非空却对不上的证明（伪造/篡改）仍一律拒绝。
    const codeOnly = message.proof === "";
    const verdict = decideAdmission({
      hostReady: !this.destroyed && !!this.hostId,
      closed: this.destroyed,
      locked: this.locked,
      codeMatches: this.code.length === ROOM_CODE_LEN,
      proofValid: expected === message.proof || codeOnly,
      existing: this.guests.has(peerId),
      /*
       * 必须把房主自己算进去：MAX_MEMBERS 是**全房人数**（含房主），
       * 原来只数访客，于是房主 + 8 访客 = 9 人也能进来，再叠加名册解析的上界，
       * 第 9 个人就会从名单里消失、媒体被关（"有的人互相听不到"）。
       */
      memberCount: this.guests.size + 1,
    });

    if (this.destroyed) return;

    if (!verdict.ok) {
      this.send(conn, { t: "reject", reason: verdict.reason });
      this.timers.after(120, () => {
        try {
          conn.close();
        } catch {
          /* noop */
        }
      });
      return;
    }

    // 同 ID 重连：先替换旧连接，避免留下僵尸记录。
    const previous = this.guests.get(peerId);
    if (previous && previous.conn !== conn) {
      try {
        /*
         * 先摘监听再关：PeerJS 的 DataConnection.close() 是**同步** emit close 的，
         * 而 onHostConnection 的 close 处理会按 dataConns 反查——那时旧连接还挂着，
         * 于是把"正在重连的这个人"当成"离开"：广播 peer-leave、响离开音，
         * 并且 dropMedia 把刚重建的语音腿拆掉（全场看他"退圈又进圈"）。
         */
        previous.conn.removeAllListeners();
        previous.conn.close();
      } catch {
        /* noop */
      }
    }

    const member: Member = {
      id: peerId,
      personId: message.personId,
      ...(message.accountId ? { accountId: message.accountId } : {}),
      sessionId: message.sessionId,
      name: message.name,
      avatar: message.avatar,
      color: message.color,
      muted: message.muted ?? false,
      hasMic: message.hasMic,
      isHost: false,
      local: false,
      // 同 ID 断线重连要保留此前的禁言状态。
      serverMuted: previous?.member.serverMuted ?? false,
      deafened: previous?.member.deafened ?? false,
      // AV1 硬解能力：共享者据此做双端判断（缺省 = 不支持）
      ...(message.av1Decode === true ? { av1Decode: true } : {}),
    };
    this.guests.set(peerId, {
      conn,
      member,
      nonce: message.nonce,
      lastSeen: Date.now(),
      joined: false,
      rejoined: previous?.joined === true,
    });
    // 新成员先按静音展示，等它自己上报真实状态，避免"未授权就先占麦"的观感。
    this.members.set(peerId, member);

    const hostProof = await signHostProof(this.roomKey, message.nonce);
    if (this.destroyed || this.guests.get(peerId)?.conn !== conn) return;

    this.send(conn, {
      t: "welcome",
      code: this.code,
      hostId: this.hostId,
      proof: hostProof,
      you: peerId,
      roster: this.roster(),
      locked: this.locked,
      // 新成员也要知道电视亮没亮（中途加入直接去围观）。
      screenShare: this.screenShareState ?? undefined,
      // 房主铭牌公告（空串不上报，向后兼容老客户端）。
      topic: this.topic || undefined,
    });
  }

  /** 访客确认收到 welcome 后才对其他人公布，避免半开连接进名册。 */
  private announceJoin(peerId: string): void {
    const guest = this.guests.get(peerId);
    if (!guest || guest.joined) return;
    guest.joined = true;
    for (const [id, other] of this.guests) {
      if (id !== peerId && other.joined) {
        this.send(other.conn, { t: "peer-join", member: guest.member });
      }
    }
    this.emitMembers();
    // 有人进圈：全房间响一声（同 ID 断线重连不重复响），并给一条可见提示。
    if (!guest.rejoined) {
      this.emitSound("join", guest.member.id);
      this.events.rosterChange({ kind: "join", name: guest.member.name });
    }
    // 中途加入的人也要看到共享：我就是共享者时，向他发起画面直连（幂等）。
    if (this.screenShareState?.sharerId === this.myId) this.startScreenCalls();
  }

  private evictGuest(peerId: string, reason: string): void {
    const guest = this.guests.get(peerId);
    if (!guest) return;
    /*
     * 超时移除必须告知本人：否则他那边界面还显示在房间里，
     * 说话没人应、也听不到别人——"退房重进才好"的观感就是这么来的。
     */
    if (reason === "timeout" && guest.conn) {
      this.send(guest.conn, { t: "kick", id: guest.member.id, reason: "timeout" });
    }
    const wasJoined = guest.joined;
    this.guests.delete(peerId);
    this.members.delete(peerId);
    this.dropMedia(peerId);
    /*
     * 链路状态一并清掉：同一个 peerId（同一身份重连）回来时不能继承
     * 旧的 attempts=3 —— 否则这一场里他再出问题就不会自动自愈了。
     */
    this.clearVoiceHeal(peerId);
    this.lastMediaAt.delete(peerId);
    this.lastDialAt.delete(peerId);
    this.roomLinkState.delete(peerId);

    // 共享者掉线：电视收起来（房间与语音完全不受影响）。
    if (this.screenShareState?.sharerId === peerId) {
      this.applyScreenShare(null, true);
    }

    for (const [id, other] of this.guests) {
      if (id !== peerId && other.joined) {
        this.send(other.conn, { t: "peer-leave", id: peerId });
      }
    }
    this.emitMembers();
    // 只有真正进过圈的人离开才响（半开连接不算），并给一条可见提示
    if (wasJoined) {
      this.emitSound("leave", guest.member.id);
      this.events.rosterChange({ kind: "leave", name: guest.member.name });
    }
  }

  /**
   * 把某个观众的画质偏好送到**共享者**手里（房主侧）：共享者是房主就本地应用，
   * 是访客就经他那条数据连接转过去。
   */
  /**
   * 观众：告诉房主/共享者"我现在怎么看看共享"。
   *
   * 三档的意义在**共享者的上行**：off 会把那一路直接关掉（真省带宽），
   * preview 只发低码率缩略（扫一眼够用），watch 才是满码率。
   */
  setScreenWatch(state: ScreenWatchState): void {
    if (this.myScreenWatch === state) return;
    this.myScreenWatch = state;
    const sharer = this.screenShareState?.sharerId;
    if (!sharer || sharer === this.myId) return;
    if (this.hosting) {
      this.routeScreenWatch(this.myId, state);
      return;
    }
    this.send(this.hostConn, { t: "screen-watch", state });
  }

  /** 房主：把观众的观看状态转给共享者（共享者是房主时直接应用）。 */
  private routeScreenWatch(from: string, state: ScreenWatchState): void {
    const sharer = this.screenShareState?.sharerId;
    if (!sharer) return;
    if (sharer === this.myId) {
      this.screenWatch.set(from, state);
      this.applyScreenWatch(from);
      return;
    }
    const record = this.guests.get(sharer);
    if (record) this.send(record.conn, { t: "screen-watch", from, state });
  }

  /**
   * 共享者：按某位观众的状态调整他那一路。
   *
   * - off：直接关掉那条画面呼叫 —— 这是唯一能**真正释放上行**的做法
   *   （把 maxBitrate 设小仍会占带宽，关掉才归零）；下一次状态变回 preview/
   *   watch 时由 ensureCalls 或本方法重拨。
   * - preview：低码率 + 半分辨率 + 15fps 的缩略流，扫一眼够用。
   * - watch：满码率（按在看人数分摊）。
   */
  private applyScreenWatch(peerId: string): void {
    if (this.screenShareState?.sharerId !== this.myId || !this.screenStream) return;
    const state = this.screenWatch.get(peerId) ?? "preview";
    const existing = this.screenCalls.get(peerId);
    if (state === "off") {
      if (!existing) return;
      this.screenTuners.get(peerId)?.stop();
      this.screenTuners.delete(peerId);
      this.screenHealers.get(peerId)?.();
      this.screenHealers.delete(peerId);
      try {
        existing.close();
      } catch {
        /* noop */
      }
      this.screenCalls.delete(peerId);
      this.screenCallAt.delete(peerId);
      return;
    }
    if (!existing) {
      this.callScreenPeer(peerId);
      return;
    }
    const pc = this.screenPeerConnection(existing);
    if (!pc) return;
    if (state === "watch") {
      const viewers = Math.max(1, this.watcherCount());
      this.screenTuners.get(peerId)?.retune(perViewerBitrate(this.screenQuality, viewers));
      return;
    }
    // preview：调低码率/帧率/分辨率（tuner 在 preview 下不创建，不会被它覆盖）
    void applyScreenSenderParams(pc, this.screenQuality, {
      maxBitrate: VoiceMesh.PREVIEW_SCREEN_BITRATE,
      maxFramerate: 15,
      scaleResolutionDownBy: 2,
    });
  }

  /** 正在"看"的观众数（off 的不算）——按需分摊码率。 */
  private watcherCount(): number {
    let count = 0;
    for (const member of this.members.values()) {
      if (member.local) continue;
      if ((this.screenWatch.get(member.id) ?? "preview") !== "off") count += 1;
    }
    return count;
  }

  private routeScreenPref(from: string, mode: ScreenViewPreference): void {
    const sharer = this.screenShareState?.sharerId;
    if (!sharer) return;
    if (sharer === this.myId) {
      this.applyViewerScreenPref(from, mode);
      return;
    }
    const record = this.guests.get(sharer);
    if (record) this.send(record.conn, { t: "screen-pref", from, mode });
  }

  /**
   * 共享者侧：应用某个观众的画质偏好。
   *
   * P2P 模式下每个观众一条发送链，偏好**逐连接**生效（tuner.setPreference）；
   * 轨道 contentHint 是全轨共享的，按"有一位要流畅优先就取 motion"聚合
   * （宁可让清晰优先的那位降帧，也不要让要流畅的那位卡）。
   */
  private applyViewerScreenPref(from: string, mode: ScreenViewPreference): void {
    if (mode === "auto") this.viewerScreenPrefs.delete(from);
    else this.viewerScreenPrefs.set(from, mode);
    this.screenTuners.get(from)?.setPreference(mode);
    this.applyScreenContentHint();
  }

  /** 观众偏好聚合到轨道 contentHint（detail 保清晰 / motion 保帧率）。 */
  private applyScreenContentHint(): void {
    if (!this.screenStream) return;
    const hint = screenHintFor(this.viewerScreenPrefs.values());
    for (const track of this.screenStream.getVideoTracks()) track.contentHint = hint;
  }

  private roster(): WireMember[] {
    return Array.from(this.members.values(), (member) => ({
      id: member.id,
      personId: member.personId,
      sessionId: member.sessionId,
      name: member.name,
      avatar: member.avatar,
      color: member.color,
      muted: member.muted,
      hasMic: member.hasMic,
      isHost: member.isHost,
      serverMuted: member.serverMuted ?? false,
      deafened: member.deafened ?? false,
      // 能力字段必须随名册广播：共享者（可能是房主、也可能是访客）要据此判断
      // "是不是所有人都能硬解 AV1"，只有全员支持才敢上 AV1。
      av1Decode: member.av1Decode === true,
      ...(member.accountId ? { accountId: member.accountId } : {}),
    }));
  }

  private broadcastHost(message: HostMessage): void {
    if (!this.hosting) return;
    for (const guest of this.guests.values()) {
      if (guest.joined) this.send(guest.conn, message);
    }
  }

  // -------------------------------------------------------------- 房主管理

  /** 把某位成员移出房间（仅房主）。先发通知再断连，让对方看到明确原因。 */
  kickMember(id: string): void {
    if (!this.hosting) return;
    const guest = this.guests.get(id);
    if (!guest || guest.member.isHost) return;
    this.send(guest.conn, { t: "kick", id });
    try {
      guest.conn.close();
    } catch {
      /* noop */
    }
    this.timers.after(350, () => this.evictGuest(id, "kick"));
  }

  /** 强制某位成员静音 / 解除禁言（仅房主）。 */
  forceMute(id: string, muted: boolean): void {
    if (!this.hosting) return;
    const member = this.members.get(id);
    const guest = this.guests.get(id);
    if (!member || member.isHost) return;
    member.serverMuted = muted;
    if (muted) member.muted = true;
    if (guest) this.send(guest.conn, { t: "force-mute", id, muted });
    this.emitMembers();
    this.broadcastHost({ t: "roster", members: this.roster() });
    if (muted) this.emitSound("mute", id, id);
  }

  /** 上锁 / 解锁房间（仅房主）。上锁后拒绝新面孔，已在房成员断线重连放行。 */
  setLockedRoom(locked: boolean): void {
    if (!this.hosting || this.locked === locked) return;
    this.locked = locked;
    this.broadcastHost({ t: "lock", locked });
    this.events.roomFlags({ locked });
  }

  // -------------------------------------------------------------- 屏幕共享（围炉看 TV）

  /** 当前屏幕共享状态（null = 没人在共享，电视收起来了）。 */
  /** 登录状态变化时调用；不影响任何已有连接，只是下次广播带上它。 */
  setAccountId(id: string | null): void {
    const next = id && /^\d{8}$/.test(id) ? id : null;
    if (this.accountId === next) return;
    this.accountId = next;
    if (!this.me) return;
    /*
     * 自己那条成员记录也要跟着变，否则**别人看到我一直没有账号 ID**，
     * 成员菜单里的「加好友」就永远不出现（"加不了房主"就是这么来的）。
     * 房主这里顺手重播一次名册，客人立刻能看到；访客只能等下一次 hello，
     * 所以引导文案里写的是"登录后再开房更稳"。
     */
    if (next) this.me = { ...this.me, accountId: next };
    else {
      const { accountId: _drop, ...rest } = this.me;
      this.me = rest;
    }
    this.members.set(this.me.id, this.me);
    this.emitMembers();
    if (this.hosting && this.joined) {
      this.broadcastHost({ t: "roster", members: this.roster() });
    } else if (this.joined && this.hostConn) {
      // 访客没有广播权：向房主补报一次，由房主更新名册并重播。
      // 带上当前昵称/头像——登录后资料会跟随账号，这两件事的先后顺序不确定，
      // 一起发过去房主就不用等第二条 identity 消息。
      if (next) {
        this.send(this.hostConn, {
          t: "account",
          accountId: next,
          name: this.me.name,
          avatar: this.me.avatar,
        });
      }
    }
  }

  getScreenShareState(): ScreenShareState | null {
    return this.screenShareState;
  }

  /**
   * 申请开播（共享者已完成 SFU publish 后调用）。
   * 返回 false = 本地就知道被拒（电视已被占用 / 房间未就绪），调用方不要上行。
   * 房主侧还有一道权威互斥：并发竞态时只保留先到者，后到者会从广播里
   * 发现 sharer 不是自己，自行停止发布并退订。
   */
  /**
   * 申请开播（P2P 模式带画面流，SFU 模式不带）。
   * 返回 false = 本地就知道被拒（电视已被占用 / 房间未就绪），调用方不要上行。
   * 房主侧还有一道权威互斥：并发竞态时只保留先到者，后到者会从广播里
   * 看到 sharer 不是自己，自行停止发布并退订。
   */
  requestScreenShare(
    pub: ScreenSharePublication,
    stream?: MediaStream,
    quality: ShareQuality = "fhd1080",
  ): boolean {
    if (this.destroyed || !this.joined || !this.me) return false;
    if (this.screenShareState) return false;
    this.screenQuality = quality;
    this.screenStream = pub.transport === "p2p" ? (stream ?? null) : null;
    // P2P 链路没有 publishScreen 那道工序，contentHint 得在这里补上：
    // 不设它时浏览器按默认策略走，带宽一紧就先压质量（画面变糊）。
    // 口径与 SFU 路径一致（保清晰），并按观众偏好聚合（见 applyScreenContentHint）。
    this.viewerScreenPrefs.clear();
    this.applyScreenContentHint();
    if (this.hosting) {
      this.applyScreenShare(
        {
          active: true,
          sharerId: this.myId,
          sessionId: pub.sessionId,
          trackName: pub.trackName,
          trackNameAudio: pub.trackNameAudio,
          label: pub.label,
          startedAt: Date.now(),
          transport: pub.transport,
          ...(pub.simulcast ? { simulcast: true } : {}),
          ...(pub.quality ? { quality: pub.quality } : {}),
        },
        true,
      );
      return true;
    }
    if (!this.hostConn || !this.hostConn.open) return false;
    this.send(this.hostConn, { t: "screen-share-start", session: pub });
    return true;
  }

  /**
   * 观众端设置自己的画质偏好（自动 / 清晰优先 / 流畅优先）。
   *
   * 观众对本机收到的画面最清楚，所以这个开关交给观众：
   * - P2P：偏好经房主转给共享者，**只影响这一条观众的发送链**（逐连接生效）；
   * - SFU：偏好映射成订阅层（清晰优先 = f 满档、流畅优先 = h 半档），
   *   由调用方在重订阅时带上。
   * 没有人在共享时也记住选择，等下次开播/重订阅时生效。
   */
  /**
   * 观众端"延迟换稳定"档位（看别人共享时生效）。
   * 只影响画面这条 PC 的抖动缓冲（画面 + 共享声音成对），不影响语音房。
   */
  private screenLatency: ShareLatency = "balanced";

  setScreenLatency(mode: ShareLatency): void {
    if (this.screenLatency === mode) return;
    this.screenLatency = mode;
    /*
     * 已经在看的人要立刻生效：重建抖动缓冲 tuner（老的 stop 掉）。
     * 画面 PC 不变，所以不会黑屏，只是下一次采样按新档位排队。
     */
    for (const call of this.screenCalls.values()) {
      this.viewerJitters.get(call)?.();
      const pc = this.screenPeerConnection(call);
      if (pc) {
        const range = jitterTargetFor(mode);
        this.viewerJitters.set(
          call,
          createJitterBufferTuner(pc, { minMs: range.min, maxMs: range.max }),
        );
      }
    }
  }

  setScreenViewPreference(mode: ScreenViewPreference): void {
    this.localScreenPref = mode;
    const sharer = this.screenShareState?.sharerId;
    if (!sharer || sharer === this.myId) return;
    if (this.hosting) {
      this.routeScreenPref(this.myId, mode);
      return;
    }
    this.send(this.hostConn, { t: "screen-pref", mode });
  }

  /** 本机作为观众时选的画质偏好（供界面回显）。 */
  get screenViewPreference(): ScreenViewPreference {
    return this.localScreenPref;
  }

  /** 本机是否支持 AV1 硬解（预检结果；未探到 = false）。 */
  get supportsAv1Decode(): boolean {
    return this.myAv1Decode;
  }

  /** 停播（本人主动停止；房主侧也会在共享者掉线时代为清理）。 */
  stopScreenShare(): void {
    const state = this.screenShareState;
    if (!state) {
      /*
       * 竞态窗口：用户在"申报开播"的广播还没回来的几毫秒里就停止了采集
       * （点了系统选择器里的"停止共享"）。本地还没拿到状态，但停播申报
       * 仍要发出去——房主查不到对应共享者会安全忽略，无害。
       */
      if (!this.hosting && this.hostConn?.open) {
        this.send(this.hostConn, { t: "screen-share-stop" });
      }
      return;
    }
    const isSharer = state.sharerId === this.myId;
    if (!isSharer && !this.hosting) return;
    if (this.hosting) {
      this.applyScreenShare(null, true);
      return;
    }
    if (this.hostConn?.open) this.send(this.hostConn, { t: "screen-share-stop" });
    // 访客先乐观清本地（房主的权威广播随后到达，语义一致）。
    this.screenShareState = null;
    this.events.screenShare?.(null);
  }

  /**
   * 房主权威应用共享状态：更新字段、播声音、广播全员（含房主自己的回调）。
   * 声音也是房主统一产出的（与 join/leave 同一套机制）。
   */
  private applyScreenShare(state: ScreenShareState | null, broadcast: boolean): void {
    const previous = this.screenShareState;
    this.screenShareState = state;
    if (this.hosting && broadcast) {
      this.broadcastHost({ t: "screen-share", state });
      if (state && !previous) {
        // 支架砸地（立即）+ 开机（落地 ~0.9s 后）
        this.emitSound("tv-land", state.sharerId);
        this.timers.after(900, () => {
          if (!this.destroyed && this.screenShareState?.sessionId === state.sessionId) {
            this.emitSound("tv-on", state.sharerId);
          }
        });
      } else if (!state && previous) {
        this.emitSound("tv-off", previous.sharerId);
      }
    }
    this.events.screenShare?.(state);
    // P2P 直连：开播确认后（自己就是共享者）向各成员发起画面直连；
    // 停播时收线。SFU 模式没有 screenStream，不会走这里。
    if (state && state.sharerId === this.myId && this.screenStream) {
      this.startScreenCalls();
    }
    if (!state) {
      // 停播：观众偏好与发送端调谐器都由 closeScreenCalls 收线，这里清掉映射
      this.viewerScreenPrefs.clear();
      this.closeScreenCalls();
    }
  }

  /** 对某位成员发起小猪互动（戳一戳 / 打招呼 / 投喂），或对全场发起全房动作。 */
  interactWith(to: string, kind: InteractKind): void {
    if (!this.me) return;
    // 全房动作："*" 不是成员，单独放行（房主侧还会校验种类 + 30 秒冷却）
    if (to !== "*" && (to === this.myId || !this.members.has(to))) return;
    if (this.hosting) {
      this.handleInteract(this.myId, to, kind);
      return;
    }
    this.send(this.hostConn, { t: "interact", to, kind });
  }

  /** 房主统一处理互动：校验、广播，投喂时还在目标猪面前投一颗菜。 */
  private handleInteract(from: string, to: string, kind: InteractKind): void {
    if (!this.hosting) return;
    if (!this.members.has(from)) return;

    /*
     * 全房动作（蹦迪/烟花）：目标是 "*"。房主权威限流 30 秒——这类动作全房
     * 同时可见，不限制会被连点刷屏。冷却期内静默丢弃（不给发起人报错，
     * 避免再引入一类"操作失败"的提示噪音）。
     */
    if (to === "*") {
      if (!isGroupInteractKind(kind)) return;
      const now = Date.now();
      if (now - this.lastGroupInteractAt < GROUP_INTERACT_COOLDOWN_MS) return;
      this.lastGroupInteractAt = now;
      const groupEvent: InteractEvent = { from, to: "*", kind, ts: now };
      this.events.interact(groupEvent);
      this.broadcastHost({ t: "interact", event: groupEvent });
      return;
    }

    if (!this.members.has(to)) return;
    const event: InteractEvent = { from, to, kind, ts: Date.now() };
    this.events.interact(event);
    this.broadcastHost({ t: "interact", event });
    if (kind === "feed") this.feedPig(to);
    // 请客：一人触发、全场受益——给每一头在场的猪都丢一颗菜
    if (kind === "treat") for (const id of this.members.keys()) this.feedPig(id);
  }

  /** 投喂：在目标猪面前投一颗菜，并安排它走过去吃掉。 */
  private feedPig(to: string): void {
    const now = Date.now();
    const baseX = this.penActorX.get(to) ?? 0.5;
    const x = Math.min(0.94, Math.max(0.06, baseX + (Math.random() < 0.5 ? -0.06 : 0.06)));
    // 纵深跟目标猪当前所在对齐：菜落在它脚边那个深度，而不是永远落同一条道
    const lane = this.penActorLane.get(to) ?? 0.5;
    const kind = VEGETABLE_KINDS[Math.floor(Math.random() * VEGETABLE_KINDS.length)]!;
    const toss: Extract<PenEvent, { kind: "toss" }> = {
      kind: "toss",
      id: `feed-${now}-${Math.floor(Math.random() * 1e6)}`,
      ts: now,
      /*
       * 成员投喂也走 DDY 应召：npc 标成 DDY，前端据此让饲养员走到目标猪
       * 面前把菜抛出来（此前是凭空刷菜）。只是数据语义变化，线上格式没变。
       */
      npc: NPC_NAME,
      veg: { kind, x: Number(x.toFixed(3)), lane: Number(lane.toFixed(3)) },
    };
    this.emitPen(toss);
    // 菜 1.1s 后落地，猪 1.2s 就出发——立刻能看到"跑向食物"，
    // 而不是站在原地好几秒没反应（业主实测反馈）。
    this.timers.after(1200, () => {
      if (this.destroyed || !this.hosting || !this.members.has(to)) return;
      this.emitPen(this.pen.produceEat(Date.now(), to, kind));
    });
  }

  // ------------------------------------------------------------------ 猪圈导演

  /** 更新某头猪的横向位置（0~1）与纵深（0=最远 1=最近），供挑猪吃菜与蔬菜落点对位。 */
  reportPenActor(id: string, x: number, lane = 0.5): void {
    if (!Number.isFinite(x)) return;
    this.penActorX.set(id, Math.min(1, Math.max(0, x)));
    if (Number.isFinite(lane)) this.penActorLane.set(id, Math.min(1, Math.max(0, lane)));
  }

  /** 某头猪最近上报的纵深（0=最远 1=最近）；没有上报过就 undefined。 */
  getPenLane(id: string): number | undefined {
    return this.penActorLane.get(id);
  }

  /** 广播一个猪圈事件；房主自己也当场播动画。 */
  private emitPen(event: PenEvent): void {
    this.broadcastHost({ t: "pen", event });
    this.events.pen(event);
  }

  /**
   * 把每头猪的当前位播给访客（房主权威猪位，600ms 一次）。
   * 位置优先从 pen-registry 的解析式快照读——不依赖 rAF，
   * 房主切后台时访客看到的猪照样在走，而不是全房冻结。
   */
  private broadcastPoses(): void {
    if (!this.hosting || this.guests.size === 0) return;
    /*
     * 只发"活快照"（PigActor 正在渲染的实时位置）。
     * 曾经在快照缺失时回退到 penActorX 的历史值——猪圈一停止渲染
     * （例如房主切到别的页面把 RoomView 卸了），就会一直发冻结坐标，
     * 全房间的猪跟着卡住。宁可不发，也绝不发假位置。
     */
    const snaps = readPenSnapshots();
    if (snaps.size === 0) return;
    const poses: PenPose[] = [];
    for (const [id, snap] of snaps) {
      poses.push({
        id,
        x: Number(snap.x.toFixed(3)),
        lane: Number(snap.lane.toFixed(2)),
      });
    }
    this.broadcastHost({ t: "pen-poses", ts: Date.now(), poses });
  }

  /**
   * 广播一声提示音。
   *
   * 由房主统一产出：各端本地判断会各响各的（时序不一致），
   * 而"别人静音了"也只有房主知道权威结果。
   *
   * `exceptId` 用来排除**触发者本人**：
   * 触发者本地已经响过一次，如果广播时再算上他，他会听到两声
   * （实测访客关麦时两端都响了两次）。
   */
  private emitSound(kind: SoundKind, actor: string, exceptId?: string): void {
    if (!this.hosting) return;
    const now = Date.now();
    if (!shouldPlaySound(kind, this.lastSoundAt.get(kind), now)) return;
    this.lastSoundAt.set(kind, now);
    const event: SoundEvent = { kind, actor, id: `${kind}-${now}-${actor}`, ts: now };
    for (const guest of this.guests.values()) {
      if (guest.joined && guest.member.id !== exceptId) this.send(guest.conn, { t: "sound", event });
    }
    if (exceptId !== this.myId) this.events.sound(event);
  }

  /**
   * 合成并播放提示音（纯振荡器，不加载任何音频文件）。
   *
   * AudioContext 在用户交互前是挂起的，所以这里显式 resume 一次；
   * 进房本身就是一次交互，正常情况下能立刻解锁。
   */
  playSound(event: SoundEvent): void {
    const ctx = this.audioContext();
    if (!ctx) return;
    void resumeAudio(ctx);
    const start = ctx.currentTime + 0.01;
    for (const note of SOUND_NOTES[event.kind]) {
      const at = start + note.start;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = note.type ?? "sine";
      osc.frequency.setValueAtTime(note.freq, at);
      // 软起软落，避免"啪"的爆音
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(note.gain, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + note.duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + note.duration + 0.03);
      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          /* 已断开 */
        }
      };
    }
  }

  /** 清掉等待 welcome 的超时（进房成功、断线、销毁时都要清）。 */
  private clearWelcomeDeadline(): void {
    if (!this.welcomeDeadline) return;
    this.timers.cancel(this.welcomeDeadline);
    this.welcomeDeadline = 0;
  }

  // ------------------------------------------------------------------- 访客侧

  private dialHost(): void {
    const peer = this.peer;
    if (!peer || this.destroyed || !this.hostId) return;
    // 首次加入阶段的重拨也显示"连接中（重试）"，让用户知道在自动重试而非卡死。
    this.events.status(
      this.reconnectAttempt > 0 || this.dialAttempts > 0 ? "reconnecting" : "connecting",
    );

    const conn = peer.connect(this.hostId, { reliable: true });
    if (!conn) {
      this.events.status("error", "无法建立到房主的连接");
      return;
    }
    this.hostConn = conn;
    this.awaitingWelcome = true;

    this.clearWelcomeDeadline();
    const welcomeMs = this.joined ? RECONNECT_WELCOME_MS : WELCOME_TIMEOUT_MS;
    this.welcomeDeadline = this.timers.after(welcomeMs, () => {
      this.welcomeDeadline = 0;
      if (this.hostConn !== conn || this.destroyed) return;

      // 首次加入：沿用旧判定（未进房才报），并整体重拨。
      if (!this.joined) {
        const report = shouldReportWelcomeTimeout({
          stillCurrentConnection: this.hostConn === conn,
          joined: this.joined,
          destroyed: this.destroyed,
        });
        if (!report) return;
        if (this.dialAttempts < MAX_DIAL_ATTEMPTS - 1) {
          void this.redialWithFreshPeer();
          return;
        }
        this.events.status("error", "房主没有响应，请确认邀请是否仍然有效");
        return;
      }

      // 进房后断线重连：旧的 joined 判定会吞掉超时，这里用 awaitingWelcome 单独处理。
      if (!this.awaitingWelcome) return;
      if (this.reconnectAttempt < MAX_RECONNECT) {
        this.reconnecting = false;
        void this.redialAfterDrop();
        return;
      }
      this.reconnecting = false;
      this.events.ended("host-left", "与房主的连接已中断，自动重连失败");
    });

    conn.on("open", () => void this.sendHello(conn));
    conn.on("data", (data) => void this.onHostData(conn, data));
    conn.on("close", () => this.onHostLost("与房主的连接已断开"));
    conn.on("error", () => this.onHostLost("与房主的连接出错"));
  }

  /**
   * 首次加入超时后的整体重拨：
   * 丢弃当前 Peer（socket 与半开连接），保留麦克风与发送音频链，
   * 以全新访客 ID 重新注册并再次拨号。
   * 新 socket 可能被公共云路由到更通畅的后端，实测多数慢/卡死于超时的加入因此成功。
   */
  private async redialWithFreshPeer(): Promise<void> {
    if (this.destroyed || !this.me) return;
    this.dialAttempts += 1;
    this.clearWelcomeDeadline();

    // 先摘掉旧连接的监听再关，避免 onHostLost 把这次正常重拨误判成断线。
    const oldConn = this.hostConn;
    this.hostConn = null;
    if (oldConn) {
      try {
        oldConn.removeAllListeners();
        oldConn.close();
      } catch {
        /* noop */
      }
    }
    for (const [peerId, call] of this.calls) {
      try {
        call.close();
      } catch {
        /* noop */
      }
      this.dropAudio(peerId);
    }
    this.calls.clear();

    // 旧的自己（访客 ID）从名册与监测器移除，稍后用新 ID 重建。
    const oldId = this.myId;
    if (oldId) {
      this.members.delete(oldId);
      const oldMonitor = this.monitors.get(oldId);
      if (oldMonitor) {
        this.monitors.delete(oldId);
        try {
          oldMonitor.source.disconnect();
          oldMonitor.analyser.disconnect();
        } catch {
          /* noop */
        }
      }
      this.speaking.delete(oldId);
    }

    this.dropPeer();
    /*
     * 重拨前再拉一次 ICE 凭据：上一次 /ice 可能因 2.5 秒超时退回了纯 STUN，
     * ice.ts 的注释承诺"下一次重拨就用上中继"——那就必须真的在这里补拉，
     * 否则跨网（对称 NAT）用户一次抖动就整场打不洞。
     */
    await ensureIceServers();
    if (this.destroyed) return;
    // 走带退避的重试路径：信令抖一下不该直接把这次重拨判死
    const outcome = await this.openPeerWithRetry(() => guestPeerId(randomToken(12)));
    if (this.destroyed) return;
    if (outcome !== "open") {
      this.events.status("error", outcome);
      return;
    }

    const newId = this.peer?.id ?? "";
    this.myId = newId;
    this.me = { ...this.me, id: newId };
    this.members.set(newId, this.me);
    this.emitMembers();
    // 访客本地说话监测重新挂到新 ID 上。
    const selfStream = this.outgoingStream ?? this.localStream;
    if (selfStream) this.monitor(newId, selfStream, true);

    this.dialHost();
  }

  /**
   * 进房成功之后与房主的连接掉线：尽量用**同一个访客身份**重连，
   * 而不是换 ID——这样房主会把它当成同一位成员的断线重连（锁房也放行），
   * 且不会在名册里多出一个"新的我"。
   */
  private async redialAfterDrop(): Promise<void> {
    if (this.destroyed || !this.me || !this.joined) return;
    if (this.reconnecting) return;
    if (this.reconnectAttempt >= MAX_RECONNECT) return;
    this.reconnecting = true;
    this.reconnectAttempt += 1;
    this.clearWelcomeDeadline();
    this.awaitingWelcome = true;
    this.events.status("reconnecting");

    const oldConn = this.hostConn;
    this.hostConn = null;
    if (oldConn) {
      try {
        oldConn.removeAllListeners();
        oldConn.close();
      } catch {
        /* noop */
      }
    }

    // 信令 socket 也掉了就先补回（open 回调里的自动重连之外，这里主动补一次）。
    if (this.peer && this.peer.disconnected) {
      try {
        this.peer.reconnect();
      } catch {
        /* noop */
      }
    }

    this.timers.after(900, () => {
      if (this.destroyed || !this.joined) return;
      this.awaitingWelcome = true;
      this.dialHost();
    });
  }

  private async sendHello(conn: DataConnection): Promise<void> {
    if (this.destroyed || !this.me) return;
    const nonce = randomToken(16);
    this.nonces.set(conn, nonce);
    // 握手包必须带上"本机能否 AV1 硬解"——共享者据此做双端判断；
    // 拿不到预检结果（老浏览器没 WebCodecs）就报 false，宁可用 H.264。
    await this.startHardwareProbe();
    const proof = this.roomKey
      ? await signGuestProof(this.roomKey, nonce, this.myId, this.code)
      : "";
    if (this.destroyed || this.hostConn !== conn) return;
    this.send(conn, {
      t: "hello",
      personId: this.me.personId,
      sessionId: this.me.sessionId,
      ...(this.accountId ? { accountId: this.accountId } : {}),
      name: this.me.name,
      avatar: this.me.avatar,
      color: this.me.color,
      hasMic: this.me.hasMic,
      muted: this.me.muted,
      ...(this.myAv1Decode ? { av1Decode: true } : {}),
      nonce,
      proof,
    });
  }

  private async onHostData(conn: DataConnection, data: unknown): Promise<void> {
    if (conn !== this.hostConn) return;
    const message = parseHostMessage(data);
    if (!message) return;

    if (message.t === "reject") {
      this.events.ended("rejected", rejectText(message.reason));
      return;
    }

    if (message.t === "welcome") {
      if (conn !== this.hostConn) return;
      // 验证对方确实持有 roomKey，否则可能是占用了房主 ID 的冒充者。
      if (this.roomKey) {
        const ok = await verifyHostProof(this.roomKey, this.lastNonce(conn), message.proof);
        if (!ok) {
          this.events.ended(
            "rejected",
            "无法验证房主身份：请使用房主发出的完整邀请链接",
          );
          return;
        }
      }
      if (conn !== this.hostConn || this.destroyed) return;

      this.hostLastSeen = Date.now();
      this.reconnectAttempt = 0;
      this.reconnecting = false;
      this.awaitingWelcome = false;
      for (const member of message.roster) {
        if (member.id === this.myId) {
          // 同步自己的（被）禁言状态（断线重连后也要恢复）。
          if (this.me) {
            this.me.serverMuted = member.serverMuted ?? false;
            this.me.deafened = member.deafened ?? this.deafened;
            /*
             * 自己的静音状态以**本地选择**为准（确认页的"先静音进入"）。
             * 之前无条件照抄花名册的 muted——而房主侧把访客一律初始化为
             * 静音，导致"取消静音进入"的访客在 welcome 一到就被静音。
             * 花名册只负责恢复房主的强制禁言（serverMuted）。
             */
            if (this.me.serverMuted && !this.me.muted) {
              this.me.muted = true;
              if (this.localStream) {
                for (const track of this.localStream.getAudioTracks()) {
                  track.enabled = false;
                }
              }
            }
          }
          continue;
        }
        this.members.set(member.id, {
          id: member.id,
          personId: member.personId ?? "",
          sessionId: member.sessionId ?? "",
          name: member.name,
          avatar: member.avatar,
          color: member.color,
          muted: member.muted,
          hasMic: member.hasMic,
          isHost: member.isHost,
          serverMuted: member.serverMuted ?? false,
          deafened: member.deafened ?? false,
          ...(member.av1Decode === true ? { av1Decode: true } : {}),
          local: false,
        });
      }
      this.emitMembers();
      this.clearWelcomeDeadline();
      this.events.roomFlags({ locked: message.locked ?? false });
      this.events.status("connected");
      this.send(conn, { t: "joined" });
      this.joined = true;
      // 房主铭牌公告（welcome 里捎带；老房主没有这个字段 = 没有公告）。
      if (typeof message.topic === "string" && message.topic !== this.topic) {
        this.topic = message.topic;
        this.events.topic?.(this.topic);
      }
      // 场景主题：2026-10-22 起改为个人偏好，不再随 welcome 同步（老字段直接忽略）。
      this.startSessionStats();
      // 中途进房：把"电视亮没亮"一并接管（缺席 = 没在共享）。
      if (message.screenShare && !this.screenShareState) {
        this.screenShareState = message.screenShare;
        this.events.screenShare?.(message.screenShare);
      }
      this.callPeers();
      this.startHeartbeat();
      return;
    }

    this.hostLastSeen = Date.now();

    switch (message.t) {
      case "screen-share": {
        const prev = this.screenShareState;
        this.screenShareState = message.state;
        // P2P：广播确认开播后（自己就是共享者），向各成员发起画面直连；
        // 停播（房主代停/自己申报的广播回来）时收线。
        if (message.state?.sharerId === this.myId && !prev) this.startScreenCalls();
        if (!message.state && prev?.sharerId === this.myId) this.closeScreenCalls();
        if (!message.state) this.viewerScreenPrefs.clear();
        this.events.screenShare?.(message.state);
        break;
      }
      case "screen-pref": {
        // 我是共享者才需要处理（房主把某位观众的偏好转过来）
        if (this.screenShareState?.sharerId === this.myId) {
          this.applyViewerScreenPref(message.from, message.mode);
        }
        break;
      }
      case "screen-watch": {
        if (this.screenShareState?.sharerId === this.myId) {
          this.screenWatch.set(message.from, message.state);
          this.applyScreenWatch(message.from);
        }
        break;
      }
      case "theme": {
        // 主题已是个人偏好（2026-10-22）：老版本房主仍会广播，直接忽略。
        break;
      }
      case "roster": {
        const seen = new Set<string>();
        for (const member of message.members) {
          if (member.id === this.myId) {
            if (this.me) {
              this.me.serverMuted = member.serverMuted ?? false;
              const muted = member.muted || this.me.serverMuted;
              if (this.me.muted !== muted) {
                this.me.muted = muted;
                if (this.localStream) {
                  for (const track of this.localStream.getAudioTracks()) {
                    track.enabled = !muted;
                  }
                }
              }
            }
            continue;
          }
          seen.add(member.id);
          this.members.set(member.id, {
            id: member.id,
            personId: member.personId,
            sessionId: member.sessionId,
            name: member.name,
            avatar: member.avatar,
            color: member.color,
            muted: member.muted,
            hasMic: member.hasMic,
            isHost: member.isHost,
            serverMuted: member.serverMuted ?? false,
            ...(member.av1Decode === true ? { av1Decode: true } : {}),
            local: false,
          });
        }
        for (const id of Array.from(this.members.keys())) {
          if (id === this.myId || seen.has(id)) continue;
          this.members.delete(id);
          this.dropMedia(id);
          // 同上：成员走了，他的链路/自愈/节流状态不能留着
          this.clearVoiceHeal(id);
          this.lastDialAt.delete(id);
          this.roomLinkState.delete(id);
        }
        this.emitMembers();
        this.callPeers();
        // 我是共享者时：名单变化（新人进圈/有人退）都要补齐画面直连（幂等）。
        if (this.screenShareState?.sharerId === this.myId) this.startScreenCalls();
        // 房主铭牌公告随名册捎带（改动时会广播一次带 topic 的 roster）。
        if (typeof message.topic === "string" && message.topic !== this.topic) {
          this.topic = message.topic;
          this.events.topic?.(this.topic);
        }
        break;
      }
      case "peer-join": {
        if (message.member.id === this.myId) break;
        this.members.set(message.member.id, {
          id: message.member.id,
          personId: message.member.personId,
          sessionId: message.member.sessionId,
          name: message.member.name,
          avatar: message.member.avatar,
          color: message.member.color,
          muted: message.member.muted,
          hasMic: message.member.hasMic,
          isHost: message.member.isHost,
          serverMuted: message.member.serverMuted ?? false,
          deafened: message.member.deafened ?? false,
          ...(message.member.av1Decode === true ? { av1Decode: true } : {}),
          ...(message.member.accountId ? { accountId: message.member.accountId } : {}),
          local: false,
        });
        this.emitMembers();
        this.callPeers();
        // 访客侧也要看到"又有人进来了"，而不是只有人数悄悄变
        if (!message.member.isHost) {
          this.events.rosterChange({ kind: "join", name: message.member.name });
        }
        break;
      }
      case "peer-leave": {
        const leaving = this.members.get(message.id);
        if (this.members.delete(message.id)) {
          this.dropMedia(message.id);
          this.emitMembers();
          if (leaving) this.events.rosterChange({ kind: "leave", name: leaving.name });
        }
        break;
      }
      case "speaking": {
        this.setSpeaking(message.id, message.speaking);
        break;
      }
      case "chat": {
        this.events.chat({
          id: message.id,
          name: message.name,
          text: message.text,
          ts: message.ts,
          self: false,
        });
        break;
      }
      case "pen": {
        this.events.pen(message.event);
        break;
      }
      case "pen-poses": {
        /*
         * 访客端：把权威位置写进本地地图（吃菜挑最近、蔬菜落点对位都读它），
         * 再交给界面做平滑跟随。
         */
        for (const pose of message.poses) {
          this.penActorX.set(pose.id, pose.x);
          this.penActorLane.set(pose.id, pose.lane);
        }
        this.events.penPoses?.(message.poses, message.ts);
        break;
      }
      case "sound": {
        this.events.sound(message.event);
        break;
      }
      case "kick": {
        // 房主只会把 kick 发给被踢者本人。
        if (message.id === this.myId) {
          if (message.reason === "timeout") {
            // 网络长时间卡顿被移出：明确告知，并立刻自动重新进房
            this.events.status("reconnecting", "网络中断，正在自动重新进房…");
            void this.redialAfterDrop();
          } else {
            this.events.ended("rejected", "你已被房主移出房间");
          }
        }
        break;
      }
      case "force-mute": {
        if (message.id !== this.myId) {
          // 其他成员的状态由随后的 roster 权威同步，这里即时刷新一下。
          const other = this.members.get(message.id);
          if (other) {
            other.serverMuted = message.muted;
            if (message.muted) other.muted = true;
            this.emitMembers();
          }
          break;
        }
        if (this.me) {
          this.me.serverMuted = message.muted;
          if (message.muted) {
            this.me.muted = true;
            if (this.localStream) {
              for (const track of this.localStream.getAudioTracks()) track.enabled = false;
            }
          }
          this.emitMembers();
        }
        break;
      }
      case "lock": {
        this.events.roomFlags({ locked: message.locked });
        break;
      }
      case "interact": {
        this.events.interact(message.event);
        break;
      }
      case "pong": {
        this.hostLastSeen = Date.now();
        break;
      }
      case "ping": {
        // 房主的心跳要回，否则房主会把一个活着的访客判成掉线。
        this.hostLastSeen = Date.now();
        this.send(conn, { t: "pong", ts: message.ts });
        break;
      }
      default:
        break;
    }
  }

  private lastNonce(conn: DataConnection): string {
    return this.nonces.get(conn) ?? "";
  }

  private onHostLost(detail: string): void {
    if (this.destroyed || this.hosting) return;
    // 还没进房：保持首次加入流程（welcome 超时 / 重拨 / 报错）。
    if (!this.joined) {
      this.events.ended("host-left", detail);
      return;
    }
    // 已进房：先把这当成网络抖动自动重连有限次数，仍失败才结束房间。
    if (this.reconnectAttempt < MAX_RECONNECT) {
      void this.redialAfterDrop();
      return;
    }
    this.events.ended("host-left", detail);
  }

  private stopHeartbeat(): void {
    this.heartbeatTimer = 0;
    stopHeartbeatTickerFn();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = 1; // 标记已启动（实际计时由 Worker 承担）
    startHeartbeatTicker(() => this.tickLiveness());
    if (!this.mediaFlowTimer) {
      // 后台不节流：媒体看门狗被压到 1 分钟一次，单向无声就要一分钟后才发现
      this.mediaFlowTimer = this.timers.everyBackground(MEDIA_FLOW_POLL_MS, () => void this.checkMediaFlow());
    }
    if (!this.dialWatchTimer) {
      // 同上：兜底补拨被节流，卡住的人就一直卡着
      this.dialWatchTimer = this.timers.everyBackground(3000, () => this.ensureCalls());
    }
  }

  /**
   * 兜底补拨：房里有成员、但这儿没有到他的媒体连接时，主动拨一条。
   *
   * 为什么需要：谁发起呼叫是按 `myId < peerId` 约定死的。如果**该发起的那一侧
   * 拿不到麦克风流**（设备被占、权限被拒、采集失败），另一侧就会一直等——
   * 双方界面都在房里，却谁也不出声。卡顿、退房重进之后尤其容易踩到。
   */
  private ensureCalls(): void {
    /*
     * 我是共享者时每轮补一次画面呼叫（幂等，已有呼叫直接跳过）。
     *
     * 原来只有"名册变化 / 收到共享状态"这两个时机才补，一旦那次事件丢了
     * （开播后才进房的人、信令抖动、呼叫卡在 new），这个人就永远收不到
     * 共享画面和共享声音——这是"开播后进房的人看不到也听不到"的根因。
     */
    if (!this.destroyed && this.screenShareState?.sharerId === this.myId && this.screenStream) {
      this.startScreenCalls();
    }
    // 没有麦克风也要继续补拨（见 callPeer 的死锁说明）——只有没进房才跳过
    if (this.destroyed || !this.me) return;
    const now = Date.now();
    /** 每个 tick 最多补拨一条：与 MEDIA_STAGGER_MS 的错峰意图保持一致。 */
    let dialed = 0;
    for (const member of this.members.values()) {
      if (member.local) continue;
      const call = this.calls.get(member.id);
      if (call) {
        // 有连接：若长时间没有任何音频进来，说明这条腿已经僵死，清掉让下一轮补拨
        const mediaAt = this.lastMediaAt.get(member.id) ?? 0;
        if (mediaAt) {
          /*
           * 只拆**确定死了**的链路（2026-10-25 实测："刚说完话就变成连不上"）。
           *
           * 以前是"15 秒没收到包就拆"。但 `lastMediaAt` 只在收到 RTP 或 RR 反馈时刷新，
           * 而**静音 / 不说话的对端本来就不发包**——挂着打 Apex 的人 15 秒不吭声太正常了，
           * 于是链路被反复拆掉重拨，界面就一直是"与 TA 的语音链路连接中…"。
           *
           * 现在：
           * - ICE 已经不连通（disconnected/failed/closed）+ 15 秒没包 → 拆；
           * - ICE 仍连着、但对端不是静音/无麦、却 45 秒一个包都没有 → 才算僵死；
           * - 静音/无麦的对端给到 120 秒才判（它们本来就可以长期零发包）。
           */
          const pc = (call as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
          const ice = pc?.iceConnectionState;
          const connected = ice === "connected" || ice === "completed";
          const silentMs = now - mediaAt;
          const silentOk = member.muted || member.hasMic === false;
          const died = !connected && silentMs > 15_000;
          const frozen = connected && silentMs > (silentOk ? 120_000 : 45_000);
          if (died || frozen) {
            this.calls.delete(member.id);
            try {
              call.close();
            } catch {
              /* noop */
            }
            this.dropAudio(member.id);
          }
        }
        continue;
      }
      if (dialed >= 1) continue;
      /*
       * 自愈次数到顶就停手：这条腿已经连续失败 3 次，后台再偷偷拨只会
       * 把界面上的"已断开，可点重新连接"变成"偶尔响一下又断"。
       * 恢复由用户手动 retryVoiceLink 触发（它会清零计数）。
       */
      const heal = this.voiceHeals.get(member.id);
      if (heal && heal.attempts >= VOICE_HEAL_MAX) continue;
      const lastTry = this.lastDialAt.get(member.id) ?? 0;
      if (now - lastTry < 5000) continue; // 别把信令打爆
      this.lastDialAt.set(member.id, now);
      this.callPeer(member.id);
      dialed += 1;
    }
  }

  /**
   * 语音流监看：连着但没数据时自动重拨，免得用户退房重进。
   *
   * 只对"曾经收到过音频"的腿生效——纯收听者（没麦克风）本来就只有 0 字节，
   * 否则会把它当成故障反复重拨。
   */
  /**
   * 一键诊断快照：把"现在到底什么状态"变成可回传的证据。
   *
   * 刻意不含：peerId / personId / IP / 候选地址 / 房间明文码以外的身份信息。
   * 成员用序号表示，昵称保留（排障需要对上号）。
   */
  async diagnostics(appVersion = "web"): Promise<Record<string, unknown>> {
    const peers: Record<string, unknown>[] = [];
    for (const [peerId, call] of this.calls) {
      const pc = (call as { peerConnection?: RTCPeerConnection }).peerConnection;
      const member = this.members.get(peerId);
      const entry: Record<string, unknown> = {
        index: peers.length,
        name: member?.name ?? "?",
        hasMic: member?.hasMic !== false,
        link: this.roomLinkState.get(peerId) ?? "unknown",
        healAttempts: this.voiceHeals.get(peerId)?.attempts ?? 0,
        lastMediaAgoMs: this.lastMediaAt.has(peerId) ? Date.now() - (this.lastMediaAt.get(peerId) ?? 0) : null,
      };
      if (pc) {
        entry["iceConnectionState"] = pc.iceConnectionState;
        entry["connectionState"] = pc.connectionState;
        try {
          const report = await pc.getStats();
          let inbound: Record<string, unknown> | null = null;
          let relay = false;
          let localType = "";
          let pairRtt: number | null = null;
          report.forEach((r) => {
            if (r.type === "inbound-rtp") {
              const i = r as RTCInboundRtpStreamStats & { kind?: string };
              if ((i.kind ?? "") === "audio") {
                inbound = {
                  packetsReceived: i.packetsReceived ?? 0,
                  packetsLost: i.packetsLost ?? 0,
                  jitter: i.jitter ?? 0,
                  bytesReceived: i.bytesReceived ?? 0,
                };
              }
            }
            if (r.type === "candidate-pair") {
              const p = VoiceMesh.chosenPair(report);
              if (p) {
                pairRtt = p.currentRoundTripTime ?? null;
                const local = report.get(p.localCandidateId ?? "") as { candidateType?: string } | undefined;
                localType = local?.candidateType ?? "";
                relay = localType === "relay";
              }
            }
          });
          entry["inbound"] = inbound;
          entry["localCandidateType"] = localType;
          entry["relay"] = relay;
          entry["rttMs"] = pairRtt === null ? null : Math.round(pairRtt * 1000);
        } catch (error) {
          entry["statsError"] = String(error).slice(0, 120);
        }
      }
      peers.push(entry);
    }
    /*
     * 补上"压根没有连接"的成员。
     *
     * 这一点很关键：排"我听不到他"的时候，那条故障腿往往已经被 dropMedia
     * 从 calls 里删掉了——只遍历 calls 会恰好漏掉要排查的那个人，
     * 诊断包里 memberCount 比 peers 多，却看不出缺的是谁、为什么缺。
     */
    for (const [peerId, member] of this.members) {
      if (member.local || this.calls.has(peerId)) continue;
      peers.push({
        index: peers.length,
        name: member.name,
        hasMic: member.hasMic !== false,
        link: this.roomLinkState.get(peerId) ?? "no-call",
        healAttempts: this.voiceHeals.get(peerId)?.attempts ?? 0,
        lastMediaAgoMs: this.lastMediaAt.has(peerId) ? Date.now() - (this.lastMediaAt.get(peerId) ?? 0) : null,
        note: "no-call（媒体连接已断开/尚未建立）",
      });
    }

    const track = this.localStream?.getAudioTracks()[0];
    return {
      at: new Date().toISOString(),
      app: { version: appVersion },
      env: {
        ua: navigator.userAgent,
        // 计时器跑在 Worker 还是主线程：排"后台被节流"类问题时一眼就能确认
        timerMode: backgroundTimerMode(),
        desktop: typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
        hidden: document.hidden,
        online: navigator.onLine,
      },
      room: {
        hosting: this.hosting,
        memberCount: this.members.size,
        code: this.code,
        joined: this.joined,
      },
      audio: {
        ctxState: this.ctx?.state ?? "none",
        ctxSampleRate: this.ctx?.sampleRate ?? null,
        micReadyState: track?.readyState ?? "none",
        micEnabled: track?.enabled ?? null,
        micMuted: track?.muted ?? null,
        micVolume: this.micGainNode ? Number(this.micGainNode.gain.value.toFixed(2)) : null,
        noiseSuppression: this.nsEnabled,
        outgoingStream: Boolean(this.outgoingStream),
      },
      peers,
      events: this.diagLog.slice(-200),
    };
  }

  private async checkMediaFlow(): Promise<void> {
    if (this.destroyed || !this.me) return;
    /*
     * 先查自己：麦克风被拔掉/被系统收回时，轨道会 ended——此时自己发出去的是空流，
     * 别人听不见，而界面还显示"麦克风开"。这种事不能等用户自己发现。
     */
    const own = this.localStream?.getAudioTracks()[0];
    if (own && own.readyState === "ended" && !this.micEndedNotified) {
      this.micEndedNotified = true;
      this.pushRoomEvent("error", "麦克风轨道已结束（设备被断开）");
      this.events.micProblem?.("麦克风被断开了（设备拔掉或被系统收回）：请在设置里重新选择麦克风");
    } else if (own && own.readyState === "live") {
      this.micEndedNotified = false;
    }
    if (this.calls.size === 0) return;
    for (const [peerId, call] of [...this.calls]) {
      const pc = (call as { peerConnection?: RTCPeerConnection }).peerConnection;
      if (!pc || pc.connectionState === "closed") continue;
      let packets = 0;
      /** 对方对我们这条流的反馈次数（RTCP receiver report）：静音也在增长 */
      let acks = 0;
      try {
        const stats = await pc.getStats();
        stats.forEach((report) => {
          if (report.type === "inbound-rtp") {
            const r = report as RTCInboundRtpStreamStats & { kind?: string };
            if ((r.kind ?? (r as { mediaType?: string }).mediaType) !== "audio") return;
            packets += r.packetsReceived ?? 0;
            return;
          }
          if (report.type === "remote-inbound-rtp") {
            // 对方回给我们的 RR 次数：链路活着就会周期性增长，与"他说不话说"无关
            // TS 的 DOM 类型里没有这个统计结构的定义，按字段结构断言
            const r = report as { roundTripTimeMeasurements?: number };
            acks += r.roundTripTimeMeasurements ?? 0;
          }
        });
      } catch {
        continue;
      }
      const prev = this.flowSamples.get(peerId);
      const watcher = this.members.get(peerId);
      const iceOk = pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed";
      const grewInbound = packets > (prev?.packets ?? 0) && packets > 0;
      /*
       * ① 包还在到，但我这边没出声 → 本机播放链断了（见 playbackMisses 注释）。
       *    连续两次（≈12 秒）确认才重建，避免和 play() 的异步握手抢跑。
       */
      if (grewInbound) {
        if (this.isPlaying(peerId)) {
          this.playbackMisses.delete(peerId);
        } else {
          const miss = (this.playbackMisses.get(peerId) ?? 0) + 1;
          this.playbackMisses.set(peerId, miss);
          if (miss >= 2) {
            this.playbackMisses.delete(peerId);
            const stream = this.remoteStreams.get(peerId);
            if (stream) {
              const who = watcher?.name ?? peerId.slice(0, 6);
              this.pushRoomEvent("error", `与「${who}」的播放通道断了（包还在到），已重建`);
              this.playStream(peerId, stream);
            }
          }
        }
      }
      /*
       * ② 单向不通（见 inboundZeroPolls 注释）。
       *
       * 下面对"链路是否活着"用的是**双向合并**口径（任一方向有进展即活），
       * 好处是静默期不误判，坏处是**半条腿判不出来**：a 听不到 e、e 听得到 a 时，
       * e 持续回 RTCP，a 这边的 acks 一直在涨 → 判成健康 → 永不重拨。
       * 所以这里单独看"我到底有没有收到他的声音"：
       *   有麦 + 没闭麦 + ICE 已通，但入向包数一直不涨 →
       *   从没收到过（0 包）连续 3 次（≈18 秒）、
       *   收到过又停、但他还在回 RTCP 连续 2 次（≈12 秒）、
       *   收到过又停且连 RTCP 也没了连续 5 次（≈30 秒）→ 重拨。
       * 静默期照样发包（usedtx=0），所以"不涨"不是安静，是没到。
       */
      if (watcher && watcher.hasMic !== false && !watcher.muted && iceOk) {
        if (grewInbound) {
          this.inboundZeroPolls.delete(peerId);
        } else {
          const misses = (this.inboundZeroPolls.get(peerId) ?? 0) + 1;
          this.inboundZeroPolls.set(peerId, misses);
          const acksAlive = prev ? acks > prev.acks : false;
          const limit = packets === 0 ? 3 : acksAlive ? 2 : 5;
          if (misses >= limit) {
            this.inboundZeroPolls.delete(peerId);
            this.flowSamples.delete(peerId);
            const who = watcher.name ?? peerId.slice(0, 6);
            this.pushRoomEvent("error", `与「${who}」的语音只有单向（收不到对方的包），自动重拨`);
            this.roomLinkState.set(peerId, "failed");
            this.events.mediaState(peerId, "failed");
            this.scheduleVoiceHeal(peerId, call, 0);
            continue;
          }
        }
      } else {
        this.inboundZeroPolls.delete(peerId);
      }
      if (!prev) {
        this.flowSamples.set(peerId, { packets, acks, stalls: 0, sawPackets: packets > 0 });
        continue;
      }
      /*
       * 关键：只要**任一方向还有进展**就算链路活着。
       *
       * - 他在说话：我们这边的 inbound 包数在涨；
       * - 他长时间不说话（FPS 蹲点听脚步）：包数不涨，但他仍在收我们的声音、
       *   仍会周期性回 RTCP 报告（acks 涨）——这同样证明链路是通的。
       *
       * 只有"我收不到他的包"且"他也不回任何反馈"持续足够久，才真的是死了。
       */
      if (packets > prev.packets || acks > prev.acks) {
        prev.packets = packets;
        prev.acks = acks;
        prev.sawPackets = true;
        prev.stalls = 0;
        this.lastMediaAt.set(peerId, Date.now());
        continue;
      }
      if (!prev.sawPackets) continue; // 从没收到过：可能只是纯收听，别乱拨
      prev.stalls += 1;
      if (prev.stalls < MEDIA_FLOW_STALL_LIMIT) continue;

      this.flowSamples.delete(peerId);
      const name = this.members.get(peerId)?.name ?? peerId.slice(0, 6);
      const secs = Math.round((MEDIA_FLOW_POLL_MS * MEDIA_FLOW_STALL_LIMIT) / 1000);
      this.pushRoomEvent("error", `与「${name}」的语音 ${secs} 秒没有收到任何包，自动重拨`);
      this.roomLinkState.set(peerId, "failed");
      this.events.mediaState(peerId, "failed");
      this.scheduleVoiceHeal(peerId, call, 0);
    }
  }

  // --------------------------------------------------------------- 存活与说话

  /**
   * 双向心跳：两侧都发 ping、都回 pong，各自维护对端的 lastSeen。
   * 这样"某个人的网络悄悄断了"两侧都能在几秒内发现，而不是只靠 TCP 关闭事件。
   */
  private tickLiveness(): void {
    if (this.destroyed) return;
    const now = Date.now();

    if (this.hosting) {
      for (const guest of Array.from(this.guests.values())) {
        if (!guest.joined) continue;
        if (now - guest.lastSeen > HEARTBEAT_TIMEOUT_MS) {
          /*
           * 媒体还在流就别踢：信令心跳可能只是被后台节流丢了，
           * 而语音一直是通的。只有"既没心跳、也没音频数据"才算真掉线。
           */
          const mediaAt = this.lastMediaAt.get(guest.member.id) ?? 0;
          if (now - mediaAt < HEARTBEAT_TIMEOUT_MS) continue;
          this.evictGuest(guest.member.id, "timeout");
        }
      }
      this.broadcastHost({ t: "ping", ts: now });
      return;
    }

    if (!this.hostConn || !this.hostConn.open) return;
    this.send(this.hostConn, { t: "ping", ts: now });
    if (now - this.hostLastSeen > HOST_SILENCE_TIMEOUT_MS) {
      // 半开连接（socket 没报 close 但房主已无响应）：同样先自动重连。
      if (this.reconnectAttempt < MAX_RECONNECT) {
        void this.redialAfterDrop();
        return;
      }
      this.events.ended("host-left", "长时间收不到房主响应，连接可能已中断");
    }
  }

  private startSpeakingLoop(): void {
    if (this.speakingTimer) return;
    // 说话高亮：被节流会让"谁在说话"在后台时几乎停更
    this.speakingTimer = this.timers.everyBackground(SPEAKING_POLL_MS, () => this.pollSpeaking());
  }

  private pollSpeaking(): void {
    if (this.destroyed || this.monitors.size === 0) return;
    const now = Date.now();
    const dt = this.lastSpeakingPollAt ? now - this.lastSpeakingPollAt : SPEAKING_POLL_MS;
    this.lastSpeakingPollAt = now;

    let started = false;
    let stopped = false;

    for (const [id, monitor] of this.monitors) {
      monitor.analyser.getByteFrequencyData(monitor.data);
      let sum = 0;
      for (const value of monitor.data) sum += value;
      const level = sum / monitor.data.length;

      const member = this.members.get(id);
      // 静音的人不该被判为"正在说话"，交给判定器直接复位
      const result = monitor.detector.push(level, dt, !(member?.muted ?? false));
      if (!result.changed) continue;

      if (result.active) started = true;
      else stopped = true;

      if (this.hosting && !monitor.local) {
        this.setSpeaking(id, result.active);
      }
      if (monitor.local) {
        this.setSpeaking(this.myId, result.active);
        if (!this.hosting) this.send(this.hostConn, { t: "speaking", speaking: result.active });
      }
    }

    if (started || stopped) this.emitSpeaking(started);
  }

  private setSpeaking(id: string, active: boolean): void {
    if (active) this.speaking.add(id);
    else this.speaking.delete(id);
  }

  /**
   * 上报"谁在说话"。
   *
   * 起音（有人刚开始说）**不节流**：动画要立刻跟上，这是体验的关键。
   * 收音节流：避免短暂停顿把动画打得忽闪忽闪。
   *
   * 但节流**不能直接丢弃**停止事件——那会造成单向饥饿：
   * 音量是间歇性的（说话/停顿快速交替）时，"开始"每次都通过、
   * "停止"每次都被丢掉，界面就永远停在"正在说话"（实测猪卡住不动就是这个原因）。
   *
   * 所以被节流时改为**安排一次补发**（尾部触发），保证最终状态一定送达。
   */
  private emitSpeaking(started = false): void {
    const now = Date.now();
    if (started || now >= this.speakingEmitAt) {
      // 起音立刻发；收音若已过窗口也立刻发
      if (this.speakingEmitTimer) {
        window.clearTimeout(this.speakingEmitTimer);
        this.speakingEmitTimer = 0;
      }
      this.speakingEmitAt = now + SPEAKING_EMIT_MS;
      this.events.speaking(Array.from(this.speaking));
      return;
    }
    // 还没到窗口：安排补发（只留一个），而不是丢掉这次变化
    if (this.speakingEmitTimer) return;
    this.speakingEmitTimer = this.timers.after(this.speakingEmitAt - now, () => {
      this.speakingEmitTimer = 0;
      this.speakingEmitAt = Date.now() + SPEAKING_EMIT_MS;
      this.events.speaking(Array.from(this.speaking));
    });
  }

  // ------------------------------------------------------------------ 媒体连接

  /** 只对"ID 比我的大"的同伴发起呼叫，双方各自负责一半的边，天然不会重复。 */
  private shouldCall(peerId: string): boolean {
    return this.myId < peerId;
  }

  /**
   * 从 getStats 里挑出**真正在用**的那条候选对。
   *
   * 为什么不能"只要有一条 succeeded 的对是中继就算中继"：直连和中继可能同时
   * 处于 succeeded，这时界面会显示"中继"，让人以为没走直连（业主反馈）。
   * 正确口径是 ICE 最终**选中**的那条（`selected`），老实现没有该字段时
   * 才退回 nominated + succeeded。
   */
  private static chosenPair(stats: RTCStatsReport): RTCIceCandidatePairStats | null {
    let selected: RTCIceCandidatePairStats | null = null;
    let nominated: RTCIceCandidatePairStats | null = null;
    stats.forEach((report) => {
      if (report.type !== "candidate-pair") return;
      const pair = report as RTCIceCandidatePairStats & { selected?: boolean };
      if (pair.selected === true) selected = pair;
      else if (!nominated && pair.state === "succeeded" && pair.nominated === true) nominated = pair;
    });
    return selected ?? nominated;
  }

  // ---------------------------------------------------------------- P2P 屏幕直连

  /** 取 PeerJS MediaConnection 底层的 RTCPeerConnection（还没建好时为 undefined）。 */
  private screenPeerConnection(call: MediaConnection): RTCPeerConnection | undefined {
    return (call as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
  }

  /** 共享者的画面流（P2P 模式下发给各成员；SFU 模式为 null）。 */
  private screenStream: MediaStream | null = null;
  /** P2P 画面链路当前用的画质档位（由 requestScreenShare 带入）。 */
  private screenQuality: ShareQuality = "fhd1080";
  /** P2P 屏幕呼叫（共享者 → 各成员，一人一条）。 */
  private screenCalls = new Map<string, MediaConnection>();
  /** 预览档码率（bps）：只给"在房间里挂着、没点开灯箱"的观众发这么多。 */
  private static readonly PREVIEW_SCREEN_BITRATE = 500_000;

  /**
   * 每位观众的"看不看共享"（共享者视角，2026-10-25）：
   * watch=满码率 / preview=低码率缩略 / off=完全不发（关掉那一路，省上行）。
   */
  /** 本机账号 ID（未登录为 null）：只随 hello/名册广播，给"加好友"用。 */
  private accountId: string | null = null;
  private screenWatch = new Map<string, ScreenWatchState>();
  /** 我自己作为观众时的观看状态。 */
  private myScreenWatch: ScreenWatchState = "preview";
  /** 每条画面呼叫的发起时刻：用于回收"发出去了但一直没连上"的僵尸呼叫。 */
  private screenCallAt = new Map<string, number>();
  /** 每条 P2P 画面链路的自适应调谐器（按 peerId）——负责码率与降级阶梯。 */
  private screenTuners = new Map<string, ScreenSenderTuner>();
  /** 每条 P2P 画面链路的自愈解绑函数（按 peerId，close 时调用）。 */
  private screenHealers = new Map<string, () => void>();
  /** 观众端：收到的画面呼叫 → 自愈解绑函数（呼叫对象作键，关闭时清理）。 */
  private viewerHeals = new WeakMap<MediaConnection, () => void>();

  /**
   * 房间遥测（仅房主）：会话档案 + 成员明细。
   * 经信令 WebSocket 顺路上报（ROOM-SNAPSHOT，每 ~10 秒），由自建信令服务落历史档案。
   * 口径：成员 = 匿名编号（sessionScopedId）+ 昵称（业主确认收集）；只有技术指标，无任何内容。
   */
  private roomTelemetry: {
    sessionId: string;
    code: string;
    createdAt: string;
    members: Map<string, {
      peerId: string; name: string; joinedAt: string; leftAt: string | null;
      rttSum: number; rttCount: number; rttMax: number;
      jitterMax: number; lossPct: number; link: string;
      reconnects: number; speakingS: number; runtime: string; version: string;
    }>;
    events: { at: string; kind: string; detail: string }[];
    share: { active: boolean; totalS: number; transport: string; last: string };
    timer: number;
  } | null = null;
  /** 每个成员最近的媒体链路状态（direct/relay/…），供遥测取"接入方式"。 */
  private roomLinkState = new Map<string, string>();

  /** 开播确认后（自己就是共享者）：向所有成员发起画面直连（幂等）。 */
  private startScreenCalls(): void {
    if (!this.screenStream || this.destroyed) return;
    for (const member of this.members.values()) {
      if (member.local) continue;
      this.callScreenPeer(member.id);
    }
    // 名单变化（有人进/出）：已建立的连接也要按新的观众数重新分摊码率
    this.retuneScreenSenders();
  }

  private callScreenPeer(peerId: string): void {
    if (!this.peer || !this.screenStream) return;
    const existing = this.screenCalls.get(peerId);
    if (existing) {
      /*
       * 有一条就跳过会漏掉"offer 丢了 / 对方还没进房就拨了"的僵尸呼叫：
       * 那条 call 永远停在 new，map 里一直占位，这个人就再也收不到共享
       * （实测房间 2354：开播后才进房的人永久黑屏 + 无共享声音）。
       * 现在：呼叫已死，或超过 12 秒还没连上，就丢掉重拨。
       */
      const startedAt = this.screenCallAt.get(peerId) ?? 0;
      const zombie = !startedAt || Date.now() - startedAt > 12_000;
      if (!this.isCallDead(existing) && !zombie) return;
      try {
        existing.close();
      } catch {
        /* noop */
      }
      this.screenCalls.delete(peerId);
      this.screenCallAt.delete(peerId);
    }
    const viewer = this.members.get(peerId);
    const watchState = this.screenWatch.get(peerId) ?? "preview";
    // 不看的人不拨号：这条是"真省上行"，比把码率调小更彻底
    if (watchState === "off") return;
    const isPreview = watchState === "preview";
    const viewers = Math.max(1, this.watcherCount());
    const targetBitrate = isPreview
      ? VoiceMesh.PREVIEW_SCREEN_BITRATE
      : perViewerBitrate(this.screenQuality, viewers);
    // 双端 AV1 判断（逐观众）：本机有 AV1 硬编，且**这一位观众**报了 AV1 硬解，
    // 才把 AV1 提到 H.264 之前。任何一位观众不支持，给他的流仍是 H.264。
    const useAv1 = this.hwProbe?.av1 === true && viewer?.av1Decode === true;
    // 起始码率：按这位观众分摊后的码率起步（上限的 75%），跳过编码器的开局爬坡。
    const startKbps = Math.round((targetBitrate * 0.75) / 1000);
    // 与语音同一套 PeerJS 传输；metadata 标记让对端知道这是画面呼叫（不给流、只收）。
    // sdpTransform：把 offer 里的 H.264（High Profile 优先）——或双端都支持时的 AV1
    // ——提到 m=video 首位，并注入起始码率。PeerJS 自己出 offer，我们没机会调
    // setCodecPreferences，不重排就会协商到 VP8 软编（1080p60 下必糊）。
    const call = this.peer.call(peerId, this.screenStream, {
      metadata: { kind: "screen-share", sessionId: this.screenShareState?.sessionId ?? "" },
      sdpTransform: (sdp: string) =>
        opusSdpTransform("music")(
          boostScreenOfferSdp(sdp, { codec: useAv1 ? "av1" : "h264", startBitrateKbps: startKbps }),
        ),
    });
    if (!call) return;
    this.screenCalls.set(peerId, call);
    this.screenCallAt.set(peerId, Date.now());
    const pc = this.screenPeerConnection(call);
    if (pc) void applyAudioProfile(pc, "music");
    if (pc && isPreview) {
      /*
       * 预览档：房间里挂着但没点开灯箱的观众，只发 500kbps / 15fps / 半分辨率的缩略流。
       * 这里**不建 tuner**——调谐器会按满档参数 retune，把预览档拉回去。
       */
      void applyScreenSenderParams(pc, this.screenQuality, {
        maxBitrate: VoiceMesh.PREVIEW_SCREEN_BITRATE,
        maxFramerate: 15,
        scaleResolutionDownBy: 2,
      });
      call.on("close", () => {
        if (this.screenCalls.get(peerId) === call) {
          this.screenCalls.delete(peerId);
          this.screenCallAt.delete(peerId);
        }
      });
      return;
    }
    if (!pc) {
      call.on("close", () => {
        if (this.screenCalls.get(peerId) === call) {
          this.screenCalls.delete(peerId);
          this.screenCallAt.delete(peerId);
        }
      });
      return;
    }
    // PeerJS 不会替我们设任何发送参数——只有 SFU 那条路会调用
    // applyScreenSenderParams，所以 P2P 链路必须自己下发码率/帧率/降级阶梯，
    // 否则菜单里选的档位对这条链路完全无效（"P2P 看着糊"的直接原因之一）。
    //
    // 下发交给调谐器（它自己会按协商时机重试、并在链路吃紧时按观众偏好降档）；
    // 这里只补两个"更早一次"的触发点：① 同步（PeerJS 构造时已 addTrack）；
    // ② 协商进入 stable（此时 setParameters 才一定被接受）。
    const tuner = createScreenSenderTuner(pc, this.screenQuality, {
      maxBitrate: targetBitrate,
      // 观众自己选的偏好（清晰/流畅）逐连接生效；没选过 = auto
      preference: this.viewerScreenPrefs.get(peerId) ?? "auto",
      // 档位记忆：重连/下次开播从上次稳定档位起步，坏链路不再重爬 18 秒
      memory: true,
      onStep: (point: TunePoint, reason: string) => {
        // 观众端的画面会随之变化，共享者这边给一条可读提示（不弹窗）
        if (reason === "recover") return;
        console.info(
          `[screen-share] 链路受限（${reason}），已自动降到 ${RESOLUTION_LADDER_LABEL[point.step] ?? "更低分辨率"} · ${point.fps}fps`,
        );
      },
    });
    this.screenTuners.set(peerId, tuner);

    const onSignal = () => {
      if (pc.signalingState === "stable") tuner.retune();
    };
    const onState = () => {
      if (pc.connectionState === "connected") tuner.retune();
    };
    pc.addEventListener("signalingstatechange", onSignal);
    pc.addEventListener("connectionstatechange", onState);
    // 2s 后如果一次都没下发成功，说明被浏览器拒了（参数没生效是"糊"的常见原因）
    this.timers.after(2500, () => {
      if (!this.destroyed && tuner.applied() === 0) {
        console.warn("[screen-share] P2P 发送端参数下发失败，浏览器将沿用默认编码参数（画面可能偏糊）");
      }
    });

    // 抖动自愈（P2-13）：短暂掉线先 restartIce；彻底断了才重拨一条新呼叫
    const stopHeal = healScreenConnection(pc, {
      retries: 2,
      onRetry: () => {
        if (this.destroyed || this.screenCalls.get(peerId) !== call) return;
        try {
          call.close();
        } catch {
          /* noop */
        }
        this.screenCalls.delete(peerId);
        tuner.stop();
        this.screenTuners.delete(peerId);
        this.timers.after(1200, () => this.callScreenPeer(peerId));
      },
    });
    this.screenHealers.set(peerId, stopHeal);

    call.on("close", () => {
      pc.removeEventListener("signalingstatechange", onSignal);
      pc.removeEventListener("connectionstatechange", onState);
      tuner.stop();
      this.screenTuners.delete(peerId);
      this.screenHealers.get(peerId)?.();
      this.screenHealers.delete(peerId);
      if (this.screenCalls.get(peerId) === call) this.screenCalls.delete(peerId);
    });
  }

  /** 共享者本机的画面发送端连接（P2P 直连；灯箱的"发送端自检"用它取 getStats）。 */
  screenSenderPeerConnection(): RTCPeerConnection | null {
    for (const call of this.screenCalls.values()) {
      const pc = this.screenPeerConnection(call);
      if (pc) return pc;
    }
    return null;
  }

  /** 观众数变化：对已建立的画面连接重新分摊码率（各自的降级档位保持不变）。 */
  private retuneScreenSenders(): void {
    const viewers = Math.max(1, this.members.size - 1);
    const maxBitrate = perViewerBitrate(this.screenQuality, viewers);
    for (const tuner of this.screenTuners.values()) tuner.retune(maxBitrate);
  }

  private closeScreenCalls(): void {
    for (const tuner of this.screenTuners.values()) tuner.stop();
    this.screenTuners.clear();
    for (const stop of this.screenHealers.values()) stop();
    this.screenHealers.clear();
    for (const call of this.screenCalls.values()) {
      try {
        call.close();
      } catch {
        /* noop */
      }
    }
    this.screenCalls.clear();
    this.screenStream = null;
  }

  /**
   * P2P 画面接收端：挂**自适应**抖动缓冲（150~1200ms，按实测 jitter 取 4 倍抖动）。
   *
   * 原来是固定 600ms 一刀切：同城直连白等半秒（围炉对不上嘴）、跨城/移动网又可能
   * 不够（一抖就卡顿）。现在按链路实测抖动动态取值，两端都合适。
   * 返回值只做记录，停止函数存进 viewerJitters（连接关闭时收）。
   */
  private smoothScreenReceivers(call: MediaConnection): void {
    const pc = this.screenPeerConnection(call);
    if (!pc) return;
    const range = jitterTargetFor(this.screenLatency);
    const stop = createJitterBufferTuner(pc, { minMs: range.min, maxMs: range.max });
    this.viewerJitters.set(call, stop);
  }

  /** 观众端：应答共享者的画面呼叫（只收不发），流经事件交给界面。 */
  private onIncomingScreenCall(call: MediaConnection, sessionId: string): void {
    /*
     * 只有"两边都拿得到 sessionId 且确实不同"才算过期会话。
     *
     * `sessionId` 是共享者拨号那一刻的本地状态：他刚点开播、还没收到房主的
     * 广播时，metadata 里就是空串。以前空串一律 != 本地 sessionId → 直接 close，
     * 表现就是"房主看不到访客的共享"（2026-10-25 反馈）。
     */
    if (this.screenShareState && sessionId && this.screenShareState.sessionId !== sessionId) {
      try {
        call.close();
      } catch {
        /* noop */
      }
      return;
    }
    call.answer(undefined, { sdpTransform: opusSdpTransform("music") });
    call.on("stream", (stream) => {
      /*
       * 只关"确认过期"的会话：`screenShareState` 为 null 说明 welcome 还没处理完，
       * 这是**新进房最常见的时序**（共享者的媒体呼叫比房主的名册/状态先到）。
       * 以前这里把 null 也判成过期，直接 close，而共享者那边的 screenCalls 里
       * 已经有这条，不会重拨 → 新人为永久黑屏 + 没有共享声音（实测房间 2354）。
       */
      const state = this.screenShareState;
      if (state && sessionId && state.sessionId !== sessionId) {
        try {
          call.close();
        } catch {
          /* noop */
        }
        return;
      }
      // 观众端抖动缓冲按实测抖动自适应（P0-5 的改进版），
      // 并在短暂抖动时自愈（P2-13）：先 restartIce，而不是让画面就此冻住。
      this.viewerJitters.get(call)?.();
      this.smoothScreenReceivers(call);
      const pc = this.screenPeerConnection(call);
      if (pc && !this.viewerHeals.has(call)) {
        this.viewerHeals.set(call, healScreenConnection(pc, { retries: 2 }));
      }
      this.events.screenStream?.(stream, call);
    });
    call.on("close", () => {
      this.viewerHeals.get(call)?.();
      this.viewerHeals.delete(call);
      this.viewerJitters.get(call)?.();
      this.viewerJitters.delete(call);
    });
  }

  private callPeers(): void {
    // 与房主的媒体立即建立；访客间逐个错峰，避免信令风暴把公共云队列打爆
    // （人越多越明显：这正是"前两个人能进、后面的人卡在加入"的诱因之一）。
    let delay = 0;
    /*
     * 大房间把错峰间隔压窄：13 人房里每个客户端要向 6 个人发起呼叫，
     * 固定 1.2 秒要 7 秒才拨完，进房后长时间"还有人没声音"。
     */
    const stagger = this.members.size > 8 ? 700 : MEDIA_STAGGER_MS;
    for (const member of this.members.values()) {
      if (member.local || !this.shouldCall(member.id)) continue;
      if (member.id === this.hostId) {
        this.callPeer(member.id);
      } else {
        delay += stagger;
        /*
         * 定时器到点时**再确认人还在**：roster 每次变动都会重排一批定时器，
         * 期间有人离开时，原来的实现仍会拿着旧 id 去拨一次（白打信令）。
         */
        this.timers.after(delay, () => {
          if (this.destroyed || !this.members.has(member.id)) return;
          this.callPeer(member.id);
        });
      }
    }
  }

  private callPeer(peerId: string): void {
    /*
     * 没有麦克风也要发起（2026-10-25 修死锁）。
     *
     * 原来这里 `!stream` 直接 return，注释里假设"对方会 call 我"。但拨号方是由
     * `shouldCall = myId < peerId` **单边决定**的：如果被指定的拨号方恰好没有麦克风
     * （没插麦/采集失败/纯收听），他既不拨、对方又按规则不拨 → 两边永远连不上。
     * 现象就是"别人重进都能连上，只有他那个一直连接中"。
     *
     * 现在没麦时用一条**空流**发起呼叫：协商成 recvonly，我照样能听见对方，
     * 只是不发送音频（本来也没有可发的）。
     */
    const stream = this.outgoingStream ?? this.localStream ?? new MediaStream();
    if (!this.peer || this.calls.has(peerId)) return;
    // 已经不在名册里的人不拨（自愈/错峰定时器都可能比"他离开"晚一拍）
    if (!this.members.has(peerId)) return;
    const call = this.peer.call(peerId, stream, {
      // 语音参数显式化：关 DTX（静音段停发会让恢复时的起音发虚），码率 40k
      sdpTransform: opusSdpTransform("voice"),
    });
    if (!call) return;
    this.track(call, peerId);
  }

  private onIncomingCall(call: MediaConnection): void {
    // 屏幕共享的 P2P 画面呼叫：元数据里带 kind 标记，与语音呼叫分流。
    const meta = (call as unknown as { metadata?: { kind?: string; sessionId?: string } }).metadata;
    if (meta?.kind === "screen-share") {
      this.onIncomingScreenCall(call, meta.sessionId ?? "");
      return;
    }
    // 已有连接时不重复应答（重复 answer 会被 PeerJS 警告并丢弃）。
    if (this.calls.has(call.peer)) {
      const existing = this.calls.get(call.peer);
      /*
       * 已有连接时通常要拒绝重复呼叫（重复 answer 会被 PeerJS 警告并丢弃）。
       * **但旧连接已经死了要放行**——这是自愈重拨的关键一步：
       * 对方发现链路断开后会重拨一条新连接，如果这里因为"我手里还有旧 call"
       * 把新呼叫关掉，自愈就永远不成立（实测就是这个问题）。
       */
      const stale = existing ? this.isCallDead(existing) : true;
      /*
       * 呼叫冲突（glare）：两边同时拨，各自都收到对方的来电。
       *
       * 原来一律"留自己的、拒对方的"，而 PeerJS 关闭一条**未应答**的呼叫
       * 不会给对方任何信令——于是两边各留一条永远建不起来的 call，占着
       * calls 让兜底补拨也跳过（calls.has 直接 continue）。这对人就会僵在
       * "连接中"十几秒甚至整场没声音，而且两边界面一切正常。
       *
       * 现在按既有约定裁决：只有"该发起的那一侧"（myId < peerId）保留自己的
       * 呼叫，另一侧主动让位——关掉自己那条，接下对方的来呼。
       */
      const keepMine = this.shouldCall(call.peer);
      if (existing && existing !== call && !stale && keepMine) {
        try {
          call.close();
        } catch {
          /* noop */
        }
        return;
      }
      if (existing && existing !== call) {
        try {
          existing.close();
        } catch {
          /* noop */
        }
        if (this.calls.get(call.peer) === existing) this.calls.delete(call.peer);
        this.clearVoiceHeal(call.peer);
        this.dropAudio(call.peer);
      }
    }
    // 应答必须用处理后的发送流（降噪 + 音量增益），否则房主/被呼方发出的
    // 声音绕过整条发送链，降噪和麦克风增强对这一路完全不生效。
    const outgoing = this.outgoingStream ?? this.localStream;
    if (outgoing) call.answer(outgoing, { sdpTransform: opusSdpTransform("voice") });
    else call.answer(undefined, { sdpTransform: opusSdpTransform("voice") });
    this.track(call, call.peer);
  }

  private track(call: MediaConnection, peerId: string): void {
    this.calls.set(peerId, call);
    call.on("stream", (stream) => this.playStream(peerId, stream));
    /*
     * 只清理"当前这条"连接：自愈重拨时旧 call 的 close 可能迟到，
     * 那时新 call 已经在放声音了，按 peerId 一把梭会把新声音也清掉。
     */
    const drop = () => {
      if (this.calls.get(peerId) !== call) return;
      this.calls.delete(peerId);
      this.dropAudio(peerId);
      /*
       * 人在房里、连接却没了（对端关掉呼叫 / 连接被系统回收）：
       * 之前这里只是静音收场，界面还会一直显示"已连接/中继"，
       * 用户只会觉得"突然听不到他了"。现在标记失败并进入自愈。
       * 成员真的离开时 members.has 为 false，不会误触发。
       */
      if (!this.destroyed && this.members.has(peerId)) {
        this.roomLinkState.set(peerId, "failed");
        this.events.mediaState(peerId, "failed");
        this.scheduleVoiceHeal(peerId, call, VOICE_HEAL_GRACE_MS);
      }
    };
    call.on("close", drop);
    call.on("error", drop);
    this.wireMediaState(call, peerId);
  }

  /**
   * 监听底层 RTCPeerConnection 的 ICE 状态，把"直连 / 中继 / 失败"报给界面。
   * PeerJS 在 call/answer 稍晚才创建 peerConnection，拿不到时短轮询重试。
   */
  private wireMediaState(call: MediaConnection, peerId: string): void {
    let tries = 0;
    const attach = () => {
      const pc = (call as { peerConnection?: RTCPeerConnection }).peerConnection;
      if (!pc) {
        if (tries++ < 15 && !this.destroyed) this.timers.after(200, attach);
        return;
      }
      // 语音优先于画面：上行紧张时（全屏共享 8 Mbps 会跟语音抢带宽）先牺牲
      // 画面的清晰度/帧率，绝不让语音断续。画面侧的 priority:low 在
      // applyScreenSenderParams 里设，两边口径一致。
      this.boostVoicePriority(pc);
      // 码率上限 + contentHint 落到实际发送端（SDP 里的值只是期望）
      void applyAudioProfile(pc, "voice");
      /*
       * 媒体证据要轮询：ICE 变 connected 时通常一个包还没来，
       * 而之后再没有事件会触发检查——只看一次会把好好的连接判成失败
       * （实测：两端都卡在"连接中"，5 秒后被自愈重拨打乱）。
       */
      let mediaProbes = 0;
      let classifying = false;
      const classify = async () => {
        if (classifying || this.destroyed) return;
        classifying = true;
        try {
          await classifyOnce();
        } finally {
          classifying = false;
        }
      };
      const classifyOnce = async () => {
        /*
         * 身份守卫：旧连接的 classify 链（含 700ms 重探，最多 20 次）可能在
         * 新连接已经接管之后才回来。没有这道守卫，它会把新连接的自愈计数清零、
         * 把链路状态写回旧值、还一直报"连接中"——自愈只成功一轮就再也不触发。
         */
        if (this.calls.get(peerId) !== call) return;
        const ice = pc.iceConnectionState;
        if (ice === "connected" || ice === "completed") {
          let relay = false;
          let packets = 0;
          try {
            const stats = await pc.getStats();
            stats.forEach((report) => {
              if (report.type === "inbound-rtp") {
                const r = report as RTCInboundRtpStreamStats & { kind?: string };
                if ((r.kind ?? "") === "audio") packets += r.packetsReceived ?? 0;
              }
              if (report.type === "candidate-pair") {
                // 见 chosenPair：只认 ICE 最终选中的那条，别把"备用中继对"当在用
                const pair = VoiceMesh.chosenPair(stats);
                if (pair) {
                  const local = stats.get(pair.localCandidateId ?? "") as
                    | { candidateType?: string }
                    | undefined;
                  relay = local?.candidateType === "relay";
                }
              }
            });
          } catch {
            /* noop */
          }
          /*
           * 只有 ICE 通不算通：SDP/候选打通了但一个 RTP 包都没收到的情况真实存在
           * （这周就遇到"界面显示中继、其实没声音"）。以"确实收到音频包"为准。
           *
           * 例外：对方没有麦克风（纯收听者）本来就不发音频，不能因此判失败。
           */
          const peerHasMic = this.members.get(peerId)?.hasMic !== false;
          if (peerHasMic && packets === 0) {
            this.events.mediaState(peerId, "connecting");
            if (mediaProbes < 20) {
              // 每 700ms 再探一次，最多约 14 秒
              mediaProbes += 1;
              this.timers.after(700, () => void classify());
            } else {
              this.scheduleVoiceHeal(peerId, call, VOICE_HEAL_GRACE_MS);
            }
            return;
          }
          mediaProbes = 0;
          const link = relay ? "relay" : "direct";
          const prev = this.roomLinkState.get(peerId);
          if (prev === "failed" && this.roomTelemetry) {
            // 掉线后恢复：计一次重连（网络不稳的信号）
            const sessionIdKey = this.members.get(peerId)?.sessionId ?? "";
            const stat = sessionIdKey ? this.roomTelemetry.members.get(sessionIdKey) : null;
            if (stat) stat.reconnects += 1;
            this.pushRoomEvent("reconnect", `成员链路恢复（曾失败）· ${link}`);
          }
          this.roomLinkState.set(peerId, link);
          this.clearVoiceHeal(peerId);   // 恢复了：清掉自愈状态，允许下次再来
          this.events.mediaState(peerId, relay ? "relay" : "connected");
        } else if (ice === "failed") {
          this.roomLinkState.set(peerId, "failed");
          const name = this.members.get(peerId)?.name ?? "";
          this.pushRoomEvent("error", `与成员「${name || peerId.slice(0, 6)}」的连接失败`);
          this.events.mediaState(peerId, "failed");
          // 彻底失败：立刻进入自愈（重拨一条新连接）
          this.scheduleVoiceHeal(peerId, call, 0);
        } else if (ice === "disconnected" || ice === "checking" || ice === "new") {
          this.events.mediaState(peerId, "connecting");
          /*
           * disconnected 有可能是瞬时抖动（切网、短暂丢包），先给 5 秒宽限；
           * checking/new 属于正常建链过程，不触发自愈。
           */
          if (ice === "disconnected") this.scheduleVoiceHeal(peerId, call, VOICE_HEAL_GRACE_MS);
        }
      };
      pc.addEventListener("iceconnectionstatechange", () => {
        void classify();
      });
      void classify();

      /*
       * 建链看门狗：ICE 卡在 checking 不会有任何事件，光靠 classify 永远等不到。
       * 超时还没连上就主动触发一次自愈（重拨）。
       */
      let healedByTimeout = false;
      this.timers.after(VOICE_CONNECT_TIMEOUT_MS, () => {
        if (this.destroyed || healedByTimeout) return;
        if (this.calls.get(peerId) !== call) return;
        const now = pc.connectionState;
        const iceNow = pc.iceConnectionState;
        const ok =
          now === "connected" ||
          iceNow === "connected" ||
          iceNow === "completed";
        if (ok) return;
        healedByTimeout = true;
        const secs = Math.round(VOICE_CONNECT_TIMEOUT_MS / 1000);
        const name = this.members.get(peerId)?.name ?? peerId.slice(0, 6);
        // 带上 gather 状态，日后从房间遥测能看出是"没收到候选"还是"候选都打不通"
        this.pushRoomEvent(
          "error",
          `语音链路 ${secs} 秒未建立（gather=${pc.iceGatheringState}），重拨 · ${name}`,
        );
        this.scheduleVoiceHeal(peerId, call, 0);
      });
    };
    attach();
  }

  /**
   * 语音腿自愈：断开/失败后重拨一条新的 PeerJS 呼叫。
   * 参数与取舍见文件顶部 VOICE_HEAL_* 常量的注释。
   */
  private scheduleVoiceHeal(peerId: string, call: MediaConnection, delay: number): void {
    let state = this.voiceHeals.get(peerId);
    if (!state) {
      state = { attempts: 0, timer: 0 };
      this.voiceHeals.set(peerId, state);
    }
    if (state.timer) return;
    if (state.attempts >= VOICE_HEAL_MAX) {
      // 次数用尽：明确标成失败，界面才能提示"已断开 + 重新连接"
      if (this.roomLinkState.get(peerId) !== "failed") {
        this.roomLinkState.set(peerId, "failed");
        this.events.mediaState(peerId, "failed");
      }
      return;
    }
    const mine = state;
    mine.timer = this.timers.after(delay, () => {
      mine.timer = 0;
      if (this.destroyed || !this.members.has(peerId)) {
        this.voiceHeals.delete(peerId);
        return;
      }
      // 等这轮的时间里自己好了，就别动
      const link = this.roomLinkState.get(peerId);
      if (link === "direct" || link === "relay") {
        this.voiceHeals.delete(peerId);
        return;
      }
      // 对侧已经重拨并接管：后续交给新连接自己的监听
      if (this.calls.get(peerId) !== call) return;

      /*
       * 首轮礼让：按既有约定（myId 较小的一侧发起呼叫）决定谁先重拨，
       * 另一侧晚 2.5 秒兜底，避免两边同时拨造成信令抖动。
       */
      if (!this.shouldCall(peerId) && mine.attempts === 0) {
        mine.attempts = 1;
        this.scheduleVoiceHeal(peerId, call, VOICE_HEAL_PEER_DELAY_MS);
        return;
      }

      mine.attempts += 1;
      const name = this.members.get(peerId)?.name ?? peerId.slice(0, 6);
      // 先摘映射再关：drop 回调看到"已不是当前连接"就会直接返回，不重复触发自愈
      if (this.calls.get(peerId) === call) this.calls.delete(peerId);
      try {
        call.close();
      } catch {
        /* 已经关掉就算了 */
      }
      // 旧流的播放元素主动收掉，避免 close 迟到时残留在响（或误杀新流）
      this.dropAudio(peerId);
      this.pushRoomEvent("error", `语音链路重拨（第 ${mine.attempts} 次）· ${name}`);
      this.events.mediaState(peerId, "connecting");
      this.callPeer(peerId);
      const fresh = this.calls.get(peerId);
      if (fresh && mine.attempts < VOICE_HEAL_MAX) {
        this.scheduleVoiceHeal(peerId, fresh, VOICE_HEAL_RETRY_MS);
      }
    });
  }

  /** 这条 MediaConnection 是否已经不可用（底层 pc 关闭/失败/长期断开）。 */
  private isCallDead(call: MediaConnection): boolean {
    const pc = (call as { peerConnection?: RTCPeerConnection }).peerConnection;
    if (!pc) return false;   // 还没建好：先当活的，交给常规流程
    const state = pc.connectionState;
    const ice = pc.iceConnectionState;
    /*
     * **不把 disconnected 当死亡**（2026-10-25）。
     *
     * WebRTC 的 `disconnected` 在丢包/短暂网络抖动时非常常见，通常几秒内自己回到
     * connected。原来把它算死，于是：抖一下 → 判死 → 关掉重拨 → 对面也判死重拨 →
     * 双方在"关-拨-关"之间来回，界面永远停在"与 TA 的语音链路连接中…"，
     * 而且是**按对出现**的（只有那条链路质量差的配对会这样，别人一切正常）。
     *
     * 现在只有 closed / failed 才算死；真正失联交给媒体看门狗（ICE 不连通 + 15 秒
     * 没有包）去收尾，那时才重拨。
     */
    return state === "closed" || state === "failed" || ice === "closed" || ice === "failed";
  }

  /** 链路恢复（或成员离开）时清掉自愈状态。 */
  private clearVoiceHeal(peerId: string): void {
    const state = this.voiceHeals.get(peerId);
    if (!state) return;
    // 用登记表取消：直接 window.clearTimeout 会让 Timers 里的 id 永远摘不掉
    if (state.timer) this.timers.cancel(state.timer);
    this.voiceHeals.delete(peerId);
  }

  /**
   * 手动重试（界面上的"重新连接"）：清掉计数后立刻重拨。
   * 自动自愈到顶（VOICE_HEAL_MAX）仍不通时，用户还有这一条路。
   */
  retryVoiceLink(peerId: string): void {
    if (!this.me || peerId === this.myId || !this.members.has(peerId)) return;
    this.clearVoiceHeal(peerId);
    const call = this.calls.get(peerId);
    if (call) {
      if (this.calls.get(peerId) === call) this.calls.delete(peerId);
      try {
        call.close();
      } catch {
        /* noop */
      }
      this.dropAudio(peerId);
    }
    this.events.mediaState(peerId, "connecting");
    this.callPeer(peerId);
    if (this.calls.get(peerId)) this.voiceHeals.set(peerId, { attempts: 1, timer: 0 });
  }

  /**
   * 把这条语音连接上的音频发送端标成"高优先级"（P0-6）。
   *
   * 为什么必须做：观众的语音和画面通常走同一张网卡/同一条上行。画面是
   * "丢几帧无所谓"，语音是"丢一帧就断续"。显式声明优先级后，浏览器的
   * 带宽分配会先保语音；配合画面侧的 `priority:"low"`，两者形成一条完整策略。
   * 个别浏览器不支持该参数时静默忽略（不影响功能）。
   */
  private boostVoicePriority(pc: RTCPeerConnection): void {
    try {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== "audio") continue;
        const params = sender.getParameters() as RTCRtpSendParameters & {
          encodings: (RTCRtpEncodingParameters & { networkPriority?: string })[];
        };
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings = params.encodings.map((encoding) => ({
          ...encoding,
          priority: "high",
          networkPriority: "high",
        }));
        void sender.setParameters(params).catch(() => {
          /* 参数被拒（协商时序/实现不支持）不影响语音本身 */
        });
      }
    } catch {
      /* getSenders/setParameters 不可用时忽略 */
    }
  }

  /**
   * 把原始远端流挂到静音泵元素上（详见 pumpEls 注释）。
   * 同一成员流重建时复用元素、只换 srcObject；play() 失败静默（unlockAudio 会重试）。
   */
  private primePeerAudio(peerId: string, stream: MediaStream): void {
    try {
      let pump = this.pumpEls.get(peerId);
      if (!pump) {
        pump = document.createElement("audio");
        pump.muted = true;
        pump.autoplay = true;
        pump.dataset["pump"] = peerId;
        document.body.appendChild(pump);
        this.pumpEls.set(peerId, pump);
      }
      if (pump.srcObject !== stream) pump.srcObject = stream;
      void pump.play().catch(() => {});
    } catch {
      /* 泵失败不影响主链路（Firefox 等本就不需要泵） */
    }
  }

  /** 拆掉某个成员的泵元素（成员离开时）。 */
  private dropPumpAudio(peerId: string): void {
    const pump = this.pumpEls.get(peerId);
    if (!pump) return;
    this.pumpEls.delete(peerId);
    try {
      pump.pause();
      pump.srcObject = null;
      pump.remove();
    } catch {
      /* noop */
    }
  }

  private playStream(peerId: string, stream: MediaStream): void {
    this.remoteStreams.set(peerId, stream);
    let element = this.audio.get(peerId);
    if (!element) {
      element = document.createElement("audio");
      element.autoplay = true;
      element.dataset["peer"] = peerId;
      document.body.appendChild(element);
      this.audio.set(peerId, element);
      /*
       * 新元素立刻绑定当前选定的扬声器。
       * 这一步以前漏了：元素是在对端流到达时才创建的，
       * 而 applySpeaker 只在"保存设置"时跑一次——那时元素还不存在，
       * 于是选了扬声器也不生效（尤其桌面端接了多个输出设备时）。
       */
      this.bindElementSpeaker(element);
    }
    // 必须在 WebAudio 增益链之前：先把原始流"泵"起来，解码器才会真正出样本
    this.primePeerAudio(peerId, stream);
    this.routePeerAudio(peerId, stream, element);
    void resumeAudio(this.ctx);
    this.monitor(peerId, stream, false);
    /*
     * 自动播放可能被浏览器拦截（没有用户手势时）。
     * 这里**不能静默吞掉**：以前这里只写了句"UI 会提示（见 RoomHint）"，
     * 而那个 RoomHint 根本不存在——被拦截时用户既听不到声音、也看不到任何提示，
     * 表现就是"别人说话我听不见"。现在把失败上报给界面。
     */
    void element.play().catch((error: unknown) => {
      const name = (error as { name?: string } | null)?.name ?? "";
      /*
       * ⚠️ 以前这里**任何** play() 失败都会记成"浏览器拦截了自动播放"，
       * 于是统计里那份"被拦"清单大半是误报（2026-10-26 业主质疑，查证属实）。
       *
       * 真正表示被自动播放策略挡下的只有 NotAllowedError。另外两种常见且无害：
       *   - AbortError：play() 还没完成就换了 srcObject（换流/重连时必然出现），
       *     过一拍再播就行，不该打扰用户；
       *   - NotSupportedError / 其它：当普通错误上报，别再冒充"被拦"。
       */
      if (name === "AbortError") {
        this.timers.after(120, () => {
          if (this.audio.get(peerId) === element) void element.play().catch(() => {});
        });
        return;
      }
      if (name !== "NotAllowedError") {
        this.pushRoomEvent("error", `播放失败（${name || "未知错误"}）`);
        this.events.playbackBlocked(peerId, `${name}: ${String(error)}`);
        return;
      }
      // 确认为自动播放策略拦截：静音播起来 + 等一次手势开声
      this.pushRoomEvent("error", "自动播放被拦下了：点一下窗口即可恢复声音");
      this.events.playbackBlocked(peerId, "NotAllowedError");
      element.muted = true;
      void element.play().catch(() => {});
      onAutoplayBlocked(element);
      void resumeAudio(this.ctx);
    });
  }

  /**
   * 这一路的播放链还会不会出声（元素在、有源、没被暂停）。
   *
   * 只看"元素状态"，不看音频电平——静音期电平本来就接近 0，不能拿它判死活。
   */
  private isPlaying(peerId: string): boolean {
    const element = this.audio.get(peerId);
    if (!element) return false;
    if (!element.srcObject) return false;
    if (element.paused) return false;
    /*
     * 泵也必须还在播：它停了，Chromium 就不拉动解码器，主元素虽然显示
     * "正在播放"，实际吐的是零样本——包在到、元素在播、一点声音都没有。
     */
    const pump = this.pumpEls.get(peerId);
    if (pump && pump.paused) return false;
    if (!this.ctx) return true;
    if (this.peerChains.has(peerId)) return true;
    // 没有增益链时只有一种合法形态：元素直接播原始远端流（建链失败时的兜底）
    return element.srcObject === this.remoteStreams.get(peerId);
  }

  private dropMedia(peerId: string): void {
    const call = this.calls.get(peerId);
    if (call) {
      this.calls.delete(peerId);
      try {
        call.close();
      } catch {
        /* noop */
      }
    }
    this.dropAudio(peerId);
  }

  private dropAudio(peerId: string): void {
    this.flowSamples.delete(peerId);
    this.inboundZeroPolls.delete(peerId);
    this.playbackMisses.delete(peerId);
    this.remoteStreams.delete(peerId);
    /*
     * ⚠️ 必须清 lastMediaAt：它是"这条腿最近一次收到音频"的时间戳。
     * 不清的话，重拨出来的新连接一出生就继承了旧连接的过期时间戳，
     * ensureCalls 会在 3 秒内把它当成"僵死腿"关掉，然后拨一条、再关一条，
     * 无限循环——表现就是"这个人一直连不上，偶尔响一下又断"。
     */
    this.lastMediaAt.delete(peerId);
    const element = this.audio.get(peerId);
    if (element) {
      element.pause();
      element.srcObject = null;
      element.remove();
      // 元素要销毁了：从"等手势开声"名单里摘掉，避免泄漏与误唤醒
      const dying = this.audio.get(peerId);
      if (dying) forgetAutoplayElement(dying);
      this.audio.delete(peerId);
    }
    // 不论元素在不在，增益链都要拆（否则节点一直挂在 AudioContext 上）
    this.teardownPeerAudio(peerId);
    this.dropPumpAudio(peerId);
    const monitor = this.monitors.get(peerId);
    if (monitor) {
      this.monitors.delete(peerId);
      // 必须显式断开：否则旧流的节点会一直挂在 AudioContext 上，
      // 既占内存，也会让已离开的人继续被分析。
      try {
        monitor.source.disconnect();
        monitor.analyser.disconnect();
      } catch {
        /* noop */
      }
      this.speaking.delete(peerId);
    }
  }

  /** 切换扬声器：对每个已在播放的元素重新绑定，失败不再静默。 */
  applySpeaker(settings: VoiceSettings): void {
    this.speakerDeviceId = settings.speakerDeviceId;
    for (const element of this.audio.values()) {
      this.bindElementSpeaker(element);
    }
  }

  /**
   * 把当前选定的扬声器绑到某个远端音频元素上。
   * 失败原因交给界面显示，不静默。
   */
  private bindElementSpeaker(element: HTMLAudioElement): void {
    bindSpeaker(element, this.speakerDeviceId, (message) => {
      this.events.status("connected", message);
    });
  }

  /**
   * 借一次用户手势把音频通道彻底解锁，并重试所有没播起来的远端音频。
   *
   * 浏览器的自动播放策略要求"先有用户手势"。点"创建/加入房间"本身就是手势，
   * 所以在那时创建并 resume AudioContext、并且立刻 resume 每个 audio 元素，
   * 后面远端流到达时就能直接出声，不会因为"手势已经过期"被拦。
   *
   * 返回是否所有元素都恢复播放（供界面判断要不要继续提示）。
   */
  unlockAudio(): boolean {
    const ctx = this.audioContext();
    if (ctx) void resumeAudio(ctx);
    /*
     * 泵元素必须一起重试。Chromium 的远端起播缺陷（见 pumpEls 注释）只有
     * "原始流被某个 media element 拉动"才会解码；泵要是没播起来，主元素
     * 照样能 play()（放的是静音），getStats 也一切正常，就是没声音。
     */
    for (const pump of this.pumpEls.values()) {
      void pump.play().catch(() => undefined);
    }
    for (const element of this.audio.values()) {
      void element.play().catch(() => undefined);
    }
    return !this.hasBlockedAudio();
  }

  /** 当前有没有"没播起来"的远端音频（界面据此显示恢复提示）。 */
  hasBlockedAudio(): boolean {
    for (const pump of this.pumpEls.values()) {
      if (pump.paused) return true;
    }
    for (const element of this.audio.values()) {
      if (element.paused) return true;
    }
    return false;
  }

  private monitor(id: string, stream: MediaStream, local = false): void {
    const existing = this.monitors.get(id);
    if (existing) {
      if (existing.stream === stream) return;
      /*
       * 换了流（自愈重拨、播放链重建）必须换分析器：老的接的是老节点，
       * 拿它算电平，说话高亮和发言时长会一直失真。
       */
      try {
        existing.source.disconnect();
        existing.analyser.disconnect();
      } catch {
        /* noop */
      }
      this.monitors.delete(id);
      this.speaking.delete(id);
    }
    const ctx = this.audioContext();
    if (!ctx) return;
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      this.monitors.set(id, {
        source,
        analyser,
        stream,
        data: new Uint8Array(analyser.frequencyBinCount),
        local,
        detector: new VoiceActivityDetector(),
      });
      this.startSpeakingLoop();
    } catch {
      /* 没有音频轨时 createMediaStreamSource 会抛，忽略即可 */
    }
  }

  /** 把 AudioContext 拉起来；返回是否真的在 running。 */
  private async ensureContextRunning(ctx: AudioContext): Promise<boolean> {
    if (ctx.state === "running") return true;
    try {
      await ctx.resume();
    } catch {
      /* 某些环境需要用户手势，交给下面的复查判定 */
    }
    // resume 会改 state，但 TS 已按前一次判断收窄了类型，这里重新读一次
    return (ctx.state as AudioContextState) === "running";
  }

  /** 上下文被挂起时自动救一次（托盘恢复、切设备后常见）。只注册一次。 */
  private watchContextState(ctx: AudioContext): void {
    if (this.ctxWatched) return;
    this.ctxWatched = true;
    ctx.addEventListener?.("statechange", () => {
      if (this.destroyed || !this.me) return;
      if (ctx.state !== "suspended") return;
      void this.ensureContextRunning(ctx).then((ok) => {
        if (!ok) {
          this.pushRoomEvent("error", "AudioContext 被挂起且恢复失败");
          this.events.micProblem?.("麦克风引擎被系统挂起：点一下窗口恢复，或重新进房");
        }
      });
    });
  }

  private audioContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    this.ctx = Ctor ? new Ctor() : null;
    return this.ctx;
  }

  // ------------------------------------------------------ 发送侧处理链

  /**
   * 构建发送链：麦克风原始流 →（RNNoise 降噪 worklet）→ 增益（音量/增强）
   * → MediaStreamDestination；outgoingStream 即真正发给同伴的流。
   * 降噪 worklet 加载失败时降级为直通，不让进房卡死。
   */
  private async buildOutgoing(settings: VoiceSettings): Promise<void> {
    if (!this.localStream) return;
    const ctx = this.audioContext();
    if (!ctx) return;
    this.teardownOutgoingGraph();

    const source = ctx.createMediaStreamSource(this.localStream);
    const gain = ctx.createGain();
    gain.gain.value = settings.micVolume;
    /*
     * 软限幅（DynamicsCompressor）：麦克风增强拉到 200~300% 时，人声峰值会超过
     * 0dBFS 被硬削——听感就是"声音大了但发闷/破"。这里放一个高比率、快启动的
     * 压限，把峰值兜在 0dB 以内：小音量段落整体抬高，峰值不炸。
     */
    // 个别实现/测试替身可能没有压限器：降级为直连，不让整个发送链建不起来
    const limiter = typeof ctx.createDynamicsCompressor === "function"
      ? ctx.createDynamicsCompressor()
      : null;
    if (limiter) {
      limiter.threshold.value = -3;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
    }
    const dest = ctx.createMediaStreamDestination();
    this.micSourceNode = source;
    this.micGainNode = gain;
    this.micLimiterNode = limiter;
    this.outDestNode = dest;

    if (settings.processing.noiseSuppression) {
      try {
        await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
        const wasmBinary = await loadRnnoise({
          url: rnnoiseWasmUrl,
          simdUrl: rnnoiseSimdWasmUrl,
        });
        const ns = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
        this.nsNode = ns;
        this.nsEnabled = true;
        source.connect(ns);
        ns.connect(gain);
      } catch {
        // worklet/wasm 不可用：降级直通（native NS 已在 openMic 关闭）。
        this.nsEnabled = false;
        source.connect(gain);
      }
    } else {
      this.nsEnabled = false;
      source.connect(gain);
    }
    gain.connect(limiter ?? dest);
    limiter?.connect(dest);
    this.outgoingStream = dest.stream;

    /*
     * AudioContext 默认可能是 suspended（无用户手势、页面在后台、WebView2 从托盘恢复）：
     * 这种情况下 MediaStreamDestination 产出的是**静音流**——别人完全听不见你，
     * 而你这边界面一切正常，是最难自查的一类故障。所以必须显式 resume 并复查。
     */
    this.watchContextState(ctx);
    const running = await this.ensureContextRunning(ctx);
    const track = this.outgoingStream.getAudioTracks()[0];
    if (!running) {
      this.pushRoomEvent("error", "麦克风音频引擎未运行（AudioContext suspended）");
      this.events.micProblem?.("麦克风引擎没启动：请点一下窗口，或在设置里重新选一次麦克风");
    } else if (track?.muted) {
      this.pushRoomEvent("error", "麦克风轨道被系统静音");
      this.events.micProblem?.("系统把麦克风静音了：检查一下 Windows 的麦克风权限/静音开关");
    }
  }

  /**
   * 麦克风音量/增强（0..MIC_VOLUME_MAX），通话中拖动立即生效。
   *
   * ⚠️ 增益与浏览器 AGC（自动增益）打架的坑（2026-10-17 业主找人实测
   * "调到 200% 声音没增强"）：AGC 开着时，浏览器会自动把采集电平压回
   * 目标值——手动增益 ×2，AGC 就把输入增益 ÷2，净效果≈零。
   * 对策：音量 >100% 时自动挂起 AGC，回到 ≤100% 再恢复。
   */
  private agcSuspendedForBoost = false;
  /**
   * 用户在设置里对 AGC 的**意图**（关掉 AGC 就是关掉）。
   *
   * 必须单独记：把麦克风增强从 >100% 拉回 100% 时，原来硬编码恢复
   * `autoGainControl: true`，会把用户明确关掉的 AGC 又打开（音量忽大忽小）。
   */
  private captureAgcWanted = true;

  setMicVolume(value: number): void {
    const gain = this.micGainNode;
    if (!gain || !this.ctx) return;
    const clamped = Math.min(MIC_VOLUME_MAX, Math.max(0, value));
    gain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
    const track = this.localStream?.getAudioTracks()[0];
    const wantBoost = clamped > 1.0;
    if (track && typeof track.applyConstraints === "function" && wantBoost !== this.agcSuspendedForBoost) {
      this.agcSuspendedForBoost = wantBoost;
      void track
        .applyConstraints({
          // 恢复到"用户设置"，而不是硬编码 true
          advanced: [{ autoGainControl: wantBoost ? false : this.captureAgcWanted }],
        })
        .catch(() => {
          /* 个别设备不支持运行时改约束：保持现状，增益仍有部分效果 */
        });
    }
  }

  /**
   * 通话中开关智能降噪：按开关状态重接 source→(ns)→gain。
   * 开启时若 worklet 尚未就绪则现场加载；失败返回 false，由 UI 提示。
   */
  async setNoiseSuppression(on: boolean): Promise<boolean> {
    const ctx = this.ctx;
    const source = this.micSourceNode;
    const gain = this.micGainNode;
    if (!ctx || !source || !gain) return false;
    if (on === this.nsEnabled) return true;

    if (!on) {
      try {
        this.nsNode?.disconnect();
      } catch {
        /* noop */
      }
      source.connect(gain);
      this.nsEnabled = false;
      return true;
    }

    try {
      await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
      const wasmBinary = await loadRnnoise({
        url: rnnoiseWasmUrl,
        simdUrl:rnnoiseSimdWasmUrl,
      });
      const ns = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
      try {
        source.disconnect(gain);
      } catch {
        /* noop */
      }
      this.nsNode?.disconnect();
      this.nsNode = ns;
      source.connect(ns);
      ns.connect(gain);
      this.nsEnabled = true;
      return true;
    } catch {
      return false;
    }
  }

  /** 设置保存时一次性应用：音量 + 降噪开关。 */
  async updateAudioSettings(settings: VoiceSettings): Promise<void> {
    this.setMicVolume(settings.micVolume);
    await this.setNoiseSuppression(settings.processing.noiseSuppression);
    // 采集参数也一并尝试实时应用；失败不阻断（下次进房采集时必然生效）。
    await this.applyCaptureProcessing(settings.processing);
  }

  /**
   * 通话中实时应用回声消除 / 自动增益。
   *
   * 这两个是 track 的采集约束，多数浏览器支持在不重新协商的情况下用
   * applyConstraints 改。但**并非所有设备/浏览器都会真的照做**——所以这里
   * 必须回读 getSettings()：只有回读值与请求一致才算生效，否则如实告诉 UI，
   * 让它继续显示"重进生效"，而不是让用户以为已经改了却没变。
   */
  async applyCaptureProcessing(
    processing: Pick<AudioProcessing, "echoCancellation" | "autoGainControl">,
  ): Promise<{ echoCancellation: boolean; autoGainControl: boolean }> {
    this.captureAgcWanted = processing.autoGainControl;
    /*
     * 增强 >100% 时 AGC 必须保持挂起：否则同一次"保存设置"里
     * setMicVolume 刚挂起、这里又用基础约束把它打开，两者互相抵消——
     * 正是"调到 200% 声音没增强"的回归路径（设置页保存时最常踩）。
     */
    const agc = this.agcSuspendedForBoost ? false : processing.autoGainControl;
    const tracks = this.localStream?.getAudioTracks() ?? [];
    for (const track of tracks) {
      try {
        await track.applyConstraints({
          echoCancellation: processing.echoCancellation,
          autoGainControl: agc,
        });
      } catch {
        /* 不支持就保持原样，下面回读会体现出来 */
      }
    }
    return this.readCaptureProcessing();
  }

  /**
   * 只回读当前麦克风轨道上真实生效的采集参数（不做任何修改）。
   * 用于界面判断该显示"已生效"还是"重进生效"。
   */
  readCaptureProcessing(): { echoCancellation: boolean; autoGainControl: boolean } {
    const result = { echoCancellation: false, autoGainControl: false };
    const tracks = this.localStream?.getAudioTracks() ?? [];
    if (tracks.length === 0) return result;
    for (const track of tracks) {
      try {
        const settings = track.getSettings();
        if (settings.echoCancellation === true) result.echoCancellation = true;
        if (settings.autoGainControl === true) result.autoGainControl = true;
      } catch {
        /* 读不到就当未生效 */
      }
    }
    return result;
  }

  /** 只拆处理链节点，保留原始麦克风流（供重建/销毁复用）。 */
  private teardownOutgoingGraph(): void {
    for (const node of [this.nsNode, this.micSourceNode, this.micGainNode, this.micLimiterNode, this.outDestNode]) {
      try {
        node?.disconnect();
      } catch {
        /* noop */
      }
    }
    this.nsNode = null;
    this.micSourceNode = null;
    this.micGainNode = null;
    this.micLimiterNode = null;
    this.outDestNode = null;
    this.outgoingStream = null;
    this.nsEnabled = false;
  }

  // -------------------------------------------------- 成员收听音量/静音

  /** 从设置恢复每个成员的本地音量与静音。 */
  private loadPeerAudioSettings(settings: VoiceSettings): void {
    /*
     * 顺手记住扬声器设备。
     * 必须在**创建 audio 元素之前**就存下来：applySpeaker() 只能作用于**已存在**的元素，
     * 而元素是对端流到达时才创建的。原来只在"保存设置"时调 applySpeaker，
     * 于是先设好扬声器、再有人进房的话，新元素永远不会被绑到所选设备（设置等于不生效）。
     */
    this.speakerDeviceId = settings.speakerDeviceId;
    this.peerVolumes.clear();
    this.peerMuted.clear();
    for (const [id, value] of Object.entries(settings.peerVolumes)) {
      if (typeof value === "number" && value >= 0 && value <= PEER_VOLUME_MAX) this.peerVolumes.set(id, value);
    }
    for (const [id, value] of Object.entries(settings.peerMuted)) {
      if (value === true) this.peerMuted.add(id);
    }
  }

  private applyPeerAudio(peerId: string): void {
    const element = this.audio.get(peerId);
    if (!element) return;
    const chain = this.peerChains.get(peerId);
    const volume =
      (this.peerMuted.has(peerId) ? 0 : this.peerVolumes.get(peerId) ?? 1) * this.duckFactor;
    if (chain && this.ctx) {
      // 增益走 GainNode（可 >1），元素音量固定 1，避免两处相乘
      chain.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02);
      element.volume = 1;
    } else {
      // 没有 AudioContext（极少数降级路径）：退回元素音量，但必须夹到 0~1，
      // 否则赋 >1 会被浏览器拒绝、整个音量设置静默失效。
      element.volume = Math.min(1, Math.max(0, volume));
    }
    // 闭听优先级最高（独立于本地音量设置，恢复时不受影响）。
    element.muted = this.deafened;
  }

  /**
   * 临时压低全部成员的播放音量（1 = 恢复）。
   * 只影响本地收听，不改成员各自的音量设置，也不影响发送。
   */
  setRoomDuck(factor: number): void {
    this.duckFactor = Math.min(1, Math.max(0, factor));
    for (const peerId of this.audio.keys()) this.applyPeerAudio(peerId);
  }

  /** 把某个成员的音频接进"增益 + 软限幅"链，元素播放链的输出。 */
  private routePeerAudio(peerId: string, stream: MediaStream, element: HTMLAudioElement): void {
    const ctx = this.audioContext();
    if (!ctx) {
      element.srcObject = stream;
      this.applyPeerAudio(peerId);
      return;
    }
    this.teardownPeerAudio(peerId);
    try {
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      const limiter =
        typeof ctx.createDynamicsCompressor === "function" ? ctx.createDynamicsCompressor() : null;
      // 软限幅参数：只在高增益（>100%）时兜住峰值，正常音量几乎不介入
      if (limiter) {
        limiter.threshold.value = -3;
        limiter.knee.value = 6;
        limiter.ratio.value = 12;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.25;
      }
      const dest = ctx.createMediaStreamDestination();
      source.connect(gain);
      gain.connect(limiter ?? dest);
      limiter?.connect(dest);
      this.peerChains.set(peerId, { source, gain, limiter, dest });
      element.srcObject = dest.stream;
    } catch {
      // 建链失败（罕见）：退回元素音量直放
      element.srcObject = stream;
    }
    this.applyPeerAudio(peerId);
  }

  /** 拆掉某个成员的增益链（成员离开 / 流重建时）。 */
  private teardownPeerAudio(peerId: string): void {
    const chain = this.peerChains.get(peerId);
    if (!chain) return;
    this.peerChains.delete(peerId);
    try {
      chain.source.disconnect();
      chain.gain.disconnect();
      chain.limiter?.disconnect();
      chain.dest.disconnect();
    } catch {
      /* 已断开 */
    }
  }

  /**
   * 闭听 / 取消闭听。
   * 闭听会自动闭麦并把所有人的声音静音（不改动各自音量记录）；
   * 取消闭听恢复收听，但不会自动帮用户开麦（与 Discord 行为一致）。
   */
  setDeaf(on: boolean): void {
    if (this.deafened === on) return;
    this.deafened = on;
    if (this.me) {
      this.me.deafened = on;
      if (on) {
        // 闭听同时闭麦；setMuted 会把 (muted:true, deafened:true) 同步给房主 / 全员。
        this.setMuted(true);
      } else {
        // 取消闭听只恢复收听、不自动开麦，需单独把 deafened=false 同步出去。
        this.emitMembers();
        if (this.hosting) {
          this.broadcastHost({ t: "roster", members: this.roster() });
        } else if (this.hostConn) {
          this.send(this.hostConn, { t: "muted", muted: this.me.muted, deafened: false });
        }
      }
    }
    for (const id of this.audio.keys()) this.applyPeerAudio(id);
  }

  /** 调某个成员的本地收听音量（0..2，>1 为增强）。 */
  setPeerVolume(peerId: string, volume: number): void {
    this.peerVolumes.set(peerId, Math.min(PEER_VOLUME_MAX, Math.max(0, volume)));
    if (volume > 0) this.peerMuted.delete(peerId);
    this.applyPeerAudio(peerId);
  }

  /** 对某个成员本地静音/取消（只影响自己听不听得到）。 */
  togglePeerMuted(peerId: string): boolean {
    if (this.peerMuted.has(peerId)) {
      this.peerMuted.delete(peerId);
      /*
       * 取消静音时如果他的音量正好是 0（被拖到最左），增益仍然是 0：
       * 按钮变回"未静音"却还是没声音，用户只会反复点。这里补回 1。
       */
      if ((this.peerVolumes.get(peerId) ?? 1) <= 0) this.peerVolumes.set(peerId, 1);
    } else this.peerMuted.add(peerId);
    this.applyPeerAudio(peerId);
    return this.peerMuted.has(peerId);
  }

  getPeerAudio(peerId: string): { volume: number; muted: boolean } {
    return {
      volume: this.peerVolumes.get(peerId) ?? 1,
      muted: this.peerMuted.has(peerId),
    };
  }

  /**
   * 供持久化使用：当前所有成员的本地音量/静音。
   * 直接读引擎自己的表，而不是遍历 UI 成员列表——否则不在名单里的历史记录
   * 会在保存时被丢掉。
   */
  snapshotPeerAudio(): {
    peerVolumes: Record<string, number>;
    peerMuted: Record<string, boolean>;
  } {
    const peerVolumes: Record<string, number> = {};
    for (const [id, value] of this.peerVolumes) peerVolumes[id] = value;
    const peerMuted: Record<string, boolean> = {};
    for (const id of this.peerMuted) peerMuted[id] = true;
    return { peerVolumes, peerMuted };
  }

  // -------------------------------------------------------------------- 采集

  private async acquireMic(settings: VoiceSettings, muted: boolean): Promise<void> {
    try {
      this.localStream = await openMic(settings, (message) => {
        this.events.status(this.hosting ? "preparing" : "preparing", message);
      });
      for (const track of this.localStream.getAudioTracks()) track.enabled = !muted;
      void resumeAudio(this.audioContext());
      for (const track of this.localStream.getAudioTracks()) {
        track.addEventListener("ended", () => {
          // 设备被拔掉：明确告知，而不是让用户对着一个死麦讲话。
          this.events.status("connected", "麦克风已断开，可在设置中重新选择设备");
        });
      }
    } catch {
      this.localStream = null;
    }
  }

  // -------------------------------------------------------------------- 工具

  private send(conn: DataConnection | null, message: unknown): void {
    if (!conn) return;
    // 只有 open 的连接能发；否则 PeerJS 会抛，且消息必然丢失。
    if (!conn.open) return;
    try {
      conn.send(message);
    } catch {
      /* noop */
    }
  }

  private emitMembers(): void {
    if (this.memberEmitQueued) return;
    this.memberEmitQueued = true;
    queueMicrotask(() => {
      this.memberEmitQueued = false;
      if (this.destroyed) return;
      const list = Array.from(this.members.values()).sort((a, b) => {
        if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
        if (a.local !== b.local) return a.local ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-Hans-CN");
      });
      this.events.members(list.map((member) => ({ ...member })));
    });
  }

  get memberCount(): number {
    return this.members.size;
  }

  get maxMembers(): number {
    return MAX_MEMBERS;
  }
}

interface Monitor {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  stream: MediaStream;
  data: Uint8Array<ArrayBuffer>;
  local: boolean;
  /** 语音活动判定器（纯逻辑，见 voice-activity.ts）。 */
  detector: VoiceActivityDetector;
}

export { buildInviteUrl, isRoomCode, normalizeCode, hostPeerId, rejectText };
