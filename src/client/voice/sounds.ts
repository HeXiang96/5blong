/**
 * 房间提示音：成员进出、麦克风开/关。
 *
 * 两个关键设计：
 *
 * 1. **由房主统一广播**，而不是各端本地判断。
 *    否则每个人各自的时序不同（有人早有人晚），听起来会乱七八糟；
 *    而且"别人静音了"这件事只有房主知道权威结果。
 *
 * 2. **纯合成**，不引入任何音频文件。
 *    整个站点产物只有 0.9MB，为了几声提示音塞 mp3 不划算；
 *    用振荡器 + 增益包络合成的短音反而更干净、可精确控制。
 *
 * 这个文件是纯逻辑（不碰 AudioContext），所以可以直接单测。
 */

export type SoundKind = "join" | "leave" | "mute" | "unmute";

export interface SoundEvent {
  kind: SoundKind;
  /** 触发人（用于将来做"谁进来了"的差异化音色）。 */
  actor: string;
  id: string;
  ts: number;
}

/** 一个音符：频率、起始时间（相对事件）、时长、音量。 */
export interface Note {
  freq: number;
  start: number;
  duration: number;
  gain: number;
  /** 波形；默认正弦。 */
  type?: OscillatorType;
}

/**
 * 每种提示音的音符序列。
 *
 * 音高设计：**上行 = 有人进来 / 打开麦克风，下行 = 有人离开 / 关掉麦克风**，
 * 这样不用看屏幕也能从方向听出来发生了什么。
 */
export const SOUND_NOTES: Record<SoundKind, Note[]> = {
  // 上行两声：明亮、短促，像门铃
  join: [
    { freq: 587.33, start: 0, duration: 0.14, gain: 0.5, type: "sine" },
    { freq: 880.0, start: 0.11, duration: 0.22, gain: 0.42, type: "sine" },
  ],
  // 下行两声：比 join 低、稍长，像门关上
  leave: [
    { freq: 880.0, start: 0, duration: 0.13, gain: 0.42, type: "sine" },
    { freq: 587.33, start: 0.1, duration: 0.24, gain: 0.46, type: "sine" },
  ],
  // 关麦：单声、偏闷，用三角波
  mute: [{ freq: 392.0, start: 0, duration: 0.12, gain: 0.36, type: "triangle" }],
  // 开麦：单声、偏高一点，和关麦成对
  unmute: [{ freq: 659.25, start: 0, duration: 0.12, gain: 0.36, type: "triangle" }],
};

/** 整段提示音的总时长（用于将来做节流/去重）。 */
export function soundDuration(kind: SoundKind): number {
  return SOUND_NOTES[kind].reduce((max, note) => Math.max(max, note.start + note.duration), 0);
}

/** 同一类提示音两次之间至少隔这么久，避免连点设置时叮叮当当。 */
export const SOUND_THROTTLE_MS: Record<SoundKind, number> = {
  join: 300,
  leave: 300,
  mute: 180,
  unmute: 180,
};

/**
 * 该不该播这个提示音。
 *
 * 抽成纯函数是为了能测：连点静音按钮不应该发出连串的提示音，
 * 但"关麦 → 开麦"这种真实状态变化必须每次都响。
 */
export function shouldPlaySound(
  kind: SoundKind,
  lastPlayedAt: number | undefined,
  now: number,
): boolean {
  if (lastPlayedAt === undefined) return true;
  return now - lastPlayedAt >= SOUND_THROTTLE_MS[kind];
}

/** 校验从线上收到的提示音事件。 */
export function parseSoundEvent(input: unknown): SoundEvent | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const kind = raw["kind"];
  if (kind !== "join" && kind !== "leave" && kind !== "mute" && kind !== "unmute") return null;
  const actor = typeof raw["actor"] === "string" ? raw["actor"].slice(0, 64) : "";
  const id = typeof raw["id"] === "string" ? raw["id"].slice(0, 64) : "";
  const ts = typeof raw["ts"] === "number" && Number.isFinite(raw["ts"]) ? raw["ts"] : 0;
  if (!id || !ts) return null;
  return { kind, actor, id, ts };
}
