import { Peer } from "peerjs";
import type { DataConnection, MediaConnection } from "peerjs";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
// RNNoise 的 worklet 脚本与 wasm（Vite 以 ?url 产出带哈希的静态资源）。
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

import {
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
  type WireMember,
} from "./protocol";
import { sessionScopedId, type Identity } from "./identity";
import {
  PenDirector,
  VEGETABLE_KINDS,
  isPenFast,
  nearestActor,
  type PenEvent,
} from "./pen";
import {
  SOUND_NOTES,
  shouldPlaySound,
  type SoundEvent,
  type SoundKind,
} from "./sounds";
import { Timers } from "./timers";
import { VoiceActivityDetector } from "./voice-activity";
import type { AudioProcessing, VoiceSettings } from "./settings";
import { bindSpeaker, openMic, resumeAudio } from "./devices";

/**
 * ICE 服务器：多个公共 STUN（含国内可达）+ 免费公共 TURN 中继兜底。
 *
 * 为什么这样配（对应"跨网无声、同设备有声"）：
 * - 同一台设备两端走 host candidate（本机 / 局域网地址），不需要 STUN，所以能听到；
 * - 跨网络必须靠 STUN 拿到公网映射地址（srflx）才能打洞。Google STUN 在
 *   大陆基本不可用，因此补充国内可达的 STUN；
 * - 对称 NAT / 公司网 / 校园网靠 STUN 打不通，必须有 TURN 中继兜底。
 *
 * 注意：免费公共 TURN（Open Relay）可能限流、在大陆未必能连上。
 * 若要彻底保证任何网络都能打通，建议自建 coturn（一台最便宜的 VPS），
 * 把下面的 TURN 段换成自己的地址与凭据即可。
 */
