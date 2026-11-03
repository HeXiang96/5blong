/**
 * 自建媒体协商（MediaLink）—— SDP / ICE 走**两人之间已有的可靠数据通道**，
 * 不再依赖信令 WebSocket 的单次投递。
 *
 * 为什么需要它（2026-11-03 实测）：
 *   PeerJS 的 call/answer 把 SDP 交给信令服务器转发一次，丢了就没了：
 *   发起方的 `iceConnectionState` 会永远停在 `new`（本地描述已设、远端描述从未生效），
 *   而我们这边看到的现象正是这个——两边 PC 都在跑 ICE（中继上有双向权限），
 *   但 answer 没回到发起方，于是永远连不上，只能退出重进（换一条新信令回路）才恢复。
 *
 * 本模块把协商改走 DataConnection：
 *   - 数据通道是有序、有重传、断线可续的（人在房里就说明它在工作）；
 *   - answer 超时会重发 offer（最多 maxRetries 次），而不是干等；
 *   - 迟到/重复的候选、过期 offer 一律容忍，不抛错、不断链。
 *
 * 刻意不做的事：不做 glare（双向同时发起）。发起方由 `myId < peerId` 单边决定，
 * 和引擎现有约定一致，两边不会同时开火。
 */

export type DcLinkState = "connecting" | "connected" | "failed" | "closed";

export type RtcSignal =
  | { t: "rtc-offer"; sdp: string }
  | { t: "rtc-answer"; sdp: string }
  | { t: "rtc-ice"; cand: RTCIceCandidateInit | null }
  | { t: "rtc-bye" };

/** 数据通道的最小抽象：只要求"能发"，收由引擎分发进来（见 handle）。 */
export interface SignalPipe {
  send: (msg: RtcSignal) => void;
}

export interface MediaLinkOptions {
  /** offer = 发起方；answer = 应答方。由 `myId < peerId` 决定，双方一致。 */
  role: "offer" | "answer";
  pipe: SignalPipe;
  /** 本端要发送的音频流；没有麦克风时传 null（协商成 recvonly）。 */
  stream: MediaStream | null;
  /** 每次都重新取：中继凭据可能在会话中途才到位。 */
  iceServers: () => RTCIceServer[];
  /** 测试注入点；生产用默认的 RTCPeerConnection。 */
  createPc?: (config: RTCConfiguration) => RTCPeerConnection;
  /** SDP 整形（降噪/码率那套），默认不动。 */
  sdpTransform?: (sdp: string) => string;
  onState?: (state: DcLinkState) => void;
  /** 协商过程的每一步/失败原因（引擎写进诊断 events，2026-11-03 起失败不再无声）。 */
  onEvent?: (kind: "info" | "error", detail: string) => void;
  onStream?: (stream: MediaStream) => void;
  /** 等 answer 的时长，超时重发 offer。 */
  answerTimeoutMs?: number;
  /** 最多重发几次（不含首发）。 */
  maxRetries?: number;
}

const DEFAULT_ANSWER_TIMEOUT_MS = 6000;
const DEFAULT_MAX_RETRIES = 2;

export class MediaLink {
  private readonly role: "offer" | "answer";
  private readonly pipe: SignalPipe;
  private readonly opts: MediaLinkOptions;
  private pc: RTCPeerConnection | null = null;
  private state: DcLinkState = "connecting";
  private retries = 0;
  /** node 单测里没有 window，统一用全局计时器（浏览器/Node 都可用）。 */
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private closed = false;

  constructor(options: MediaLinkOptions) {
    this.opts = options;
    this.role = options.role;
    this.pipe = options.pipe;
  }

  get peerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  get currentState(): DcLinkState {
    return this.state;
  }

  /** 发起方开始协商；应答方什么都不用做，等 offer。 */
  async start(): Promise<void> {
    if (this.closed || this.role !== "offer") return;
    await this.negotiate();
  }

  /** 引擎把数据通道里收到的 rtc-* 消息交给它。异常不再无声（见 catch）。 */
  async handle(msg: RtcSignal): Promise<void> {
    if (this.closed) {
      this.opts.onEvent?.("warn" as "info", `收到 ${msg.t} 但本链路已关闭（消息被忽略）`);
      return;
    }
    try {
      if (msg.t === "rtc-offer" && this.role === "answer") await this.answerTo(msg.sdp);
      else if (msg.t === "rtc-answer" && this.role === "offer") await this.applyAnswer(msg.sdp);
      else if (msg.t === "rtc-ice") await this.addRemoteCandidate(msg.cand);
      else if (msg.t === "rtc-bye") this.close(false);
    } catch (error) {
      /*
       * 2026-11-03 前这里静默吞掉一切——answer 生成失败连痕迹都没有，
       * 排障只能靠推理。现在把失败原因上报（引擎写进诊断 events），
       * 协商类消息失败如实转 failed（引擎会回落 PeerJS）。
       */
      this.opts.onEvent?.(
        "error",
        `${this.role} 端处理 ${msg.t} 失败：${String((error as Error)?.message ?? error).slice(0, 160)}`,
      );
      if (msg.t === "rtc-offer" || msg.t === "rtc-answer") this.setState("failed");
    }
  }

