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

import { SIGNAL_ROUTES } from "../voice/signal-routes";
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
          window.clearTimeout(timer);
          this.timers.delete(timer);
          settle(null);
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
    this.dropPeer();
  }

  // ------------------------------------------------------------ 媒体：分组

  /**
   * 按"同队才连"重建音频连接：
   *   目标集 = 与我同 group 的成员（未分队/进攻/防守各成一组）。
   *   为避免双向重复呼叫，只由 id 较小的一方发起。
   *   跨组的人（换队后）会被挂断。
   */
  private reconcileAudio(): void {
    if (!this.joined || !this.localStream) return;
    const me = this.members.get(this.myId);
    if (!me) return;
    const desired = new Set<string>();
    for (const member of this.members.values()) {
      if (member.id === this.myId) continue;
      if (member.team === me.team) desired.add(member.id);
    }
    // 挂断不再需要的人
    for (const [peerId, call] of this.calls) {
      if (!desired.has(peerId)) {
        try {
          call.close();
        } catch {
          /* noop */
        }
        this.calls.delete(peerId);
        this.dropAudio(peerId);
      }
    }
    // 发起新连接（id 小的一方主动，避免双方同时 call）
    for (const peerId of desired) {
      if (this.calls.has(peerId)) continue;
      if (this.myId >= peerId) continue;
      try {
        const call = this.peer!.call(peerId, this.localStream);
        if (!call) continue;
        this.calls.set(peerId, call);
        call.on("stream", (stream) => this.attachAudio(peerId, stream));
        call.on("close", () => this.forgetCall(peerId));
        call.on("error", () => this.forgetCall(peerId));
      } catch {
        /* 单个呼叫失败不影响其他人 */
      }
    }
  }

  private forgetCall(peerId: string): void {
    this.calls.delete(peerId);
    this.dropAudio(peerId);
  }

  private attachAudio(peerId: string, stream: MediaStream): void {
    if (this.destroyed) return;
    let audio = this.audios.get(peerId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      document.body.appendChild(audio);
      this.audios.set(peerId, audio);
    }
    audio.srcObject = stream;
    void audio.play().catch(() => {
      /* 自动播放被拦：等用户下一次交互由 UI 再调 play */
    });
  }

  private dropAudio(peerId: string): void {
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
          call.answer(this.localStream ?? undefined);
          call.on("stream", (stream) => this.attachAudio(call.peer, stream));
          call.on("close", () => this.forgetCall(call.peer));
          this.calls.set(call.peer, call);
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
      },
      video: false,
    });
    for (const track of stream.getAudioTracks()) track.enabled = !muted;
    this.localStream = stream;
    this.localMuted = muted;
  }
}
