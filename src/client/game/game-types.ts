/**
 * 开黑圈的类型与协议（独立子系统，**不改动**语音房的协议与引擎）。
 *
 * 设计要点：
 * - 队伍只有两种：进攻方 / 防守方；null = 待分队（观众 / 裁判 / 还没进游戏）。
 * - 语音路由只在"听的端"生效：同一个 group 的人才互相建立音频连接，
 *   队伍永远听不到对方队伍和待分队的人——所以"未分队开麦不会串到队伍"是
 *   连接拓扑的天然结果，而不是靠增益调节。
 * - 容量：代码支持 20 人，当前启用 15（先观察一轮再加）。
 * - 不做屏幕共享（开黑圈不需要，且抢带宽）。
 */

export const GAME_MAX_MEMBERS = 20;
export const GAME_ENABLED_LIMIT = 15;
export const GAME_TEAM_SIZE = 5;
/** 游戏 ID 长度上限（含中文的常见 ID 都放得下）。 */
export const GAME_ID_MAX = 16;

export type Team = "attack" | "defend" | "unassigned";

export const TEAM_LABEL: Record<Team, string> = {
  attack: "进攻方",
  defend: "防守方",
  unassigned: "待分队",
};

export interface GameMember {
  id: string;
  gameId: string;
  team: Team;
  muted: boolean;
  hasMic: boolean;
  isHost: boolean;
  local: boolean;
}

export interface GameScores {
  attack: number;
  defend: number;
}

export interface GameRoomInfo {
  code: string;
  hostId: string;
  roomKey: string;
  title: string;
  map: string;
}

/** 访客 → 房主。 */
export type GuestToHost =
  | { t: "gjoin"; gameId: string; muted: boolean; hasMic: boolean }
  | { t: "gteam"; team: Team }
  | { t: "gmute"; muted: boolean }
  | { t: "gbye" };

/** 房主 → 访客。 */
export type HostToGuest =
  | { t: "gwelcome"; code: string; hostId: string; members: GameMember[]; scores: GameScores; you: string; title?: string; map?: string }
  | { t: "groster"; members: GameMember[]; scores: GameScores }
  | { t: "gkick" };

/** 游戏 ID 合法性：1–16 字符，去掉首尾空白，不允许换行。 */
export function normalizeGameId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.replace(/[\r\n\t]/g, " ").trim().slice(0, GAME_ID_MAX);
  return value;
}

export function isTeam(value: unknown): value is Team {
  return value === "attack" || value === "defend" || value === "unassigned";
}

/** 房主队伍上限（默认每队 5，可被房主临时解锁为 6v4 这类真实情况）。 */
export function teamCap(unlocked: boolean): number {
  return unlocked ? GAME_TEAM_SIZE + 3 : GAME_TEAM_SIZE;
}

export function countTeam(members: GameMember[], team: Team): number {
  return members.filter((member) => member.team === team).length;
}
