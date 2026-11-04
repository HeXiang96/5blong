/**
 * 梗王对局 · 网络层（docs/DUEL-NET-PLAN.md 方案 A）
 *
 * 结构：
 *   DuelTransport        收发接口（invite / poll / leave）
 *   RemoteDuelTransport  走 ECS 的 /api/duel/*（生产）
 *   LocalDuelTransport   localStorage 信箱（本地 dev，两个标签页=两台设备）
 *   useDuel              轮询循环 + 邀请/对局状态机 + 给 UI 的 bridge
 *
 * 为什么本地也走同一个状态机：本地测试要验的是**流程**（邀请→接受→对局→退出
 * 的每个状态迁移），不是网络抖动。Transport 只换「信箱放哪」，状态机完全共享。
 *
 * 版本号约定：快照 version 由本文件管理（服务端校验单调递增），
 * 房主端 registerState 一次就 +1，访客端只读不写。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DuelAction, DuelSnapshot } from "./duel-engine";

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export type DuelRole = "host" | "guest";
export type DuelPhase = "invite" | "playing" | "over" | "cancelled";

export interface DuelMember { id: string; name: string }

export interface DuelSessionView {
  gameId: string;
  room: string;
  role: DuelRole;
  phase: DuelPhase;
  version: number;
  state: DuelSnapshot | null;
  action: DuelAction | null;
  actionSeq: number;
  opponentName: string;
  opponentLeft: boolean;
  iLeft: boolean;
  /** 对方多久没轮询了（毫秒），超过 15 秒视为掉线。 */
  opponentIdleMs: number;
}

export interface DuelInviteView {
  gameId: string;
  hostName: string;
}

interface PollReq {
  clientId: string;
  room: string;
  gameId?: string;
  cmd?: "accept" | "decline" | "leave";
  version?: number;
  state?: DuelSnapshot;
  action?: DuelAction;
  ackAction?: number;
  since?: number;
}

interface PollRes {
  ok: boolean;
  session: DuelSessionView | null;
  expired?: boolean;
}

interface InviteReq {
  clientId: string;
  gameId: string;
  room: string;
  guestId: string;
  guestName: string;
  hostName: string;
}

export interface DuelTransport {
  invite(req: InviteReq): Promise<{ ok: boolean; gameId?: string; message?: string }>;
  poll(req: PollReq): Promise<PollRes>;
  leave(req: { clientId: string; gameId: string }): Promise<void>;
}

const IDLE_MS = 15_000;

/* ------------------------------------------------------------------ */
/* clientId：本地随机生成，未登录也能玩                                 */
/* ------------------------------------------------------------------ */

const CLIENT_ID_KEY = "5blong.duel.clientId";

/**
 * 本端身份。存 **sessionStorage（每个标签页独立）** 而不是 localStorage：
 * 同一台浏览器开两个标签页 = 两个客户端（本地测试就是这么做的），
 * 共享 localStorage 会让两边拿到同一个 id，访客会被识别成房主，
 * 邀请永远收不到。真实设备本来就各有一个浏览器，互不影响。
 */
export function duelClientId(): string {
  let id = "";
  try {
    id = sessionStorage.getItem(CLIENT_ID_KEY) ?? "";
  } catch {
    /* 隐私模式拿不到 sessionStorage：退化为会话内随机 */
  }
  if (!/^[0-9a-zA-Z_-]{8,64}$/.test(id)) {
    id = crypto.randomUUID().replace(/-/g, "");
    try {
      sessionStorage.setItem(CLIENT_ID_KEY, id);
    } catch {
      /* 同上 */
    }
  }
  return id;
}

/* ------------------------------------------------------------------ */
/* Remote：ECS 上的 /api/duel/*                                        */
/* ------------------------------------------------------------------ */

function isDesktopRuntime(): boolean {
  // 与账号层同一判据：桌面 WebView 里没有同源后端，直接打域名
  return typeof navigator !== "undefined" && /tauri/i.test(navigator.userAgent);
}

function apiBase(): string {
  const override = import.meta.env["VITE_DUEL_API"] as string | undefined;
  if (override) return override;
  if (isDesktopRuntime()) return "https://5blong.site/api/duel";
  return "/api/duel";
}

