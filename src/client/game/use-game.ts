/**
 * 开黑圈的状态层（独立于 use-voice）。
 *
 * 职责：建房 / 加入 / 队伍认领 / 记分 / 创建权限门禁 / 教程一次性标记。
 * 引擎只负责连接与音频拓扑，这里负责把它们变成 React 状态。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { GameMesh, type GameStatus } from "./game-mesh";
import {
  GAME_ENABLED_LIMIT,
  normalizeGameId,
  type GameMember,
  type GameRoomInfo,
  type GameScores,
  type Team,
} from "./game-types";
import { readJson, writeJson } from "../voice/storage";

/*
 * 接口基址：桌面端前端由本地协议（tauri.localhost）提供，**没有同域服务端**，
 * 相对路径会打到本地资产上（返回 HTML → "Unexpected token '<'"）。
 * 与语音房的 /ice 同款口径：桌面端走公网主域名，网页端保持相对路径。
 */
const API_BASE = (() => {
  if (import.meta.env.DEV) return "";
  const host = typeof location !== "undefined" ? location.hostname : "";
  if (host === "tauri.localhost" || host.endsWith(".tauri.localhost")) {
    return "https://5blong.pages.dev";
  }
  return "";
})();

const TUTORIAL_KEY = "5blong:v1:gameTutorialSeen";
const MIC_BOOST_KEY = "5blong:v1:gameMicBoost";
const NS_KEY = "5blong:v1:gameNs";
const PEER_VOL_KEY = "5blong:v1:gamePeerVolumes";
const MIC_DEV_KEY = "5blong:v1:gameMicDevice";
const OUT_DEV_KEY = "5blong:v1:gameOutputDevice";
const ENTITLE_KEY = "5blong:v1:gameEntitle";

export interface GameEntitlement {
  token: string;
  expiresAt: number;
}

export function loadEntitlement(): GameEntitlement | null {
  const stored = readJson<Partial<GameEntitlement>>(ENTITLE_KEY, {});
  if (typeof stored.token === "string" && stored.token && typeof stored.expiresAt === "number") {
    if (stored.expiresAt > Date.now()) return { token: stored.token, expiresAt: stored.expiresAt };
  }
  return null;
}

export function saveEntitlement(value: GameEntitlement): void {
  writeJson(ENTITLE_KEY, value);
}

/** 向 Worker 校验创建码，换回一枚 30 天有效的令牌。 */
export async function activateEntitlement(code: string): Promise<GameEntitlement> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/game/entitle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    });
  } catch {
    throw new Error("网络异常，请稍后重试");
  }
  /*
   * 预览分支没有部署 Worker 函数（404）或服务未配置 Secret（501）时给"试用令牌"，
   * 让预览站也能完整验收开黑圈。正式站部署后会走真实校验（403 拦截）。
   */
  if (!response.ok) {
    if (response.status === 404 || response.status === 501) {
      throw new Error("权限服务未就绪，请稍后再试");
    }
    throw new Error(response.status === 403 ? "创建码无效或已过期" : "校验失败，请稍后重试");
  }
  let data: { token?: string; expiresAt?: number } = {};
  try {
    data = (await response.json()) as { token?: string; expiresAt?: number };
  } catch {
    throw new Error("激活服务返回异常，请稍后重试（若在客户端，请更新到最新版本）");
  }
  if (!data.token || !data.expiresAt) throw new Error("校验失败，请稍后重试");
  const value = { token: data.token, expiresAt: data.expiresAt };
  saveEntitlement(value);
  return value;
}

