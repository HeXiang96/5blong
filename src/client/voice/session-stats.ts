/**
 * 房间会话统计（今晚小结）+ 上次房间记忆 —— 纯逻辑，可单测。
 *
 * 设计：每个客户端**各自**在本地采样（每 10 秒一次），不需要房主转发、
 * 不需要新增任何消息类型。说话时长来自引擎的 `this.speaking` 集合
 * （房主能看到所有人的 VAD——访客经房主转报；访客本地同样能收到全套），
 * 所以房主和访客各自算出来的"话痨王"是一致的。
 * 隐私：只统计时长与人数，**不涉及任何内容**；结果只显示在本机。
 */

export interface SessionMemberSample {
  id: string;
  name: string;
  /** 是否本机自己（小结里"你"的口径）。 */
  local?: boolean;
}

export interface SessionSummary {
  /** 会话开始时间（毫秒时间戳）。 */
  startedAt: number;
  /** 结束时间。 */
  endedAt: number;
  /** 说话秒数排行（含自己），按降序。 */
  speakers: { id: string; name: string; seconds: number }[];
  /** 峰值同时在线人数（含房主）。 */
  peakMembers: number;
  /** 进出总人次（新出现的成员记 1 人次）。 */
  totalJoins: number;
}

/** 采样间隔：2 秒。太粗会漏掉短会话（2026-10-16 业主反馈：说两句就退，小结全是 0 秒）；
 *  2 秒粒度对"趣味小结"足够准，开销可忽略（每 2 秒遍历一次 ≤8 人名册）。 */
export const STATS_SAMPLE_SEC = 2;

export class SessionStatsRecorder {
  private startedAt = 0;
  private finished = false;
  private summary: SessionSummary | null = null;
  /** 成员 id → 累计说话秒数（每次采样 +STATS_SAMPLE_SEC）。 */
  private speakingSec = new Map<string, number>();
  /** 成员 id → 最新昵称。 */
  private names = new Map<string, string>();
  /** 见过的成员 id（计人次）。 */
  private seen = new Set<string>();
  private peak = 0;

  begin(now = Date.now()): void {
    this.startedAt = now;
  }

  /**
   * 喂一次采样：当前名册 + 当前正在说话的成员 id 集合。
   * 重复调用安全；finish() 之后再调用会被忽略。
   */
  observe(members: SessionMemberSample[], speakingIds: ReadonlySet<string>): void {
    if (this.finished || this.startedAt === 0) return;
    for (const member of members) {
      this.names.set(member.id, member.name);
      if (!this.seen.has(member.id)) {
        this.seen.add(member.id);
        this.speakingSec.set(member.id, 0);
      }
      if (speakingIds.has(member.id)) {
        this.speakingSec.set(member.id, (this.speakingSec.get(member.id) ?? 0) + STATS_SAMPLE_SEC);
      }
    }
    this.peak = Math.max(this.peak, members.length);
  }

  /** 收口并生成小结（幂等：多次调用返回同一份结果）。 */
  finish(now = Date.now()): SessionSummary | null {
    if (this.startedAt === 0) return null;
    if (!this.summary) {
      this.finished = true;
      const speakers = [...this.speakingSec.entries()]
        .map(([id, seconds]) => ({ id, name: this.names.get(id) ?? "成员", seconds }))
        .sort((a, b) => b.seconds - a.seconds);
      this.summary = {
        startedAt: this.startedAt,
        endedAt: now,
        speakers,
        peakMembers: this.peak,
        totalJoins: this.seen.size,
      };
    }
    return this.summary;
  }

  get isStarted(): boolean {
    return this.startedAt !== 0;
  }
}

// ---------------------------------------------------------------- 上次房间

const LAST_ROOM_KEY = "5blong:v1:lastRoom";

export interface LastRoom {
  code: string;
  savedAt: number;
  /**
   * 记录来源：
   * - guest：加入别人的房，重进=再 join 一次；
   * - host：自己开的房，重进=用同一房号与钥匙重新建房
   *   （房号推导出的房主 peer id 在断开后是空的，可以重新占回来）。
   */
  role: "guest" | "host";
  /** 房主恢复时复用同一把钥匙，旧邀请链接才不会失效。 */
  roomKey?: string;
}

/** 超过这个时间的记录不再展示：房间早就凉了，留着只会让人白点一次。 */
const LAST_ROOM_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function saveLastRoom(code: string, role: "guest" | "host", roomKey?: string): void {
  const normalized = code.trim();
  if (!/^[0-9]{4}$/.test(normalized)) return;
  try {
    const record: LastRoom = { code: normalized, savedAt: Date.now(), role };
    if (role === "host" && roomKey) record.roomKey = roomKey;
    localStorage.setItem(LAST_ROOM_KEY, JSON.stringify(record));
  } catch {
    /* 隐私模式等存不进去就算了 */
  }
}

export function loadLastRoom(): LastRoom | null {
  try {
    const raw = localStorage.getItem(LAST_ROOM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastRoom>;
    if (parsed?.role !== "guest" && parsed?.role !== "host") return null;
    const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
    // 太旧的记录没有意义（房间里早没人了）
    if (!savedAt || Date.now() - savedAt > LAST_ROOM_MAX_AGE_MS) return null;
    if (typeof parsed.code === "string" && /^[0-9]{4}$/.test(parsed.code)) {
      const record: LastRoom = { code: parsed.code, savedAt, role: parsed.role };
      if (parsed.role === "host" && typeof parsed.roomKey === "string") record.roomKey = parsed.roomKey;
      return record;
    }
  } catch {
    /* 坏数据当没有 */
  }
  return null;
}
