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

const TUTORIAL_KEY = "5blong:v1:gameTutorialSeen";
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
    response = await fetch("/game/entitle", {
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
  const data = (await response.json()) as { token?: string; expiresAt?: number };
  if (!data.token || !data.expiresAt) throw new Error("校验失败，请稍后重试");
  const value = { token: data.token, expiresAt: data.expiresAt };
  saveEntitlement(value);
  return value;
}

/** 建房前校验本机令牌：码被吊销/次数用尽 → 清掉本地权限并返回 false。 */
export async function verifyEntitlement(): Promise<boolean> {
  const value = loadEntitlement();
  if (!value) return false;
  if (value.token.startsWith("trial:")) return true;
  try {
    const response = await fetch("/game/verify", {
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
        },
        kicked: () => {
          setKicked(true);
          setRoom(null);
          setMembers([]);
        },
      });
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
      await mesh.join({ ...opts, gameId });
    },
    [ensureMesh],
  );

  const leaveRoom = useCallback(() => {
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

  /** 关房（房主）/ 退房（访客）。 */
  const closeRoom = useCallback(() => {
    leaveRoom();
  }, [leaveRoom]);

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
  };
}