/** 建房前校验本机令牌：码被吊销/次数用尽 → 清掉本地权限并返回 false。 */
export async function verifyEntitlement(): Promise<boolean> {
  const value = loadEntitlement();
  if (!value) return false;
  // 历史遗留的 trial 令牌（早期预览兜底发的）一律作废——它绕过全部校验，
  // 业主吊销后仍能建房就是它（2026-10-17 实测暴露）。
  if (value.token.startsWith("trial:")) {
    writeJson(ENTITLE_KEY, null);
    return false;
  }
  try {
    const response = await fetch(`${API_BASE}/game/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: value.token }),
    });
    if (response.ok) return true;
    writeJson(ENTITLE_KEY, null);
    return false;
  } catch {
    // 网络异常时宁可放行（避免网络抖动把正常房主挡在门外）
    return true;
  }
}

/** 麦克风增强（1~4），本机记忆。 */
export function loadMicBoost(): number {
  const raw = readJson<number>(MIC_BOOST_KEY, 1);
  return typeof raw === "number" && raw >= 1 && raw <= 4 ? raw : 1;
}

export function saveMicBoost(value: number): void {
  writeJson(MIC_BOOST_KEY, value);
}

export function loadNs(): boolean {
  return readJson<boolean>(NS_KEY, true) !== false;
}

export function saveNs(on: boolean): void {
  writeJson(NS_KEY, on);
}

export function loadPeerVolumes(): Record<string, number> {
  const raw = readJson<Record<string, number>>(PEER_VOL_KEY, {});
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === "number" && value >= 0 && value <= 2) out[key] = value;
  }
  return out;
}

export function savePeerVolumes(map: Record<string, number>): void {
  writeJson(PEER_VOL_KEY, map);
}

export function loadMicDevice(): string {
  return readJson<string>(MIC_DEV_KEY, "") ?? "";
}

export function saveMicDevice(id: string): void {
  writeJson(MIC_DEV_KEY, id);
}

export function loadOutputDevice(): string {
  return readJson<string>(OUT_DEV_KEY, "") ?? "";
}

export function saveOutputDevice(id: string): void {
  writeJson(OUT_DEV_KEY, id);
}

export interface GameSummary {
  code: string;
  title: string;
  map: string;
  scores: GameScores;
  durationMs: number;
  rows: { gameId: string; team: Team; presentMs: number; speakMs: number }[];
}

export function tutorialSeen(): boolean {
  return readJson<boolean>(TUTORIAL_KEY, false) === true;
}

export function markTutorialSeen(): void {
  writeJson(TUTORIAL_KEY, true);
}

export function useGame() {
  const meshRef = useRef<GameMesh | null>(null);
  const [status, setStatus] = useState<GameStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<GameMember[]>([]);
  const [scores, setScores] = useState<GameScores>({ attack: 0, defend: 0 });
  const [unlocked, setUnlocked] = useState(false);
  const [room, setRoom] = useState<GameRoomInfo | null>(null);
  const [muted, setMutedState] = useState(false);
  const [kicked, setKicked] = useState(false);
  const [summary, setSummary] = useState<GameSummary | null>(null);
  const [speaking, setSpeaking] = useState<Set<string>>(() => new Set());
  const [devices, setDevices] = useState<{ inputs: { id: string; label: string }[]; outputs: { id: string; label: string }[] }>({
    inputs: [],
    outputs: [],
  });
  const [micDevice, setMicDeviceState] = useState(() => loadMicDevice());
  const [outputDevice, setOutputDeviceState] = useState(() => loadOutputDevice());

  const ensureMesh = useCallback(() => {
    if (!meshRef.current) {
      meshRef.current = new GameMesh({
        status: (next, detail) => {
          setStatus(next);
          if (next === "error" && detail) setError(detail);
        },
        roster: (nextMembers, nextScores, nextUnlocked) => {
          setMembers(nextMembers);
          setScores(nextScores);
          setUnlocked(nextUnlocked);
          const me = nextMembers.find((member) => member.local);
          if (me) setMutedState(me.muted);
        },
        ready: (info) => setRoom(info),
        ended: (reason) => {
          setStatus("error");
          setError(reason);
          setRoom(null);
          setMembers([]);
          /*
           * 必须真的销毁实例。只清界面的话：麦克风一直开着（标签页红点常亮）、
           * PeerJS 连接与定时器都还活着，而且下次进房 ensureMesh 会**复用**
           * 这个脏实例（旧 calls 占位、旧 AudioContext 已关），出现"有几个人
           * 怎么都连不上"。房主关房 / 房主掉线都会走到这里。
           */
          meshRef.current?.destroy();
          meshRef.current = null;
        },
        kicked: () => {
          setKicked(true);
          setRoom(null);
          setMembers([]);
          meshRef.current?.destroy();
          meshRef.current = null;
        },
        speaking: (ids) => setSpeaking(new Set(ids)),
      });
    }
    if (typeof window !== "undefined" && window.location.hostname !== "5blong.pages.dev") {
      (window as unknown as { __gameMesh?: GameMesh }).__gameMesh = meshRef.current;
    }
    return meshRef.current;
  }, []);

  const me = members.find((member) => member.local) ?? null;
  const isHost = me?.isHost ?? false;
  const myTeam: Team = me?.team ?? "unassigned";
  const myGroupCount = members.filter((member) => member.team === myTeam).length;

  const createRoom = useCallback(
    async (opts: { gameId: string; title: string; map: string; muted: boolean }) => {
      setError(null);
      setKicked(false);
      const gameId = normalizeGameId(opts.gameId);
      if (!gameId) {
        setError("请填写你的游戏 ID");
        return;
      }
      if (!(await verifyEntitlement())) {
        setError("你的创建码已被吊销或次数用尽，请重新激活");
        return;
      }
      const mesh = ensureMesh();
      mesh.setPeerVolumes(loadPeerVolumes());
      await mesh.setMicBoost(loadMicBoost());
      await mesh.setNoiseSuppression(loadNs());
      await mesh.host({ ...opts, gameId });
    },
    [ensureMesh],
  );

  const joinRoom = useCallback(
    async (opts: { code: string; gameId: string; muted: boolean }) => {
      setError(null);
      setKicked(false);
      const gameId = normalizeGameId(opts.gameId);
      if (!gameId) {
        setError("请填写你的游戏 ID");
        return;
      }
      const mesh = ensureMesh();
      mesh.setPeerVolumes(loadPeerVolumes());
      await mesh.setMicBoost(loadMicBoost());
      await mesh.setNoiseSuppression(loadNs());
      await mesh.join({ ...opts, gameId });
    },
    [ensureMesh],
  );

  const leaveRoom = useCallback(() => {
    // 先取小结（destroy 之后就没了），再退出
    try {
      const data = meshRef.current?.getSummary();
      if (data && data.rows.length > 0) setSummary(data);
    } catch {
      /* 统计失败不影响退出 */
    }
    meshRef.current?.leave();
    meshRef.current = null;
    setRoom(null);
    setMembers([]);
    setStatus("idle");
    setError(null);
  }, []);

  const setMyTeam = useCallback((team: Team) => {
    meshRef.current?.setMyTeam(team);
  }, []);

  const hostAssign = useCallback((peerId: string, team: Team) => {
    meshRef.current?.hostAssign(peerId, team);
  }, []);

  const toggleMuted = useCallback(() => {
    const next = !muted;
    setMutedState(next);
    meshRef.current?.setMuted(next);
  }, [muted]);

  const score = useCallback((side: "attack" | "defend", delta: number) => {
    meshRef.current?.score(side, delta);
  }, []);

  const resetScores = useCallback(() => {
    meshRef.current?.resetScores();
  }, []);

  const kick = useCallback((peerId: string) => {
    meshRef.current?.kick(peerId);
  }, []);

  const toggleTeamCap = useCallback(() => {
    meshRef.current?.setTeamCapUnlocked(!unlocked);
  }, [unlocked]);

  /** 麦克风增强（1~4），本机记忆，进房后随时可调。 */
  const [micBoost, setMicBoostState] = useState(() => loadMicBoost());
  const setMicBoost = useCallback((value: number) => {
    const clamped = Math.min(4, Math.max(1, value));
    setMicBoostState(clamped);
    saveMicBoost(clamped);
    void meshRef.current?.setMicBoost(clamped);
  }, []);

  /** AI 强降噪开关（本机记忆）。 */
  const [nsOn, setNsOnState] = useState(() => loadNs());
  const toggleNs = useCallback(() => {
    const next = !nsOn;
    setNsOnState(next);
    saveNs(next);
    void meshRef.current?.setNoiseSuppression(next);
  }, [nsOn]);

  /** 对某游戏 ID 的接收音量（0~2），本机记忆。 */
  const [peerVolumes, setPeerVolumesState] = useState<Record<string, number>>(() => loadPeerVolumes());
  const setPeerVolume = useCallback((gameId: string, volume: number) => {
    const clamped = Math.min(2, Math.max(0, volume));
    setPeerVolumesState((current) => {
      const next = { ...current, [gameId]: clamped };
      savePeerVolumes(next);
      return next;
    });
    meshRef.current?.setPeerVolume(gameId, clamped);
  }, []);

  /** 关房（房主）/ 退房（访客）。 */
  const closeRoom = useCallback(() => {
    leaveRoom();
  }, [leaveRoom]);

  /** 枚举音频设备（进房后调用；此时已有麦克风权限，标签可读）。 */
  const refreshDevices = useCallback(async () => {
    const mesh = meshRef.current;
    if (!mesh) return;
    try {
      const list = await mesh.listAudioDevices();
      setDevices(list);
    } catch {
      /* 设备枚举失败就不显示下拉 */
    }
  }, []);

  const setMicDevice = useCallback((id: string) => {
    /*
     * 只有真开起来了才落盘 + 更新 UI：mesh.setMicDevice 会先试开这个设备，
     * 打不开就抛错。把坏设备写进 localStorage 会导致"以后每次进房都失败、
     * 又没有任何入口改回来"（设备下拉只在房内可见）。
     */
    const pending = meshRef.current?.setMicDevice(id);
    if (!pending) {
      setMicDeviceState(id);
      saveMicDevice(id);
      return;
    }
    void pending
      .then(() => {
        setMicDeviceState(id);
        saveMicDevice(id);
      })
      .catch(() => undefined);
  }, []);

  const setOutputDevice = useCallback((id: string) => {
    setOutputDeviceState(id);
    saveOutputDevice(id);
    void meshRef.current?.setOutputDevice(id);
  }, []);

  useEffect(() => () => meshRef.current?.destroy(), []);

  return {
    status,
    error,
    clearError: () => setError(null),
    members,
    scores,
    unlocked,
    room,
    muted,
    kicked,
    /** 关掉"已被移出开黑圈"的提示（提示卡上的"知道了"）。 */
    dismissKicked: () => setKicked(false),
    me,
    isHost,
    myTeam,
    myGroupCount,
    limit: GAME_ENABLED_LIMIT,
    createRoom,
    joinRoom,
    leaveRoom,
    closeRoom,
    setMyTeam,
    hostAssign,
    toggleMuted,
    score,
    resetScores,
    kick,
    toggleTeamCap,
    micBoost,
    setMicBoost,
    nsOn,
    toggleNs,
    peerVolumes,
    setPeerVolume,
    speaking,
    summary,
    clearSummary: () => setSummary(null),
    devices,
    refreshDevices,
    micDevice,
    setMicDevice,
    outputDevice,
    setOutputDevice,
  };
}
