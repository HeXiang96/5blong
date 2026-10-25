/**
 * 开黑圈引擎（独立于语音房的 VoiceMesh，互不引用）。
 *
 * 与语音房的本质区别：**连接拓扑按听音群组划分**，不是全网状。
 *   - 待分队组内互相连接、进攻方组内互相连接、防守方组内互相连接；
 *   - 组与组之间**不建连接**——所以"队伍听不到对面"、"队伍听不到未分队"
 *     是拓扑的天然结果，不靠音量调节，也不会串麦；
 *   - 换队 = 断开旧组、接入新组（reconcile）。
 *
 * 规模：代码支持 20 人（5v5 + 10 待分队的最坏情况 ≈ 55 条连接，
 * 与现有语音房 8 人全网状同量级）；当前 UI 先启用 15 人观察一轮。
 *
 * 不做：屏幕共享、猪的互动、房间遥测、聊天（开黑圈都不需要）。
 * 也不做 RNNoise（后续可加；首版先保证链路正确）。
 */

import { Peer } from "peerjs";
import type { DataConnection, MediaConnection } from "peerjs";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";

import { applyAudioProfile, opusSdpTransform } from "../voice/audio-profile";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

import { SIGNAL_ROUTES } from "../voice/signal-routes";
import { startBackgroundInterval, stopBackgroundInterval } from "../voice/background-ticker";
import { ensureIceServers, iceServers } from "../voice/ice";
import {
  guestPeerId,
  hostPeerIdForCode,
  makeRoomCode,
  normalizeCode,
  randomIndex,
  randomToken,
} from "../voice/protocol";
import {
  GAME_ENABLED_LIMIT,
  isTeam,
  normalizeGameId,
  teamCap,
  type GameMember,
  type GameScores,
  type GameRoomInfo,
  type GuestToHost,
  type HostToGuest,
  type Team,
} from "./game-types";

export type GameStatus = "idle" | "preparing" | "connecting" | "connected" | "error";

export interface GameEvents {
  status: (status: GameStatus, detail?: string) => void;
  roster: (members: GameMember[], scores: GameScores, unlocked: boolean) => void;
  ready: (info: GameRoomInfo) => void;
  ended: (reason: string) => void;
  kicked: () => void;
  /** 谁在说话（按 peer id 的实时集合，电平检测得出）。 */
  speaking: (ids: string[]) => void;
}

const WELCOME_TIMEOUT_MS = 12_000;

export class GameMesh {
  private peer: Peer | null = null;
  /** 房主：guestId → 数据连接；访客：只有一条（连房主）。 */
  private dataConns = new Map<string, DataConnection>();
  private calls = new Map<string, MediaConnection>();
  private audios = new Map<string, HTMLAudioElement>();
  private members = new Map<string, GameMember>();
  private scores: GameScores = { attack: 0, defend: 0 };
  private localStream: MediaStream | null = null;
  /** 真正发布的流：麦克风 → (RNNoise) → 增益 → 输出。麦克风增强在这条链上真实生效。 */
  private publishedStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micGainNode: GainNode | null = null;
  private nsNode: RnnoiseWorkletNode | null = null;
  private micBoost = 1;
  /** 音频引擎没跑起来时只提示一次 */
  private onAudioStalled = false;
  private nsOn = true;
  /** 小结统计：开房时间、每人（在场 ms / 发言 ms）。 */
  private startedAt = 0;
  private memberStats = new Map<string, { joined: number; speak: number }>();
  private analysers = new Map<string, { node: AnalyserNode; buffer: Float32Array; timer: number }>();
  private micDeviceId = "";
  /** 静音流：待分队"听全房"时发布它——对方听不到待分队，但待分队能听到对方。 */
  private silentStream: MediaStream | null = null;
  /** 哪些 peer 是"待分队→队伍"的单向连接（只收不听）。 */
  private silentCalls = new Set<string>();
  /**
   * 单向链路看门狗：ICE 通了、但**一个音频包都收不到**（对方送不到我）。
   * 以前这里只看 ICE 状态，这种"半条腿"永远是绿的，也不会自愈。
   */
  private mediaWatchTimer = 0;
  private readonly mediaWatch = new Map<string, { packets: number; hits: number }>();
  /**
   * 每个 peer 已经因为"单向"重连过几次。
   *
   * 上限 3 次，且一旦重新收到包就清零：宁可最后停在"重连几次仍不通"，
   * 也不能和无辜的连接死磕（比如对方浏览器在闭麦时真的停发了，
   * 那属于对端行为，重连解决不了）。
   */
  private readonly onewayHeals = new Map<string, number>();
  /**
   * 每条连接"是哪一刻建的"。
   *
   * 用来收拾僵尸连接：PeerJS 关掉一条**未应答**的呼叫不会给对方任何信令，
   * 对方那条 pc 会永远停在 `new`——既不 failed 也不 disconnected，不触发任何
   * 事件；它却一直占着 `calls`，让 reconcile 的 `calls.has()` 跳过补拨。
   * 结果是这一对人永久互相听不到（2026-10-22 审查确认）。
   */
  private readonly callStartedAt = new Map<string, number>();
  /**
   * 连续重拨失败次数（按 peer）。
   *
   * forgetCall 原来固定 300ms 后重拨：对"信令侧已经不可达、但还没被移出房间"
   * 的人会变成每 3 秒一次的无限循环（15 人房里每人各跑一套）。
   * 这里按次数指数退避，真正连上就清零。
   */
  private readonly redialBackoff = new Map<string, number>();
  /** 上一次所处的队伍：一变就整组重建连接（否则残留的静音通道会吞掉声音）。 */
  private lastTeam: Team | null = null;
  /** 正在说话的人（电平超过阈值）。 */
  private speakingIds = new Set<string>();
  private localAnalyser: AnalyserNode | null = null;
  private localSpeakTimer = 0;
  /** 静音汇点：分析器必须接下游才会被处理（否则电平恒 0，说话特效永远不亮）。 */
  private silentSink: GainNode | null = null;
  private outputDeviceId = "";
  private unlocked = false;
  private hosting = false;
  private joined = false;
  private destroyed = false;
  private timers = new Set<number>();
  private title = "";
  private map = "";

  myId = "";
  code = "";
  hostId = "";
  roomKey = "";
  gameId = "";

  constructor(private readonly events: GameEvents) {}

  // ------------------------------------------------------------------ 建房

