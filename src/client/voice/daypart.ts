/**
 * 场景光照时段：把一天分成清晨 / 白天 / 傍晚 / 夜晚四段。
 *
 * 为什么用各端自己的本地时钟、而不是广播房主的时间：
 * - 场景配色是纯视觉，各端看到自己时区的日光反而更自然；
 * - 房主对时需要动线上协议（pen.ts 的硬约束不允许），而现有
 *   phaseForActor 本来就假设各端时钟大致同步，沿用同一假设。
 *
 * ?daypart=dusk 这类 URL 参数可以强制指定时段，方便开发时目检各场景
 * （纯视觉覆盖，无副作用，不做开关限制）。
 */

export type Daypart = "morning" | "day" | "dusk" | "night";

/** 清晨 5:00–9:00，白天 9:00–16:30，傍晚 16:30–19:30，其余为夜晚。 */
export function daypartForHour(hourFloat: number): Daypart {
  const h = ((hourFloat % 24) + 24) % 24;
  if (h >= 5 && h < 9) return "morning";
  if (h >= 9 && h < 16.5) return "day";
  if (h >= 16.5 && h < 19.5) return "dusk";
  return "night";
}

/** 从 URL 参数里取强制时段（没有或非法时返回 null，走真实时钟）。 */
export function daypartOverride(search: string): Daypart | null {
  const value = new URLSearchParams(search).get("daypart");
  if (value === "morning" || value === "day" || value === "dusk" || value === "night") {
    return value;
  }
  return null;
}