export class RemoteDuelTransport implements DuelTransport {
  async invite(req: InviteReq) {
    const res = await fetch(`${apiBase()}/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false as const, message: data?.message ?? "发邀请失败了" };
    return { ok: true as const, gameId: data.gameId as string };
  }

  async poll(req: PollReq): Promise<PollRes> {
    const res = await fetch(`${apiBase()}/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    // 非 200（服务端没部署/重启中/网络错误）必须抛错：
    // 吞掉的话 hook 会把它当成「没有对局」，把等待层无声关掉——
    // 2026-11-04 实测的"邀请几秒消失"就是这么来的。
    if (!res.ok) throw new Error(`duel api ${res.status}`);
    return (await res.json()) as PollRes;
  }

  async leave(req: { clientId: string; gameId: string }) {
    await fetch(`${apiBase()}/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      keepalive: true,
    }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Local：localStorage 当信箱（本地 dev 双标签页互测）                  */
/* ------------------------------------------------------------------ */

const LOCAL_KEY = "5blong.duel.sessions";
const CHANNEL = "5blong-duel";

interface LocalRow {
  id: string;
  room: string;
  hostId: string;
  hostName: string;
  guestId: string;
  guestName: string;
  phase: DuelPhase;
  version: number;
  state: DuelSnapshot | null;
  action: DuelAction | null;
  actionSeq: number;
  hostSeenAt: number;
  guestSeenAt: number;
  hostLeft: boolean;
  guestLeft: boolean;
  createdAt: number;
  updatedAt: number;
}

const INVITE_TTL = 3 * 60_000;
const SESSION_TTL = 30 * 60_000;
const OVER_GRACE = 60_000;
const STATE_MAX = 200_000;

const loadRows = (): Record<string, LocalRow> => {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}") as Record<string, LocalRow>;
  } catch {
    return {};
  }
};

const saveRows = (rows: Record<string, LocalRow>) => {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(rows));
  try {
    new BroadcastChannel(CHANNEL).postMessage("bump");
  } catch {
    /* BroadcastChannel 不可用就纯靠轮询 */
  }
};

const rowView = (row: LocalRow, clientId: string): DuelSessionView => {
  const isHost = row.hostId === clientId;
  return {
    gameId: row.id,
    room: row.room,
    role: isHost ? "host" : "guest",
    phase: row.phase,
    version: row.version,
    state: isHost ? null : row.state,
    action: isHost ? row.action : null,
    actionSeq: row.actionSeq,
    opponentName: isHost ? row.guestName : row.hostName,
    opponentLeft: isHost ? row.guestLeft : row.hostLeft,
    iLeft: isHost ? row.hostLeft : row.guestLeft,
    // seen 为 0 = 对方还没轮询过（刚发的邀请），不能算掉线
    opponentIdleMs:
      (isHost ? row.guestSeenAt : row.hostSeenAt) === 0
        ? 0
        : Math.max(0, Date.now() - (isHost ? row.guestSeenAt : row.hostSeenAt)),
  };
};

export class LocalDuelTransport implements DuelTransport {
  async invite(req: InviteReq) {
    const rows = loadRows();
    const now = Date.now();
    const alive = now - SESSION_TTL;
    // 先清尸体再判忙：不清的话测试标签页会被上一局卡住
    for (const id of Object.keys(rows)) {
      const row = rows[id];
      const dead =
        row.updatedAt < alive ||
        (row.phase === "invite" && now - row.updatedAt > INVITE_TTL) ||
        ((row.phase === "over" || row.phase === "cancelled") && now - row.updatedAt > OVER_GRACE);
      if (dead) delete rows[id];
    }
    const busy = Object.values(rows).some(
      (row) =>
        // 与 server 同口径：双方任一人已在局里，都不能开第二局
        [row.hostId, row.guestId].some((x) => x === req.clientId || x === req.guestId) &&
        (row.phase === "invite" || row.phase === "playing") &&
        row.updatedAt > alive,
    );
    if (busy) return { ok: false as const, message: "对方或你已经在另一局里了" };

    const row: LocalRow = {
      id: req.gameId,
      room: req.room,
      hostId: req.clientId,
      hostName: req.hostName,
      guestId: req.guestId,
      guestName: req.guestName,
      phase: "invite",
      version: 0,
      state: null,
      action: null,
      actionSeq: 0,
      hostSeenAt: now,
      guestSeenAt: 0,
      hostLeft: false,
      guestLeft: false,
      createdAt: now,
      updatedAt: now,
    };
    rows[row.id] = row;
    saveRows(rows);
    return { ok: true as const, gameId: row.id };
  }

  async poll(req: PollReq): Promise<PollRes> {
    const rows = loadRows();
    const now = Date.now();
    let row: LocalRow | undefined = req.gameId ? rows[req.gameId] : undefined;
    if (!row) {
      const alive = now - SESSION_TTL - OVER_GRACE;
      row = Object.values(rows)
        .filter(
          (r) =>
            (r.hostId === req.clientId || r.guestId === req.clientId) &&
            r.phase !== "cancelled" &&
            !(r.hostLeft && r.guestLeft) &&
            r.updatedAt > alive &&
            (!req.room || r.room === req.room),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    }
    if (!row) return { ok: true, session: null };

    // cancelled = 邀请被拒/过期/取消：没有要保留的最终画面，立刻收
    if (row.phase === "cancelled") return { ok: true, session: null };
    // over 保留一小段，让双方都能看到胜负画面
    if (row.phase === "over" && now - row.updatedAt > OVER_GRACE) {
      return { ok: true, session: null };
    }
    if (row.phase === "invite" && now - row.updatedAt > INVITE_TTL) {
      row.phase = "cancelled";
      row.updatedAt = now;
      saveRows(rows);
      return { ok: true, session: null, expired: true };
    }

    const isHost = row.hostId === req.clientId;

    if (req.cmd === "accept" && !isHost && row.phase === "invite") row.phase = "playing";
    if (req.cmd === "decline" && !isHost) row.phase = "cancelled";
    if (req.cmd === "leave") {
      if (isHost) row.hostLeft = true;
      else row.guestLeft = true;
      if (row.phase === "invite") row.phase = "cancelled";
      else if (row.hostLeft && row.guestLeft) row.phase = "over";
    }
    if (isHost && row.phase !== "cancelled" && req.state) {
      const version = Number(req.version);
      if (Number.isFinite(version) && version > row.version) {
        if (JSON.stringify(req.state).length <= STATE_MAX) {
          row.state = req.state;
          row.version = version;
          if (row.phase === "invite") row.phase = "playing";
          if (req.state.over === true) row.phase = "over";
        }
      }
    }
    if (!isHost && row.phase === "playing" && req.action) {
      row.action = req.action;
      row.actionSeq += 1;
    }
    if (isHost && req.ackAction !== undefined && req.ackAction >= row.actionSeq) {
      row.action = null;
    }
    if (isHost) row.hostSeenAt = now;
    else row.guestSeenAt = now;
    row.updatedAt = now;
    saveRows(rows);
    return { ok: true, session: rowView(row, req.clientId) };
  }

  async leave(req: { clientId: string; gameId: string }) {
    const rows = loadRows();
    const row = rows[req.gameId];
    if (!row) return;
    if (row.hostId !== req.clientId && row.guestId !== req.clientId) return;
    const isHost = row.hostId === req.clientId;
    if (isHost) row.hostLeft = true;
    else row.guestLeft = true;
    if (row.phase === "invite") row.phase = "cancelled";
    else if (row.hostLeft && row.guestLeft) row.phase = "over";
    row.updatedAt = Date.now();
    saveRows(rows);
  }
}

/** 按环境选 Transport：PROD 走 ECS；DEV 走本机（两个标签页=两台设备）。 */
export function pickDuelTransport(): DuelTransport {
  const params = new URLSearchParams(location.search);
  if (params.has("remote-duel")) return new RemoteDuelTransport();
  if (params.has("local-duel") || import.meta.env.DEV) return new LocalDuelTransport();
  return new RemoteDuelTransport();
}

/* ------------------------------------------------------------------ */
/* useDuel：轮询循环 + 状态机 + bridge                                  */
/* ------------------------------------------------------------------ */

export interface DuelBridge {
  /** 当前局视图（null = 没有局）。App 据此渲染覆盖层。 */
  session: DuelSessionView | null;
  /** 收到的邀请（别人邀请我）。 */
  invite: DuelInviteView | null;
  /** 一次性提示（对方接受/拒绝/退出/掉线/邀请过期），展示后自动清。 */
  notice: string | null;
  /** 发邀请；失败时 notice 带原因。 */
  inviteTo(member: DuelMember): Promise<void>;
  accept(): void;
  decline(): void;
  /** 退出对局（人还在房间也会通知对方）。 */
  leave(): void;
  /**
   * host 用：引擎每次变化调它登记最新快照，下一轮 poll 带上去。
   * 内部维护 version（服务端校验单调递增）。
   */
  registerState(snap: DuelSnapshot): void;
  /**
   * host 用：注册「收到访客动作」的处理器（DuelOverlay 挂引擎执行）。
   * 放 ref 里，轮询循环不受重渲染影响。
   */
  setActionHandler(fn: (a: DuelAction, seq: number) => void): void;
  /**
   * guest 用：把动作发回房主。内部立即加速一轮轮询，
   * 最坏延迟从 1.2s×2 压到 ~1.2s。
   */
  pushAction(a: DuelAction): void;
}

export function useDuel(room: string, myName: string): DuelBridge {
  const transport = useMemo(pickDuelTransport, []);
  const clientId = useMemo(duelClientId, []);

  const [session, setSession] = useState<DuelSessionView | null>(null);
  const [invite, setInvite] = useState<DuelInviteView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 轮询循环要读的可变值：全放 ref，interval 只建一次
  const sessionRef = useRef<DuelSessionView | null>(null);
  const pendingRef = useRef<{ snap: DuelSnapshot; version: number } | null>(null);
  const pendingActionRef = useRef<DuelAction | null>(null);
  const ackRef = useRef(0);
  const actionHandlerRef = useRef<((a: DuelAction, seq: number) => void) | null>(null);
  const tickRef = useRef<() => void>(() => {});
  const inflightRef = useRef(false);
  const failStreakRef = useRef(0);
  const nameRef = useRef(myName);
  nameRef.current = myName;
  const roomRef = useRef(room);
  roomRef.current = room;

  /** session 的 state 与 ref 必须一起动：轮询循环只读 ref。 */
  const applySession = useCallback((next: DuelSessionView | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  useEffect(() => {
    if (!room) return;
    let alive = true;
    let timer = 0;

    const tick = async () => {
      if (inflightRef.current) return; // 加速轮撞上正常轮：跳过，下轮补
      inflightRef.current = true;
      try {
        await runOnce();
      } finally {
        inflightRef.current = false;
      }
    };

    const runOnce = async () => {
      const cur = sessionRef.current;
      const req: PollReq = { clientId, room: roomRef.current };
      const inDuel = !!cur && cur.phase !== "cancelled";
      if (cur && inDuel) {
        req.gameId = cur.gameId;
        req.since = cur.version;
        if (cur.role === "host") {
          if (pendingRef.current) {
            req.state = pendingRef.current.snap;
            req.version = pendingRef.current.version;
          }
          if (ackRef.current > 0) req.ackAction = ackRef.current;
        } else if (pendingActionRef.current) {
          req.action = pendingActionRef.current;
        }
      }

      let res: PollRes;
      try {
        res = await transport.poll(req);
        if (failStreakRef.current >= 3) {
          setNotice("对局服务恢复连接");
        }
        failStreakRef.current = 0;
      } catch {
        failStreakRef.current += 1;
        // 连续失败 3 次（约 4~8 秒）才提示一次：单次抖动不打扰
        if (failStreakRef.current === 3) {
          setNotice("对局服务暂时不可用，自动重试中…");
        }
        if (alive) timer = window.setTimeout(tick, 2400); // 退避再试，会话保留
        return;
      }
      if (!alive) return;

      pendingActionRef.current = null; // 发过了（丢包靠下一动作覆盖，回合制可接受）
      const next = res.session ?? null;
      const prev = sessionRef.current;

      if (next && next.role === "host" && req.state && next.version >= (req.version ?? 0)) {
        pendingRef.current = null; // 快照已被服务端收下
      }
      if (next && next.role === "host" && next.action && actionHandlerRef.current) {
        actionHandlerRef.current(next.action, next.actionSeq);
        ackRef.current = next.actionSeq;
      }

      if (next && next.phase === "invite" && next.role === "guest" && !prev) {
        // 别人邀请我（只有当前没在局里才弹）
        setInvite({ gameId: next.gameId, hostName: next.opponentName });
        applySession(next);
      } else if (next) {
        if (prev && prev.phase === "invite" && next.phase === "playing" && next.role === "host") {
          setNotice(`${next.opponentName} 接受了邀请`);
        }
        if (next.opponentLeft && !prev?.opponentLeft) {
          setNotice(`${next.opponentName} 退出了对局`);
        }
        if (next.opponentIdleMs > IDLE_MS && (prev?.opponentIdleMs ?? 0) <= IDLE_MS) {
          setNotice(`${next.opponentName} 好像掉线了`);
        }
        applySession(next);
        setInvite(null);
      } else {
        if (res.expired && prev?.role === "host" && prev.phase === "invite") {
          setNotice("对方没有响应，邀请已过期");
        }
        applySession(null);
        setInvite(null);
        pendingRef.current = null;
      }

      timer = window.setTimeout(tick, next && next.phase === "playing" ? 1200 : 2500);
    };

    tickRef.current = () => void tick();
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [room, clientId, transport, applySession]);

  // 展示中的 notice 4 秒后自动清
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // 卸载时还在局里 → 告知对方我退了（关页面 / 切房间）
  useEffect(() => {
    return () => {
      const cur = sessionRef.current;
      if (cur && cur.phase === "playing") {
        void transport.leave({ clientId, gameId: cur.gameId });
      }
    };
  }, [clientId, transport]);

  const bridge = useMemo<DuelBridge>(() => {
    const inviteTo = async (member: DuelMember) => {
      const gameId = crypto.randomUUID().replace(/-/g, "");
      const res = await transport
        .invite({
          clientId,
          gameId,
          room: roomRef.current,
          guestId: member.id,
          guestName: member.name,
          hostName: nameRef.current,
        })
        .catch(() => ({ ok: false as const, message: "网络不给力，稍后再试" }));
      if (!res.ok) {
        setNotice(res.message ?? "发邀请失败了");
        return;
      }
      applySession({
        gameId: res.gameId ?? gameId,
        room: roomRef.current,
        role: "host",
        phase: "invite",
        version: 0,
        state: null,
        action: null,
        actionSeq: 0,
        opponentName: member.name,
        opponentLeft: false,
        iLeft: false,
        opponentIdleMs: 0,
      });
    };

    return {
      session,
      invite,
      notice,
      inviteTo,
      accept() {
        const cur = sessionRef.current;
        if (cur) applySession({ ...cur, phase: "playing" }); // 下轮 poll 拿权威状态
      },
      decline() {
        const cur = sessionRef.current;
        if (cur) {
          void transport.poll({ clientId, room: roomRef.current, gameId: cur.gameId, cmd: "decline" });
        }
        applySession(null);
        setInvite(null);
      },
      leave() {
        const cur = sessionRef.current;
        if (!cur) return;
        void transport.leave({ clientId, gameId: cur.gameId });
        applySession(null);
        setInvite(null);
        pendingRef.current = null;
        tickRef.current(); // 立刻确认一轮，别等下个周期
      },
      registerState(snap) {
        const base = sessionRef.current?.version ?? 0;
        pendingRef.current = { snap, version: Math.max(base + 1, (pendingRef.current?.version ?? 0) + 1) };
      },
      setActionHandler(fn) {
        actionHandlerRef.current = fn;
      },
      pushAction(a) {
        pendingActionRef.current = a;
        tickRef.current(); // 加速一轮，出牌手感优先
      },
    };
  }, [session, invite, notice, clientId, transport, applySession]);

  return bridge;
}