  close(notifyPeer = true): void {
    if (this.closed) return;
    this.closed = true;
    this.clearAnswerTimer();
    if (notifyPeer) {
      try {
        this.pipe.send({ t: "rtc-bye" });
      } catch {
        /* 通道已经断了也无所谓 */
      }
    }
    this.teardownPc();
    this.setState("closed");
  }

  // ------------------------------------------------------------------ 内部

  private async negotiate(): Promise<void> {
    const pc = this.buildPc();
    await pc.setLocalDescription(await pc.createOffer());
    const sdp = this.transform(pc.localDescription?.sdp ?? "");
    // 本地描述用整形后的 SDP 再设一次：createOffer 的原始串不带我们的 opus 参数
    if (sdp) await pc.setLocalDescription({ type: "offer", sdp });
    this.pipe.send({ t: "rtc-offer", sdp });
    this.armAnswerTimer();
  }

  private async answerTo(offerSdp: string): Promise<void> {
    /*
     * 收到 offer 就重建 PC：发起方重发（上一轮 answer 丢了）时，
     * 旧 PC 上直接 setRemoteDescription 会进入 renegotiation，状态更难预测。
     * 重建是幂等的、代价只有一次候选收集。
     */
    this.teardownPc();
    const pc = this.buildPc();
    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    await this.flushPendingCandidates();
    await pc.setLocalDescription(await pc.createAnswer());
    const sdp = this.transform(pc.localDescription?.sdp ?? "");
    if (sdp) await pc.setLocalDescription({ type: "answer", sdp });
    this.pipe.send({ t: "rtc-answer", sdp });
  }

  private async applyAnswer(answerSdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    // 迟到/重复的 answer：已经设过远端描述就忽略，避免 InvalidStateError
    if (pc.remoteDescription) return;
    this.clearAnswerTimer();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    await this.flushPendingCandidates();
  }

  private async addRemoteCandidate(cand: RTCIceCandidateInit | null): Promise<void> {
    if (!cand) return; // null 是"候选收集结束"的哨兵
    const pc = this.pc;
    if (!pc || !pc.remoteDescription) {
      this.pendingCandidates.push(cand);
      return;
    }
    try {
      await pc.addIceCandidate(cand);
    } catch {
      /* 过期候选（重发前那一轮的）直接丢，不影响当前连接 */
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const queued = this.pendingCandidates.splice(0);
    for (const cand of queued) {
      try {
        await pc.addIceCandidate(cand);
      } catch {
        /* 同上 */
      }
    }
  }

  private buildPc(): RTCPeerConnection {
    const factory =
      this.opts.createPc ??
      ((config: RTCConfiguration) => {
        if (typeof RTCPeerConnection === "undefined") {
          throw new Error("当前环境没有 RTCPeerConnection");
        }
        return new RTCPeerConnection(config);
      });
    const pc = factory({ iceServers: this.opts.iceServers() });
    this.pc = pc;

    pc.onicecandidate = (event) => {
      const cand = event.candidate ? event.candidate.toJSON() : null;
      try {
        this.pipe.send({ t: "rtc-ice", cand });
      } catch {
        /* 通道关闭时忽略 */
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        this.clearAnswerTimer();
        this.setState("connected");
      } else if (s === "failed") {
        this.setState("failed");
      }
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? (typeof MediaStream !== "undefined" ? new MediaStream([event.track]) : null);
      if (!stream) return;
      this.opts.onStream?.(stream);
    };

    if (this.opts.stream) {
      for (const track of this.opts.stream.getTracks()) pc.addTrack(track, this.opts.stream);
    } else {
      // 没麦克风也要能听：显式声明收音频，避免应答里没有 m-line
      pc.addTransceiver("audio", { direction: "recvonly" });
    }
    return pc;
  }

  private transform(sdp: string): string {
    return this.opts.sdpTransform ? this.opts.sdpTransform(sdp) : sdp;
  }

  private armAnswerTimer(): void {
    this.clearAnswerTimer();
    const timeout = this.opts.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    const max = this.opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.answerTimer = setTimeout(() => {
      this.answerTimer = null;
      if (this.closed || this.state === "connected") return;
      if (this.retries >= max) {
        this.setState("failed");
        return;
      }
      this.retries += 1;
      void this.negotiate();
    }, timeout);
  }

  private clearAnswerTimer(): void {
    if (this.answerTimer === null) return;
    clearTimeout(this.answerTimer);
    this.answerTimer = null;
  }

  private teardownPc(): void {
    const pc = this.pc;
    this.pc = null;
    this.pendingCandidates.length = 0;
    if (!pc) return;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    try {
      pc.close();
    } catch {
      /* noop */
    }
  }

  private setState(next: DcLinkState): void {
    if (this.state === next) return;
    this.state = next;
    this.opts.onState?.(next);
  }
}