function iceServers(): RTCIceServer[] {
  return [
    {
      urls: [
        "stun:stun.cloudflare.com:3478",
        "stun:stun.l.google.com:19302",
        "stun:stun.miwifi.com:3478",
        "stun:stun.chat.bilibili.com:3478",
      ],
    },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ];
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
  private audio = new Map<string, HTMLAudioElement>();
  private monitors = new Map<string, Monitor>();
  private speaking = new Set<string>();

  private ctx: AudioContext | null = null;
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

  /** 房主建房。房间码冲突时自动换码重试。 */
  async host(identity: Identity, settings: VoiceSettings, muted: boolean): Promise<void> {
    if (this.destroyed) return;
    this.hosting = true;
    // 这里仍在用户点击的手势里，趁机解锁音频（否则远端流到达时会被自动播放策略拦下）
    this.unlockAudio();
    this.events.status("preparing");
    await this.acquireMic(settings, muted);
    await this.buildOutgoing(settings);
    this.loadPeerAudioSettings(settings);

    let attempt = 0;
    while (!this.destroyed && attempt < 3) {
      attempt += 1;
      const code = makeRoomCode(randomIndex);
      // 房主注册在由房间码推导的固定 ID 上：访客只输房间码也能定位到房主，
      // 不需要任何注册后端。ID 被占用（撞码/有人蹲守）时 openPeer 返回
      // "retry"，下面的循环换新码重来。
      const id = hostPeerIdForCode(code);
      const outcome = await this.openPeer(id);

      if (this.destroyed) return;
      if (outcome === "open") {
        this.code = code;
        this.hostId = id;
        this.roomKey = randomToken(24);
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
        };
        this.members.set(id, this.me);
        const monitorStream = this.outgoingStream ?? this.localStream;
        if (monitorStream) {
          this.monitor(id, monitorStream, true);
          this.startSpeakingLoop();
        }
        this.startHeartbeat();
        this.startPenDirector();
        this.joined = true;

        this.emitMembers();
        this.events.status("connected");
        this.events.ready({ code, hostId: id, roomKey: this.roomKey });
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

    const outcome = await this.openPeer(guestPeerId(randomToken(12)));
    if (this.destroyed) return;
    if (outcome !== "open") {
      this.events.status("error", outcome);
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

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

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

    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  // ------------------------------------------------------------ peer 生命周期

  /** 建立 peer 并等 open。返回值是 "open"、可重试标记或给用户看的错误文案。 */
  private openPeer(id: string): Promise<string> {
    return new Promise<string>((resolve) => {
      if (this.destroyed) {
        resolve("已离开房间");
        return;
      }
      const peer = new Peer(id, {
        host: "0.peerjs.com",
        port: 443,
        secure: true,
        key: "peerjs",
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

      peer.on("error", (error: { type?: string }) => {
        const type = error?.type ?? "unknown";
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
        if (type === "network" || type === "socket-error" || type === "socket-closed") {
          finish("网络不稳定，与信令服务器的连接中断");
          return;
        }
        if (type === "browser-incompatible") {
          finish("当前浏览器不支持所需的 WebRTC 能力");
          return;
        }
        finish(`连接异常：${type}`);
      });
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
      memberCount: this.guests.size,
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
        previous.conn.close();
      } catch {
        /* noop */
      }
    }

    const member: Member = {
      id: peerId,
      personId: message.personId,
      sessionId: message.sessionId,
      name: message.name,
      avatar: message.avatar,
      color: message.color,
      muted: true,
      hasMic: message.hasMic,
      isHost: false,
      local: false,
      // 同 ID 断线重连要保留此前的禁言状态。
      serverMuted: previous?.member.serverMuted ?? false,
      deafened: previous?.member.deafened ?? false,
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
  }

  private evictGuest(peerId: string, _reason: string): void {
    const guest = this.guests.get(peerId);
    if (!guest) return;
    const wasJoined = guest.joined;
    this.guests.delete(peerId);
    this.members.delete(peerId);
    this.dropMedia(peerId);

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

  /** 对某位成员发起小猪互动（戳一戳 / 打招呼 / 投喂）。 */
  interactWith(to: string, kind: InteractKind): void {
    if (!this.me || to === this.myId || !this.members.has(to)) return;
    if (this.hosting) {
      this.handleInteract(this.myId, to, kind);
      return;
    }
    this.send(this.hostConn, { t: "interact", to, kind });
  }

  /** 房主统一处理互动：校验、广播，投喂时还在目标猪面前投一颗菜。 */
  private handleInteract(from: string, to: string, kind: InteractKind): void {
    if (!this.hosting) return;
    if (!this.members.has(to) || !this.members.has(from)) return;
    const event: InteractEvent = { from, to, kind, ts: Date.now() };
    this.events.interact(event);
    this.broadcastHost({ t: "interact", event });
    if (kind === "feed") this.feedPig(to);
  }

  /** 投喂：在目标猪面前投一颗菜，并安排它走过去吃掉。 */
  private feedPig(to: string): void {
    const now = Date.now();
    const baseX = this.penActorX.get(to) ?? 0.5;
    const x = Math.min(0.94, Math.max(0.06, baseX + (Math.random() < 0.5 ? -0.06 : 0.06)));
    const kind = VEGETABLE_KINDS[Math.floor(Math.random() * VEGETABLE_KINDS.length)]!;
    const toss: Extract<PenEvent, { kind: "toss" }> = {
      kind: "toss",
      id: `feed-${now}-${Math.floor(Math.random() * 1e6)}`,
      ts: now,
      // 成员投喂不是 DDY 丢的，npc 留空（界面据此不放出 DDY）。
      npc: "",
      veg: { kind, x: Number(x.toFixed(3)), lane: 0.5 },
    };
    this.emitPen(toss);
    this.timers.after(3000, () => {
      if (this.destroyed || !this.hosting || !this.members.has(to)) return;
      this.emitPen(this.pen.produceEat(Date.now(), to, kind));
    });
  }

  // ------------------------------------------------------------------ 猪圈导演

  /** 更新某头猪的横向位置（0~1），供"挑最近的猪去吃菜"使用。 */
  reportPenActor(id: string, x: number): void {
    if (!Number.isFinite(x)) return;
    this.penActorX.set(id, Math.min(1, Math.max(0, x)));
  }

  /** 开始让 DDY 偶尔丢蔬菜。 */
  private startPenDirector(): void {
    if (!this.hosting) return;
    this.scheduleToss();
  }

  /**
   * 排下一次丢蔬菜。
   * 刻意在"有客人/没客人"上不做区分：自己一个人在圈里也会偶尔有菜丢进来。
   */
  private scheduleToss(): void {
    // 调试用（?pen=fast，且已开启调试）把间隔压到几秒，方便人工确认动画
    const fast = typeof location !== "undefined" ? isPenFast(location.search) : false;
    const delay = fast ? 4000 : this.pen.nextTossDelay();
    this.timers.after(delay, () => {
      if (this.destroyed || !this.hosting) return;

      const now = Date.now();
      const toss = this.pen.produceToss(now, Math.max(1, this.penActorX.size || this.members.size));
      this.emitPen(toss);

      // 挑最近的猪来吃
      const actors = Array.from(this.penActorX, ([id, x]) => ({ id, x }));
      const actor = nearestActor(toss.veg.x, actors);
      if (actor) {
        const eatDelay = fast ? 2000 : this.pen.nextEatDelay();
        this.timers.after(eatDelay, () => {
          if (this.destroyed || !this.hosting) return;

          const eatNow = Date.now();
          this.emitPen(this.pen.produceEat(eatNow, actor, toss.veg.kind));

          // 吃完过一会儿拉一泡
          const poopDelay = fast ? 2500 : this.pen.nextPoopDelay();
          this.timers.after(poopDelay, () => {
            if (this.destroyed || !this.hosting) return;
            this.emitPen(this.pen.producePoop(Date.now(), actor));
          });
        });
      }

      this.scheduleToss();
    });
  }

  /** 广播一个猪圈事件；房主自己也当场播动画。 */
  private emitPen(event: PenEvent): void {
    this.broadcastHost({ t: "pen", event });
    this.events.pen(event);
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
    const outcome = await this.openPeer(guestPeerId(randomToken(12)));
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
    const proof = this.roomKey
      ? await signGuestProof(this.roomKey, nonce, this.myId, this.code)
      : "";
    if (this.destroyed || this.hostConn !== conn) return;
    this.send(conn, {
      t: "hello",
      personId: this.me.personId,
      sessionId: this.me.sessionId,
      name: this.me.name,
      avatar: this.me.avatar,
      color: this.me.color,
      hasMic: this.me.hasMic,
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
            this.me.muted = member.muted;
            if (this.localStream) {
              for (const track of this.localStream.getAudioTracks()) {
                track.enabled = !member.muted;
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
          local: false,
        });
      }
      this.emitMembers();
      this.clearWelcomeDeadline();
      this.events.roomFlags({ locked: message.locked ?? false });
      this.events.status("connected");
      this.send(conn, { t: "joined" });
      this.joined = true;
      this.callPeers();
      this.startHeartbeat();
      return;
    }

    this.hostLastSeen = Date.now();

    switch (message.t) {
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
            local: false,
          });
        }
        for (const id of Array.from(this.members.keys())) {
          if (id === this.myId || seen.has(id)) continue;
          this.members.delete(id);
          this.dropMedia(id);
        }
        this.emitMembers();
        this.callPeers();
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
      case "sound": {
        this.events.sound(message.event);
        break;
      }
      case "kick": {
        // 房主只会把 kick 发给被踢者本人。
        if (message.id === this.myId) {
          this.events.ended("rejected", "你已被房主移出房间");
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

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = this.timers.every(HEARTBEAT_MS, () => this.tickLiveness());
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
    this.speakingTimer = this.timers.every(SPEAKING_POLL_MS, () => this.pollSpeaking());
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

  private callPeers(): void {
    // 与房主的媒体立即建立；访客间逐个错峰，避免信令风暴把公共云队列打爆
    // （人越多越明显：这正是"前两个人能进、后面的人卡在加入"的诱因之一）。
    let delay = 0;
    for (const member of this.members.values()) {
      if (member.local || !this.shouldCall(member.id)) continue;
      if (member.id === this.hostId) {
        this.callPeer(member.id);
      } else {
        delay += MEDIA_STAGGER_MS;
        this.timers.after(delay, () => this.callPeer(member.id));
      }
    }
  }

  private callPeer(peerId: string): void {
    // 没有麦克风就不发起：对方仍然会 call 我（纯收听者因此能听到所有人）。
    const stream = this.outgoingStream ?? this.localStream;
    if (!this.peer || !stream || this.calls.has(peerId)) return;
    const call = this.peer.call(peerId, stream);
    if (!call) return;
    this.track(call, peerId);
  }

  private onIncomingCall(call: MediaConnection): void {
    // 已有连接时不重复应答（重复 answer 会被 PeerJS 警告并丢弃）。
    if (this.calls.has(call.peer)) {
      const existing = this.calls.get(call.peer);
      if (existing && existing !== call) {
        try {
          call.close();
        } catch {
          /* noop */
        }
        return;
      }
    }
    // 应答必须用处理后的发送流（降噪 + 音量增益），否则房主/被呼方发出的
    // 声音绕过整条发送链，降噪和麦克风增强对这一路完全不生效。
    const outgoing = this.outgoingStream ?? this.localStream;
    if (outgoing) call.answer(outgoing);
    else call.answer();
    this.track(call, call.peer);
  }

  private track(call: MediaConnection, peerId: string): void {
    this.calls.set(peerId, call);
    call.on("stream", (stream) => this.playStream(peerId, stream));
    const drop = () => {
      if (this.calls.get(peerId) === call) this.calls.delete(peerId);
      this.dropAudio(peerId);
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
      const classify = async () => {
        const ice = pc.iceConnectionState;
        if (ice === "connected" || ice === "completed") {
          let relay = false;
          try {
            const stats = await pc.getStats();
            stats.forEach((report) => {
              if (report.type === "candidate-pair") {
                const pair = report as RTCIceCandidatePairStats;
                if (pair.state === "succeeded" || pair.nominated) {
                  const local = stats.get(pair.localCandidateId ?? "") as
                    | { candidateType?: string }
                    | undefined;
                  if (local?.candidateType === "relay") relay = true;
                }
              }
            });
          } catch {
            /* noop */
          }
          this.events.mediaState(peerId, relay ? "relay" : "connected");
        } else if (ice === "failed") {
          this.events.mediaState(peerId, "failed");
        } else if (ice === "disconnected" || ice === "checking" || ice === "new") {
          this.events.mediaState(peerId, "connecting");
        }
      };
      pc.addEventListener("iceconnectionstatechange", () => {
        void classify();
      });
      void classify();
    };
    attach();
  }

  private playStream(peerId: string, stream: MediaStream): void {
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
    element.srcObject = stream;
    this.applyPeerAudio(peerId);
    void resumeAudio(this.ctx);
    this.monitor(peerId, stream, false);
    /*
     * 自动播放可能被浏览器拦截（没有用户手势时）。
     * 这里**不能静默吞掉**：以前这里只写了句"UI 会提示（见 RoomHint）"，
     * 而那个 RoomHint 根本不存在——被拦截时用户既听不到声音、也看不到任何提示，
     * 表现就是"别人说话我听不见"。现在把失败上报给界面。
     */
    void element.play().catch((error) => {
      this.events.playbackBlocked(peerId, String(error?.message ?? error));
      void resumeAudio(this.ctx).then(() => element.play().catch(() => {}));
    });
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
    const element = this.audio.get(peerId);
    if (element) {
      element.pause();
      element.srcObject = null;
      element.remove();
      this.audio.delete(peerId);
    }
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
    let allPlaying = true;
    for (const element of this.audio.values()) {
      void element.play().catch(() => {
        allPlaying = false;
      });
    }
    return allPlaying;
  }

  /** 当前有没有"没播起来"的远端音频（界面据此显示恢复提示）。 */
  hasBlockedAudio(): boolean {
    for (const element of this.audio.values()) {
      if (element.paused) return true;
    }
    return false;
  }

  private monitor(id: string, stream: MediaStream, local = false): void {
    if (this.monitors.has(id)) return;
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
    const dest = ctx.createMediaStreamDestination();
    this.micSourceNode = source;
    this.micGainNode = gain;
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
    gain.connect(dest);
    this.outgoingStream = dest.stream;
  }

  /** 麦克风音量/增强（0..2），通话中拖动立即生效。 */
  setMicVolume(value: number): void {
    const gain = this.micGainNode;
    if (!gain || !this.ctx) return;
    gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
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
    const tracks = this.localStream?.getAudioTracks() ?? [];
    for (const track of tracks) {
      try {
        await track.applyConstraints({
          echoCancellation: processing.echoCancellation,
          autoGainControl: processing.autoGainControl,
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
    for (const node of [this.nsNode, this.micSourceNode, this.micGainNode, this.outDestNode]) {
      try {
        node?.disconnect();
      } catch {
        /* noop */
      }
    }
    this.nsNode = null;
    this.micSourceNode = null;
    this.micGainNode = null;
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
      if (typeof value === "number" && value >= 0 && value <= 1) this.peerVolumes.set(id, value);
    }
    for (const [id, value] of Object.entries(settings.peerMuted)) {
      if (value === true) this.peerMuted.add(id);
    }
  }

  private applyPeerAudio(peerId: string): void {
    const element = this.audio.get(peerId);
    if (!element) return;
    const volume = this.peerVolumes.get(peerId) ?? 1;
    element.volume = this.peerMuted.has(peerId) ? 0 : volume;
    // 闭听优先级最高（独立于本地音量设置，恢复时不受影响）。
    element.muted = this.deafened;
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

  /** 调某个成员的本地收听音量（0..1）。 */
  setPeerVolume(peerId: string, volume: number): void {
    this.peerVolumes.set(peerId, volume);
    if (volume > 0) this.peerMuted.delete(peerId);
    this.applyPeerAudio(peerId);
  }

  /** 对某个成员本地静音/取消（只影响自己听不听得到）。 */
  togglePeerMuted(peerId: string): boolean {
    if (this.peerMuted.has(peerId)) this.peerMuted.delete(peerId);
    else this.peerMuted.add(peerId);
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