  async host(opts: { gameId: string; muted: boolean; title: string; map: string }): Promise<void> {
    if (this.destroyed) return;
    this.hosting = true;
    this.gameId = normalizeGameId(opts.gameId);
    this.title = opts.title.slice(0, 30);
    this.map = opts.map.slice(0, 20);
    this.events.status("preparing");
    try {
      await this.acquireMic(opts.muted);
    } catch (error) {
      this.events.status("error", "麦克风打开失败，请检查权限");
      throw error;
    }
    await ensureIceServers();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = makeRoomCode(randomIndex);
      const id = hostPeerIdForCode(code);
      const outcome = await this.openPeer(id);
      if (this.destroyed) return;
      if (outcome === "open") {
        this.code = code;
        this.hostId = id;
        this.myId = id;
        this.roomKey = randomToken(24);
        this.members.set(id, {
          id,
          gameId: this.gameId,
          team: "unassigned",
          muted: opts.muted,
          hasMic: !!this.localStream,
          isHost: true,
          local: true,
        });
        this.joined = true;
        this.startedAt = Date.now();
        this.touchMember(id);
        this.events.ready({ code, hostId: id, roomKey: this.roomKey, title: this.title, map: this.map });
        this.events.status("connected");
        this.emitRoster();
        return;
      }
      this.dropPeer();
      if (outcome !== "retry") {
        this.events.status("error", outcome);
        return;
      }
    }
    this.events.status("error", "创建开黑圈失败，请重试");
  }

  // ------------------------------------------------------------------ 加入

  async join(opts: { code: string; gameId: string; muted: boolean }): Promise<void> {
    if (this.destroyed) return;
    this.hosting = false;
    this.code = normalizeCode(opts.code);
    this.gameId = normalizeGameId(opts.gameId);
    this.hostId = hostPeerIdForCode(this.code);
    this.events.status("preparing");
    try {
      await this.acquireMic(opts.muted);
    } catch (error) {
      this.events.status("error", "麦克风打开失败，请检查权限");
      throw error;
    }
    await ensureIceServers();

    const outcome = await this.openPeer(guestPeerId(randomToken(12)));
    if (this.destroyed) return;
    if (outcome !== "open") {
      this.events.status("error", outcome === "retry" ? "网络不稳定，请稍后重试" : outcome);
      return;
    }
    this.myId = this.peer?.id ?? "";
    this.events.status("connecting");

    const conn = this.peer!.connect(this.hostId, { reliable: true });
    this.dataConns.set(this.hostId, conn);
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve();
        if (value) this.events.status("error", value);
      };
      const timer = window.setTimeout(() => settle("房主没有响应（可能不在线或已关房）"), WELCOME_TIMEOUT_MS);
      this.timers.add(timer);
      conn.on("open", () => {
        this.send(conn, { t: "gjoin", gameId: this.gameId, muted: this.localMuted, hasMic: !!this.localStream });
      });
      conn.on("data", (raw) => {
        const message = raw as HostToGuest;
        if (message?.t === "gwelcome") {
          this.applyWelcome(message);
          // 访客也要触发 ready：房间视图靠它从落地页切进来（此前只建房才发，访客卡在弹窗）
          this.events.ready({
            code: message.code,
            hostId: message.hostId,
            roomKey: "",
            title: message.title ?? "",
            map: message.map ?? "",
          });
          window.clearTimeout(timer);
          this.timers.delete(timer);
          settle(null);
        } else if (message?.t === "groster") {
          /*
           * 名册广播：访客必须持续应用（此前只处理了 welcome/kick，
           * 导致"每个人看到的名单各不相同"——2026-10-17 业主三端实测暴露）。
           */
          const me = message.members.find((member) => member.id === this.myId);
          this.members.clear();
          for (const member of message.members) {
            this.members.set(member.id, { ...member, local: member.id === this.myId });
          }
          this.scores = message.scores;
          this.events.roster([...this.members.values()], this.scores, this.unlocked);
          if (me) {
            this.localMuted = me.muted;
            /*
             * 名册是权威：房主侧的静音状态覆盖本地时，必须同步到实际轨道。
             * 原来只改 localMuted，于是出现"按钮显示麦克风开着、实际还在静音"
             * （gmute 因连接瞬时不可用被丢掉时最容易踩），队友说听不到、自己看不出来。
             */
            for (const track of this.localStream?.getAudioTracks() ?? []) {
              track.enabled = !this.localMuted;
            }
          }
          this.reconcileAudio();
        } else if (message?.t === "gkick") {
          settle("你已被房主移出开黑圈");
          this.events.kicked();
        }
      });
      conn.on("close", () => {
        if (this.joined) this.events.ended("房主关掉了开黑圈");
        else settle("房主没有响应（可能不在线或已关房）");
      });
    });
  }

  private localMuted = false;

  private applyWelcome(message: Extract<HostToGuest, { t: "gwelcome" }>): void {
    this.members.clear();
    for (const member of message.members) {
      this.members.set(member.id, { ...member, local: member.id === this.myId });
    }
    this.scores = message.scores;
    this.joined = true;
    if (!this.startedAt) this.startedAt = Date.now();
    this.touchMember(this.myId);
    this.events.status("connected");
    this.emitRoster();
    this.reconcileAudio();
  }

  // ------------------------------------------------------------- 队伍与状态

  /** 本人认领队伍（房主与访客都可用）。 */
  setMyTeam(team: Team): void {
    if (this.destroyed) return;
    const me = this.members.get(this.myId);
    if (!me) return;
    if (this.hosting) {
      if (!this.canJoinTeam(team, this.myId)) return;
      me.team = team;
      this.broadcastRoster();
      this.emitRoster();
      this.reconcileAudio();
      return;
    }
    this.sendToHost({ t: "gteam", team });
    // 乐观更新，等房主名册回来再对齐（房主会广播正确结果）。
    me.team = team;
    this.emitRoster();
  }

  /** 房主拖人纠错：把某个成员放进某队。 */
  hostAssign(peerId: string, team: Team): void {
    if (!this.hosting) return;
    const member = this.members.get(peerId);
    if (!member) return;
    if (!this.canJoinTeam(team, peerId)) return;
    member.team = team;
    this.broadcastRoster();
    this.emitRoster();
    this.reconcileAudio();
  }

  private canJoinTeam(team: Team, peerId: string): boolean {
    if (team === "unassigned") return true;
    const cap = teamCap(this.unlocked);
    const count = [...this.members.values()].filter((m) => m.team === team && m.id !== peerId).length;
    return count < cap;
  }

  /** 房主：解锁/恢复每队 5 人上限（应对 6v4 这类游戏内真实情况）。 */
  setTeamCapUnlocked(unlocked: boolean): void {
    if (!this.hosting) return;
    this.unlocked = unlocked;
    this.broadcastRoster();
    this.emitRoster();
  }

  /** 房主：记分。 */
  score(side: "attack" | "defend", delta: number): void {
    if (!this.hosting) return;
    const next = Math.max(0, Math.min(99, this.scores[side] + delta));
    this.scores = { ...this.scores, [side]: next };
    this.broadcastRoster();
    this.emitRoster();
  }

  resetScores(): void {
    if (!this.hosting) return;
    this.scores = { attack: 0, defend: 0 };
    this.broadcastRoster();
    this.emitRoster();
  }

  /** 房主：踢人。 */
  kick(peerId: string): void {
    if (!this.hosting) return;
    const conn = this.dataConns.get(peerId);
    if (conn) {
      this.send(conn, { t: "gkick" });
      window.setTimeout(() => {
        try {
          conn.close();
        } catch {
          /* noop */
        }
      }, 120);
    }
    this.removeMember(peerId);
  }

  setMuted(muted: boolean): void {
    this.localMuted = muted;
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) track.enabled = !muted;
    }
    const me = this.members.get(this.myId);
    if (me) {
      me.muted = muted;
      this.emitRoster();
    }
    if (this.hosting) this.broadcastRoster();
    else this.sendToHost({ t: "gmute", muted });
  }

  // ------------------------------------------------------------------ 退出

  leave(): void {
    if (this.hosting) {
      for (const conn of this.dataConns.values()) {
        try {
          conn.close();
        } catch {
          /* noop */
        }
      }
    } else {
      this.sendToHost({ t: "gbye" });
    }
    this.destroy();
  }

  destroy(): void {
    this.destroyed = true;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    for (const call of this.calls.values()) {
      try {
        call.close();
      } catch {
        /* noop */
      }
    }
    this.calls.clear();
    if (this.localSpeakTimer) stopBackgroundInterval(this.localSpeakTimer);
    this.localSpeakTimer = 0;
    if (this.mediaWatchTimer) stopBackgroundInterval(this.mediaWatchTimer);
    this.mediaWatchTimer = 0;
    this.mediaWatch.clear();
    this.onewayHeals.clear();
    this.callStartedAt.clear();
    this.redialBackoff.clear();
    for (const entry of this.analysers.values()) window.clearInterval(entry.timer);
    this.analysers.clear();
    for (const audio of this.audios.values()) {
      audio.srcObject = null;
      audio.remove();
    }
    this.audios.clear();
    for (const conn of this.dataConns.values()) {
      try {
        conn.close();
      } catch {
        /* noop */
      }
    }
    this.dataConns.clear();
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop();
      this.localStream = null;
    }
    try {
      void this.audioCtx?.close();
    } catch {
      /* noop */
    }
    this.audioCtx = null;
    this.publishedStream = null;
    this.dropPeer();
  }

  // ------------------------------------------------------------ 媒体：分组

  private getSilentStream(): MediaStream | null {
    if (this.silentStream) return this.silentStream;
    if (!this.audioCtx) return null;
    const dest = this.audioCtx.createMediaStreamDestination();
    this.silentStream = dest.stream;
    return this.silentStream;
  }

  /**
   * 我的队伍变了 → 把所有连接推倒重建。
   *
   * 为什么必须全拆：切到队伍时若保留"待分队时期的静音通道"，对端听到的是静音、
   * 我这边又因为 calls.has() 跳过新建，就会出现"第一次过去听不到、反复切几次才好"
   * （2026-10-17 业主实测）。整组重建是最确定的做法。
   */
  private rebuildAudio(): void {
    for (const [peerId, call] of this.calls) {
      try {
        call.close();
      } catch {
        /* noop */
      }
      /*
       * 监控基线必须一起清：换队后新连接是从 0 开始计包的，而旧连接的
       * {packets: 6000} 还留着的话，新连接会被单向看门狗判成"包数没涨"，
       * 15~25 秒后把一条完全健康的连接拆掉（换队越勤越明显）。
       */
      this.mediaWatch.delete(peerId);
      this.onewayHeals.delete(peerId);
      this.callStartedAt.delete(peerId);
      this.redialBackoff.delete(peerId);
      this.dropAudio(peerId);
    }
    this.calls.clear();
    this.silentCalls.clear();
    this.reconcileAudio();
  }

  /**
   * 按"同队才连"重建音频连接：
   *   目标集 = 与我同 group 的成员（未分队/进攻/防守各成一组）。
   *   为避免双向重复呼叫，只由 id 较小的一方发起。
   *   跨组的人（换队后）会被挂断。
   */
  private reconcileAudio(): void {
    /*
     * 没有麦克风也要继续对账（2026-10-25，与语音房同一处修正）。
     *
     * 拨号方只由"id 较小的一方"决定；如果那一位恰好没有麦克风，原来这里直接
     * return，对方又按规则不拨 → 这一对永远连不上（别人都正常）。
     * 现在允许用空流发起（协商成只收不发），他能听见队友，只是不发送。
     */
    if (!this.joined) return;
    const me = this.members.get(this.myId);
    if (!me) return;
    if (this.lastTeam !== null && this.lastTeam !== me.team) {
      // 我的队伍变了：先全拆再连（见 rebuildAudio 注释）
      this.lastTeam = me.team;
      this.rebuildAudio();
      return;
    }
    this.lastTeam = me.team;
    this.startMediaWatch();
    const desired = new Set<string>();
    const unassigned = me.team === "unassigned";
    for (const member of this.members.values()) {
      if (member.id === this.myId) continue;
      if (unassigned) {
        // 待分队：听全房（两队 + 待分队自身），但对队伍只发静音（他们听不到我）
        desired.add(member.id);
      } else if (member.team === me.team) {
        // 队伍：只连同队（听不到对面，也听不到待分队）
        desired.add(member.id);
      }
    }
    // 挂断不再需要的人
    for (const [peerId, call] of this.calls) {
      if (desired.has(peerId)) continue;
      /*
       * 队伍侧必须留住"待分队发来的连接"：那是待分队听全房（两队 + 待分队）
       * 的唯一通路。以前这里按 desired 一律挂断，于是待分队刚连上就被拆、
       * 300ms 后再连——来回抖，表现成"时有时无"。
       */
      const peerMember = this.members.get(peerId);
      if (!unassigned && peerMember?.team === "unassigned") continue;
      try {
        call.close();
      } catch {
        /* noop */
      }
      this.calls.delete(peerId);
      this.silentCalls.delete(peerId);
      this.dropAudio(peerId);
    }
    // 发起新连接：待分队→队伍 必须由待分队发起（队伍永远不会主动连待分队）
    for (const peerId of desired) {
      const peerMember = this.members.get(peerId);
      const peerIsTeam = !!(peerMember && peerMember.team !== "unassigned");
      if (unassigned && peerIsTeam && this.calls.has(peerId) && !this.silentCalls.has(peerId)) {
        // 刚从队伍切回待分队：旧连接还在用"真实麦克风"，队友会听到我——必须立刻换成静音通道
        const stale = this.calls.get(peerId)!;
        try {
          stale.close();
        } catch {
          /* noop */
        }
        this.calls.delete(peerId);
        this.dropAudio(peerId);
      }
      if (this.calls.has(peerId)) continue;
      if (unassigned && peerIsTeam) {
        // 只收不听：发静音流，收对方的声音
        const silent = this.getSilentStream();
        if (!silent) continue;
        try {
          const call = this.peer!.call(peerId, silent, { sdpTransform: opusSdpTransform("voice") });
          if (!call) continue;
          this.calls.set(peerId, call);
          this.callStartedAt.set(peerId, Date.now());
          this.silentCalls.add(peerId);
          call.on("stream", (stream) => this.attachAudio(peerId, stream));
          call.on("close", () => this.forgetCall(peerId, call));
          call.on("error", () => this.forgetCall(peerId, call));
          this.watchCallHealth(call, peerId);
        } catch {
          /* 单个呼叫失败不影响其他人 */
        }
        continue;
      }
      if (this.myId >= peerId) continue;
      try {
        const call = this.peer!.call(peerId, this.publishedStream ?? this.localStream ?? new MediaStream(), {
          sdpTransform: opusSdpTransform("voice"),
        });
        if (!call) continue;
        this.calls.set(peerId, call);
        this.callStartedAt.set(peerId, Date.now());
        call.on("stream", (stream) => this.attachAudio(peerId, stream));
        call.on("close", () => this.forgetCall(peerId, call));
        call.on("error", () => this.forgetCall(peerId, call));
        this.watchCallHealth(call, peerId);
      } catch {
        /* 单个呼叫失败不影响其他人 */
      }
    }
  }

  /** 启动单向链路看门狗（幂等；进房后随 reconcile 一起拉起）。 */
  private startMediaWatch(): void {
    if (this.mediaWatchTimer || this.destroyed) return;
    // 走 Worker 计时：窗口最小化/切到游戏时，主线程定时器会被节流到 1 秒乃至 1 分钟一次，
    // 单向无声就要等一分钟才发现（这个循环是语音健康的核心）
    this.mediaWatchTimer = startBackgroundInterval(5000, () => void this.pollInbound());
  }

  /**
   * 每 5 秒看一次"我到底有没有收到对方的声音"。
   *
   * 为什么要单独做：ICE 进入 connected 只证明候选打通了，**单向不通**时
   * ICE 依然是 connected（RTCP 还在走），getStats 里 inbound 音频包恒为 0。
   * 这就是"a 听不到 e、e 却听得到 a"的形态：两边都显示正常，谁也不会重连。
   *
   * 判据刻意收窄，避免误伤：
   * - 看的是**包**，不是声音大小：SDP 里 usedtx=0（见 audio-profile），闭麦也只是
   *   track.enabled=false——两种情况 RTP 都照常按 ~50 包/秒在发。FPS 蹲点几十秒
   *   不说话，包数一样在涨，不会被误判；
   * - 跳过没麦的人、闭麦的人、待分队发的静音通道（那是设计）；
   * - 从没收到过连续 3 次（≈15 秒）、收到过又停 5 次（≈25 秒）才动手；
   * - 每人最多重连 3 次，重新收到包就清零，不会和连接死磕。
   */
  private async pollInbound(): Promise<void> {
    if (this.destroyed || !this.joined) return;
    for (const [peerId, call] of [...this.calls]) {
      const member = this.members.get(peerId);
      /*
       * 僵尸连接先处理：**未应答的呼叫**永远不会产生任何事件，
       * 所以这一步必须放在"没麦/闭麦/待分队"这些过滤之前，否则
       * 无麦成员的僵尸腿会一直占着 calls。（PeerJS 关掉未应答的呼叫
       * 不会通知对端，对端 pc 会永远停在 new。）
       */
      const pc = (call as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
      const ice = pc?.iceConnectionState ?? "new";
      if (!pc || ice === "new" || ice === "checking") {
        const startedAt = this.callStartedAt.get(peerId) ?? Date.now();
        if (!this.callStartedAt.has(peerId)) this.callStartedAt.set(peerId, startedAt);
        if (Date.now() - startedAt > 12_000) {
          this.mediaWatch.delete(peerId);
          this.callStartedAt.delete(peerId);
          try {
            call.close();
          } catch {
            /* noop */
          }
          this.forgetCall(peerId, call);
        }
        continue;
      }
      if (!member || member.hasMic === false) continue;
      if (this.silentCalls.has(peerId)) continue;
      // 他闭着麦：包的来源是对端行为，别和它死磕
      if (member.muted) {
        this.mediaWatch.delete(peerId);
        continue;
      }
      // 我在队伍、对方在待分队：按设计就该收不到他（他发的是静音流）
      if (this.lastTeam !== "unassigned" && member.team === "unassigned") continue;
      if (ice !== "connected" && ice !== "completed") {
        this.mediaWatch.delete(peerId);
        continue;
      }
      /*
       * 自动播放被拦 / 元素被系统暂停时兜底重播：
       * game 侧没有别的地方会重新调 play（语音房那边 playStream 会重试）。
       */
      const audio = this.audios.get(peerId);
      if (audio && audio.paused && audio.srcObject) void audio.play().catch(() => undefined);
      let packets = 0;
      try {
        const stats = await pc.getStats();
        stats.forEach((report) => {
          if (report.type !== "inbound-rtp") return;
          const r = report as RTCInboundRtpStreamStats & { kind?: string; mediaType?: string };
          if ((r.kind ?? r.mediaType) !== "audio") return;
          packets += r.packetsReceived ?? 0;
        });
      } catch {
        continue;
      }
      const prev = this.mediaWatch.get(peerId);
      const grew = packets > (prev?.packets ?? 0) && packets > 0;
      if (grew) {
        this.onewayHeals.delete(peerId); // 通了：把"单向重连"次数清零
        this.redialBackoff.delete(peerId); // 重拨退避也清零
      }
      const hits = grew ? 0 : (prev?.hits ?? 0) + 1;
      this.mediaWatch.set(peerId, { packets, hits });
      // 从没收到过：3 次（≈15 秒）；收到过又停了：5 次（≈25 秒）
      const limit = packets === 0 ? 3 : 5;
      if (grew || hits < limit) continue;
      // 单向不通：拆掉这条腿，forgetCall 会重新对账补一条新连接
      this.mediaWatch.delete(peerId);
      const healed = (this.onewayHeals.get(peerId) ?? 0) + 1;
      this.onewayHeals.set(peerId, healed);
      const name = member.gameId || peerId.slice(0, 6);
      if (healed > 3) {
        // 重连三次仍单向：大概率是对端/线路的持久问题，别再拆了，免得来回抖
        this.events.status("error", `与「${name}」的语音仍然只有单向，建议让他重进房`);
        continue;
      }
      this.events.status("error", `与「${name}」的语音只有单向，正在重连（第 ${healed} 次）`);
      try {
        call.close();
      } catch {
        /* noop */
      }
      this.forgetCall(peerId, call);
    }
  }

  /**
   * 盯住一条语音链路的 ICE 状态。
   *
   * 原来的实现只在 call 触发 close/error 时才重连；而 ICE 静默死掉时
   * **不会触发 close**——表现就是"打着打着队友没声了，必须退房重进"。
   * 这里补上：failed 立即收；disconnected 给 4 秒缓冲仍不恢复才收。
   * 收掉之后 forgetCall 会重新对账（reconcileAudio）自动补拨。
   */
  private watchCallHealth(call: MediaConnection, peerId: string): void {
    let tries = 0;
    const attach = () => {
      const pc = (call as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
      if (!pc) {
        if (tries++ < 15 && !this.destroyed) window.setTimeout(attach, 200);
        return;
      }
      void applyAudioProfile(pc, "voice");
      pc.addEventListener("iceconnectionstatechange", () => {
        const state = pc.iceConnectionState;
        const drop = () => {
          if (this.calls.get(peerId) !== call) return;
          try {
            call.close();
          } catch {
            /* noop */
          }
          this.forgetCall(peerId, call);
        };
        if (state === "failed") {
          drop();
          return;
        }
        if (state === "disconnected") {
          // 短暂抖动很常见（切网/丢包），先给 4 秒自愈机会
          window.setTimeout(() => {
            if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") drop();
          }, 4000);
        }
      });
    };
    attach();
  }

  /** 这条 MediaConnection 是否已经不可用（底层 pc 关闭/失败/长期断开）。 */
  private isCallDead(call: MediaConnection): boolean {
    const pc = (call as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
    if (!pc) return false; // 还没建好：先当活的
    const state = pc.connectionState;
    const ice = pc.iceConnectionState;
    /*
     * **不把 disconnected 当死亡**（2026-10-25，与语音房同一处修正）。
     *
     * 丢包/切网时 ICE 会短暂 disconnected，通常几秒自愈。这里算死的话，
     * 收到对方的重复呼叫就会把**还活着的**那条当成"旧的"关掉、改接新的，
     * 一来一回就是"打着打着没声了"。真死由 watchCallHealth 的 4 秒缓冲裁决。
     */
    return state === "closed" || state === "failed" || ice === "closed" || ice === "failed";
  }

  /**
   * 这个来电该不该接。
   *
   * 拓扑规则（见 game-types 注释）：同队互通；待分队听全房，队伍听不到待分队和对面。
   * 所以：待分队接所有人；队伍只接同队 + 待分队发来的单向静音通道。
   * 名册没同步到就先接，下一轮 reconcile 会按最新名册挂断。
   */
  private shouldAcceptCall(peerId: string): boolean {
    const me = this.members.get(this.myId);
    const peer = this.members.get(peerId);
    if (!me || !peer) return true;
    if (me.team === "unassigned") return true;
    return peer.team === me.team || peer.team === "unassigned";
  }

  /**
   * 只收拾"当前这一条"连接。
   *
   * ⚠️ 必须带身份校验：旧连接的 close 常常迟到，那时新连接已经在放声音了。
   * 以前按 peerId 一把梭，会把新连接的映射和音频元素一起删掉——新流不会
   * 再触发 stream 事件，于是这对人从此单向没声（2026-10-22 的现场症状）。
   */
  private forgetCall(peerId: string, call?: MediaConnection): void {
    if (call && this.calls.get(peerId) !== call) return;
    this.calls.delete(peerId);
    this.silentCalls.delete(peerId);
    this.mediaWatch.delete(peerId);
    this.callStartedAt.delete(peerId);
    this.dropAudio(peerId);
    /*
     * 队友换队时会挂断我的连接（他不再和我同组），而我这边什么都不做就会"没声音"。
     * 稍等一拍重新对账：如果我现在是待分队，会以"只收不听"的静音通道重新连上他。
     */
    const fails = (this.redialBackoff.get(peerId) ?? 0) + 1;
    this.redialBackoff.set(peerId, fails);
    // 300ms → 600 → 1.2s → … 封顶 30 秒
    const delay = Math.min(30_000, 300 * 2 ** Math.min(fails - 1, 7));
    window.setTimeout(() => {
      if (!this.destroyed && this.joined) this.reconcileAudio();
    }, delay);
  }

  private setSpeaking(id: string, speaking: boolean): void {
    const had = this.speakingIds.has(id);
    if (speaking === had) return;
    if (speaking) this.speakingIds.add(id);
    else this.speakingIds.delete(id);
    this.events.speaking([...this.speakingIds]);
  }

  private getSilentSink(): GainNode | null {
    if (!this.audioCtx) return null;
    if (!this.silentSink) {
      const sink = this.audioCtx.createGain();
      sink.gain.value = 0;
      sink.connect(this.audioCtx.destination);
      this.silentSink = sink;
    }
    return this.silentSink;
  }

  private touchMember(id: string): void {
    if (!this.memberStats.has(id)) this.memberStats.set(id, { joined: Date.now(), speak: 0 });
  }

  private attachAudio(peerId: string, stream: MediaStream): void {
    if (this.destroyed) return;
    this.touchMember(peerId);
    let audio = this.audios.get(peerId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      document.body.appendChild(audio);
      this.audios.set(peerId, audio);
    }
    audio.srcObject = stream;
    audio.volume = this.volumeOfPeer(peerId);
    if (this.outputDeviceId) {
      const el = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof el.setSinkId === "function") void el.setSinkId(this.outputDeviceId).catch(() => undefined);
    }
    if (this.audioCtx) {
      /*
       * 换了流（自愈重拨 / 换队重建）必须换分析器：老分析器接的是老流的节点，
       * 拿它算电平，说话高亮和发言统计会一直失真（甚至一直是 0）。
       */
      const prev = this.analysers.get(peerId);
      if (prev) {
        window.clearInterval(prev.timer);
        try {
          prev.node.disconnect();
        } catch {
          /* noop */
        }
        this.analysers.delete(peerId);
      }
      try {
        const src = this.audioCtx.createMediaStreamSource(stream);
        const node = this.audioCtx.createAnalyser();
        node.fftSize = 512;
        src.connect(node);
        const sink = this.getSilentSink();
        if (sink) node.connect(sink);
        const buffer = new Float32Array(node.fftSize);
        const timer = window.setInterval(() => {
          node.getFloatTimeDomainData(buffer);
          let sum = 0;
          for (const v of buffer) sum += v * v;
          const rms = Math.sqrt(sum / buffer.length);
          const speech = rms > 0.02;
          if (speech) {
            const stat = this.memberStats.get(peerId);
            if (stat) stat.speak += 200;
          }
          this.setSpeaking(peerId, speech);
        }, 200);
        this.analysers.set(peerId, { node, buffer, timer });
      } catch {
        /* 统计失败不影响通话 */
      }
    }
    void audio.play().catch(() => {
      /* 自动播放被拦：等用户下一次交互由 UI 再调 play */
    });
  }

  /** 某个成员的接收音量（0~2，按游戏 ID 记忆在 localStorage）。 */
  private volumeOfPeer(peerId: string): number {
    const gameId = this.members.get(peerId)?.gameId ?? "";
    return this.peerVolumes[gameId] ?? 1;
  }

  private peerVolumes: Record<string, number> = {};

  /** 批量载入本机记忆的接收音量（进房时调用）。 */
  setPeerVolumes(map: Record<string, number>): void {
    this.peerVolumes = { ...map };
  }

  /** 设置对某游戏 ID 的接收音量（0~2），立即应用到已存在的音频元素。 */
  setPeerVolume(gameId: string, volume: number): void {
    const clamped = Math.min(2, Math.max(0, volume));
    this.peerVolumes = { ...this.peerVolumes, [gameId]: clamped };
    for (const [peerId, member] of this.members) {
      if (member.gameId !== gameId) continue;
      const audio = this.audios.get(peerId);
      if (audio) audio.volume = clamped;
    }
  }

  /** 调试快照（自动化测试用）：当前连接、静音通道、我的队伍。 */
  getDebug(): { calls: string[]; silent: string[]; team: Team | null; speaking: string[]; rms: number } {
    let rms = 0;
    if (this.localAnalyser) {
      const buf = new Float32Array(this.localAnalyser.fftSize);
      this.localAnalyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      rms = Math.sqrt(sum / buf.length);
    }
    return { calls: [...this.calls.keys()], silent: [...this.silentCalls], team: this.lastTeam, speaking: [...this.speakingIds], rms };
  }

  getPeerVolumes(): Record<string, number> {
    return { ...this.peerVolumes };
  }

  private dropAudio(peerId: string): void {
    const entry = this.analysers.get(peerId);
    if (entry) {
      window.clearInterval(entry.timer);
      try {
        entry.node.disconnect();
      } catch {
        /* noop */
      }
      this.analysers.delete(peerId);
    }
    this.setSpeaking(peerId, false);
    const audio = this.audios.get(peerId);
    if (!audio) return;
    audio.srcObject = null;
    audio.remove();
    this.audios.delete(peerId);
  }

  // ---------------------------------------------------------- 数据通道与名册

  private onHostConnection(conn: DataConnection): void {
    conn.on("data", (raw) => this.onGuestMessage(conn, raw as GuestToHost));
    conn.on("close", () => {
      for (const [peerId, existing] of this.dataConns) {
        if (existing === conn) {
          this.removeMember(peerId);
          break;
        }
      }
    });
  }

  private onGuestMessage(conn: DataConnection, message: GuestToHost): void {
    if (!message || typeof message !== "object") return;
    const guestId = conn.peer;
    if (message.t === "gjoin") {
      if (this.members.size >= GAME_ENABLED_LIMIT) {
        conn.close();
        return;
      }
      const gameId = normalizeGameId(message.gameId);
      if (!gameId) {
        conn.close();
        return;
      }
      this.dataConns.set(guestId, conn);
      this.members.set(guestId, {
        id: guestId,
        gameId,
        team: "unassigned",
        muted: !!message.muted,
        hasMic: !!message.hasMic,
        isHost: false,
        local: false,
      });
      this.send(conn, {
        t: "gwelcome",
        code: this.code,
        hostId: this.hostId,
        members: this.serializeMembers(guestId),
        scores: this.scores,
        you: guestId,
        title: this.title,
        map: this.map,
      });
      this.broadcastRoster();
      this.emitRoster();
      this.reconcileAudio();
      return;
    }
    const member = this.members.get(guestId);
    if (!member) return;
    if (message.t === "gteam") {
      if (isTeam(message.team) && this.canJoinTeam(message.team, guestId)) {
        this.hostAssign(guestId, message.team);
      }
      return;
    }
    if (message.t === "gmute") {
      member.muted = !!message.muted;
      this.broadcastRoster();
      this.emitRoster();
      return;
    }
    if (message.t === "gbye") {
      this.removeMember(guestId);
    }
  }

  private removeMember(peerId: string): void {
    this.members.delete(peerId);
    const conn = this.dataConns.get(peerId);
    if (conn) {
      try {
        conn.close();
      } catch {
        /* noop */
      }
      this.dataConns.delete(peerId);
    }
    const call = this.calls.get(peerId);
    if (call) {
      try {
        call.close();
      } catch {
        /* noop */
      }
      this.calls.delete(peerId);
      this.silentCalls.delete(peerId);
      this.mediaWatch.delete(peerId);
      this.dropAudio(peerId);
    }
    if (this.hosting) {
      this.broadcastRoster();
      this.emitRoster();
      this.reconcileAudio();
    }
  }

  /** 名册序列化：`local` 按收件人计算，避免把房主视角的 local 发给访客。 */
  private serializeMembers(forPeerId?: string): GameMember[] {
    return [...this.members.values()].map((member) => ({
      ...member,
      local: forPeerId ? member.id === forPeerId : member.local,
    }));
  }

  private broadcastRoster(): void {
    if (!this.hosting) return;
    for (const [peerId, conn] of this.dataConns) {
      this.send(conn, {
        t: "groster",
        members: this.serializeMembers(peerId),
        scores: this.scores,
      });
    }
  }

  private emitRoster(): void {
    this.events.roster([...this.members.values()], this.scores, this.unlocked);
  }

  /** 房间小结：比分、时长、每人在场与发言时长（房主/访客都能在离开时拿到）。 */
  getSummary(): {
    code: string;
    title: string;
    map: string;
    scores: GameScores;
    durationMs: number;
    rows: { gameId: string; team: Team; presentMs: number; speakMs: number }[];
  } {
    const now = Date.now();
    return {
      code: this.code,
      title: this.title,
      map: this.map,
      scores: { ...this.scores },
      durationMs: this.startedAt ? now - this.startedAt : 0,
      rows: [...this.members.values()].map((member) => {
        const stat = this.memberStats.get(member.id);
        return {
          gameId: member.gameId,
          team: member.team,
          presentMs: stat ? Math.max(0, now - stat.joined) : 0,
          speakMs: stat?.speak ?? 0,
        };
      }),
    };
  }

  private send(conn: DataConnection, payload: GuestToHost | HostToGuest): void {
    try {
      if (conn.open) conn.send(payload);
    } catch {
      /* 对方已断，交给 close 事件处理 */
    }
  }

  private sendToHost(payload: GuestToHost): void {
    const conn = this.dataConns.get(this.hostId);
    if (conn) this.send(conn, payload);
  }

  // -------------------------------------------------------------- peer 基础

  private openPeer(id: string, routeIndex = 0): Promise<string> {
    return new Promise<string>((resolve) => {
      if (this.destroyed) {
        resolve("已离开");
        return;
      }
      const route = SIGNAL_ROUTES[Math.min(routeIndex, SIGNAL_ROUTES.length - 1)]!;
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
        window.clearTimeout(timer);
        resolve(value);
      };
      const timer = window.setTimeout(() => finish("连接信令服务器超时，请检查网络后重试"), WELCOME_TIMEOUT_MS);
      this.timers.add(timer);
      peer.on("open", () => {
        peer.on("connection", (conn) => {
          if (this.hosting) this.onHostConnection(conn);
          else {
            try {
              conn.close();
            } catch {
              /* noop */
            }
          }
        });
        peer.on("call", (call) => {
          const existing = this.calls.get(call.peer);
          /*
           * 重复呼叫必须挡掉（2026-10-22 抓到的单向无声根因之一）。
           *
           * 以前这里是"来了就答、答完就 set"，同一个 peer 可能同时挂着两条
           * MediaConnection。先关掉的那条 close 后会把**当前这条**的映射和
           * 音频元素一起收走（forgetCall 只按 peerId 记账），而新流不会再触发
           * stream 事件，于是这对人从此单向没声，只能重进房。
           * 已有健康连接时，重复来的直接丢弃。
           */
          if (existing && existing !== call && !this.isCallDead(existing)) {
            try {
              call.close();
            } catch {
              /* noop */
            }
            return;
          }
          // 跨组不接（名册还没同步到时先接，下一轮 reconcile 会对账）
          if (!this.shouldAcceptCall(call.peer)) {
            try {
              call.close();
            } catch {
              /* noop */
            }
            return;
          }
          if (existing && existing !== call) {
            // 旧连接已经死了：先摘掉再接管，免得它的 close 迟到把新连接打掉
            this.calls.delete(call.peer);
            this.silentCalls.delete(call.peer);
            this.dropAudio(call.peer);
          }
          /*
           * 唤醒音频引擎：AudioContext 处于 suspended 时 MediaStreamDestination
           * 产出的是**静音**——"对方听得到我、我听不到对方"的经典成因。
           */
          if (this.audioCtx && this.audioCtx.state !== "running") {
            void this.audioCtx.resume().catch(() => undefined);
          }
          call.answer(this.publishedStream ?? this.localStream ?? undefined, {
            sdpTransform: opusSdpTransform("voice"),
          });
          call.on("stream", (stream) => this.attachAudio(call.peer, stream));
          call.on("close", () => this.forgetCall(call.peer, call));
          call.on("error", () => this.forgetCall(call.peer, call));
          this.calls.set(call.peer, call);
          this.callStartedAt.set(call.peer, Date.now());
          this.watchCallHealth(call, call.peer);
        });
        peer.on("disconnected", () => {
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
        if (settled) return;
        if (type === "unavailable-id") {
          finish("retry");
          return;
        }
        if (type === "peer-unavailable") {
          finish("房主不在线，邀请可能已失效");
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

  private async acquireMic(muted: boolean): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        ...(this.micDeviceId ? { deviceId: { exact: this.micDeviceId } } : {}),
      },
      video: false,
    });
    for (const track of stream.getAudioTracks()) track.enabled = !muted;
    this.localStream = stream;
    this.localMuted = muted;
    await this.buildOutgoing();
  }

  /**
   * 发送链：麦克风 →（RNNoise 强降噪，可关）→ 增益（麦克风增强，真 GainNode，
   * 小嗓门队友拉到 200%~400% 是真放大）→ 输出流。publishedStream 才是发布给同伴的。
   * ⚠️ 与语音房同一坑：采集默认开 AGC，手动增益会被 AGC 压回去——
   * 增益 >100% 时自动挂起 AGC（applyConstraints），回到 ≤100% 恢复。
   */
  private async buildOutgoing(): Promise<void> {
    if (!this.localStream) return;
    if (!this.audioCtx || this.audioCtx.state === "closed") {
      this.audioCtx = new AudioContext();
    }
    const ctx = this.audioCtx;
    /*
     * 和语音房同一个坑（2026-10-21 修过一次）：AudioContext 在无用户手势 /
     * 页面后台时是 suspended，此时 MediaStreamDestination 产出的是**静音流**——
     * 队友完全听不到你，而界面上一切正常。所以进房后必须显式唤醒并复查。
     */
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {
        /* 交给下面的复查 */
      }
    }
    if (ctx.state !== "running" && !this.onAudioStalled) {
      this.onAudioStalled = true;
      this.events.status("error", "音频引擎没启动：点一下窗口，或在设置里重新选麦克风");
    }
    // 拆旧链（换降噪开关时重建）
    try {
      this.nsNode?.disconnect();
      this.micSourceNode?.disconnect();
      this.micGainNode?.disconnect();
    } catch {
      /* noop */
    }
    this.nsNode = null;

    const source = ctx.createMediaStreamSource(this.localStream);
    const gain = ctx.createGain();
    gain.gain.value = this.micBoost;
    this.micSourceNode = source;
    this.micGainNode = gain;
    const dest = ctx.createMediaStreamDestination();

    if (this.nsOn) {
      try {
        await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
        const wasmBinary = await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
        const ns = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
        this.nsNode = ns;
        source.connect(ns);
        ns.connect(gain);
      } catch {
        source.connect(gain);
      }
    } else {
      source.connect(gain);
    }
    gain.connect(dest);
    /*
     * 说话检测：从"增益之后"接分析器（静音/增益 0 时不亮），
     * 每 160ms 采样一次，集合变化才通知 UI。
     */
    try {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      gain.connect(analyser);
      const sink = this.getSilentSink();
      if (sink) analyser.connect(sink);
      this.localAnalyser = analyser;
      if (this.localSpeakTimer) stopBackgroundInterval(this.localSpeakTimer);
      const buffer = new Float32Array(analyser.fftSize);
      this.localSpeakTimer = startBackgroundInterval(160, () => {
        if (!this.localAnalyser) return;
        this.localAnalyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (const v of buffer) sum += v * v;
        const speaking = Math.sqrt(sum / buffer.length) > 0.02 && !this.localMuted;
        this.setSpeaking(this.myId, speaking);
        // 自己的发言时长也要累计（原来只给远端累加，小结里"我"恒为 0 秒）
        if (speaking) {
          const stat = this.memberStats.get(this.myId);
          if (stat) stat.speak += 160;
        }
      });
    } catch {
      /* 检测失败不影响通话 */
    }
    this.publishedStream = dest.stream;
    /*
     * 换流之后必须把新轨推到**已经建立**的连接上。
     *
     * 否则老连接还在发老 dest 的那条轨，而老链的 source/gain 刚刚被 disconnect——
     * 那条轨从这一刻起永远是静音：**对方听不到你，你却还能听到他**。
     * 开关"强降噪"、切麦都会走到这里，这正对上"有时候、有的人听不到我"。
     */
    this.replacePublishedTrack();
    // AGC 与手动增益互搏：>100% 挂起 AGC
    await this.applyAgcForBoost(this.micBoost > 1);
  }

  /** 把当前 publishedStream 的音轨替换到所有已建立的连接（静音通道保持静音）。 */
  private replacePublishedTrack(): void {
    const fresh = this.publishedStream?.getAudioTracks()[0];
    if (!fresh) return;
    for (const [peerId, call] of this.calls) {
      // 待分队→队伍 的通道按设计就该发静音，不能换成麦克风
      if (this.silentCalls.has(peerId)) continue;
      const pc = (call as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
      const sender = pc?.getSenders().find((s) => s.track?.kind === "audio");
      if (sender) void sender.replaceTrack(fresh).catch(() => undefined);
    }
  }

  private async applyAgcForBoost(boosted: boolean): Promise<void> {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track || typeof track.applyConstraints !== "function") return;
    try {
      await track.applyConstraints({ advanced: [{ autoGainControl: !boosted }] });
    } catch {
      /* 设备不支持运行时改约束就算了 */
    }
  }

  /** 麦克风增强（1.0 = 原声，最大 4.0），即时生效并持久化由调用方负责。 */
  async setMicBoost(value: number): Promise<void> {
    const clamped = Math.min(4, Math.max(1, value));
    this.micBoost = clamped;
    if (this.micGainNode && this.audioCtx) {
      this.micGainNode.gain.setTargetAtTime(clamped, this.audioCtx.currentTime, 0.01);
    }
    await this.applyAgcForBoost(clamped > 1);
  }

  /** 枚举可用音频设备（需要已获得过麦克风权限，标签才可见）。 */
  async listAudioDevices(): Promise<{
    inputs: { id: string; label: string }[];
    outputs: { id: string; label: string }[];
  }> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices
      .filter((d) => d.kind === "audioinput")
      .map((d, i) => ({ id: d.deviceId, label: d.label || `麦克风 ${i + 1}` }));
    const outputs = devices
      .filter((d) => d.kind === "audiooutput")
      .map((d, i) => ({ id: d.deviceId, label: d.label || `扬声器 ${i + 1}` }));
    return { inputs, outputs };
  }

  /** 切麦克风：重开采集 → 重建发送链 → 替换所有已建立连接上的音轨。 */
  async setMicDevice(deviceId: string): Promise<void> {
    const old = this.localStream;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
        video: false,
      });
    } catch (error) {
      /*
       * 打不开就别记这个 id。原来先写 micDeviceId、再取流，一旦设备被拔/被占用，
       * 坏 id 会永久留在本地，之后每次进房都带 {deviceId:{exact:坏id}} 失败，
       * 而房内设备下拉只在进房后可见 —— 等于再也进不去。
       */
      this.events.status("error", "这个麦克风打不开（可能被占用或已拔出），仍在用原来的设备");
      throw error;
    }
    this.micDeviceId = deviceId; // 确认可用才记住
    for (const track of stream.getAudioTracks()) track.enabled = !this.localMuted;
    this.localStream = stream;
    await this.buildOutgoing(); // 内部已把新轨推到所有已有连接（静音通道除外）
    if (old) for (const t of old.getTracks()) t.stop();
  }

  /** 切输出设备（扬声器）：对每个远端音频元素 setSinkId。 */
  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    for (const audio of this.audios.values()) {
      const el = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof el.setSinkId === "function") {
        try {
          await el.setSinkId(deviceId);
        } catch {
          /* 浏览器不支持或设备已拔出 */
        }
      }
    }
  }

  /** 开关 RNNoise 强降噪（重建发送链）。 */
  async setNoiseSuppression(on: boolean): Promise<void> {
    if (this.nsOn === on) return;
    this.nsOn = on;
    await this.buildOutgoing();
  }
}
