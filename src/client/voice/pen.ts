/**
 * 猪圈的"导演"：NPC 管理员 DDY 丢蔬菜、猪吃、猪拉屎。
 *
 * 为什么放在房主：这些事件必须**所有人同时看到**，否则每个人的屏幕上
 * 各丢各的蔬菜，房间里就乱套了。房主本来就在跑心跳定时器，顺手当导演，
 * 生成的每个事件都广播给全部成员（含房主自己），各端只负责播动画。
 *
 * 这个文件是纯逻辑（不碰 DOM / 时间源靠传入），所以可以直接单测。
 */

export type VegetableKind = "carrot" | "cabbage" | "corn" | "apple";

export interface Vegetable {
  kind: VegetableKind;
  /** 落在场地里的横向位置（0~1，相对场地宽度）。 */
  x: number;
  /**
   * 落在哪条跑道（0=最靠后/离观众远，1=最靠前）。
   * 有这个字段，食物才能散落在整片泥地上，而不是全挤在最下边。
   */
  lane: number;
}

export type PenEvent =
  | {
      kind: "toss";
      id: string;
      ts: number;
      /** 这位 NPC 的固定名字。 */
      npc: string;
      veg: Vegetable;
    }
  | {
      kind: "eat";
      id: string;
      ts: number;
      /** 吃菜的猪（成员 id）。 */
      actor: string;
      veg: VegetableKind;
    };

/** NPC 管理员的名字，按需求固定。 */
export const NPC_NAME = "DDY";

export const VEGETABLE_KINDS: VegetableKind[] = ["carrot", "cabbage", "corn", "apple"];

/** 蔬菜图标（内联 SVG 用的键），以及中文名（无障碍提示用）。 */
export const VEGETABLE_LABEL: Record<VegetableKind, string> = {
  carrot: "胡萝卜",
  cabbage: "白菜",
  corn: "玉米",
  apple: "苹果",
};

/**
 * 调试开关（正式包里默认关闭）。
 *
 * 之前 `?pen=fast` 与 `?pen=pose:*` 是无条件生效的，任何人都能手输参数
 * 把丢菜间隔压到几秒、或强制猪摆出某个动作——正式产品不该留这种入口。
 *
 * 现在两档：
 * - 开发构建（`import.meta.env.DEV`）：URL 参数即可；
 * - 线上构建：**必须在浏览器里手动打开** `localStorage['5blong:debugPen']='1'`，
 *   这样参数不会被误触，需要排障时仍然可用。
 *
 * 另外让 `pen=fast` 走这里，免得 Vite 因为"字符串里出现在 dev 分支"而不敢做死代码消除。
 */
export function isPenDebug(search = ""): boolean {
  try {
    if (import.meta.env?.DEV) return true;
  } catch {
    /* 非 Vite 环境（例如单测）走到下面 */
  }
  if (typeof localStorage !== "undefined" && localStorage.getItem("5blong:debugPen") === "1") {
    return true;
  }
  void search;
  return false;
}

/** `?pen=fast` 且调试已开启时，把丢菜间隔压短。 */
export function isPenFast(search: string): boolean {
  return isPenDebug(search) && search.includes("pen=fast");
}

/** 从 `?pen=pose:eat` 里取出要强制摆出的动作（仅调试可用）。 */
export function debugPoseFrom(search: string): "eat" | null {
  if (!isPenDebug(search)) return null;
  const match = /pose:(eat)/.exec(search);
  return match ? (match[1] as "eat") : null;
}

/** 一次事件在画面上保留多久。 */
export const EVENT_TTL_MS = {
  toss: 40_000,
  /** 吃是"正在发生"的动作，短一点，别让猪看起来一直在嚼。 */
  eat: 2_400,
};

export interface Random {
  (): number;
}

export function randomBetween(random: Random, min: number, max: number): number {
  return min + random() * (max - min);
}

export function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length) % items.length]!;
}

/** 场地边界留白，免得蔬菜落在木栏上。 */
const X_MARGIN = 0.06;

export function randomVegetable(
  random: Random,
  previousX?: number,
  /** 落点范围（0~1），只有一头猪时会收窄到左侧，把右边留给邀请提示。 */
  range: { min: number; max: number } = { min: X_MARGIN, max: 1 - X_MARGIN },
): Vegetable {
  const kind = pick(random, VEGETABLE_KINDS);
  const lo = Math.max(0, range.min);
  const hi = Math.min(1, Math.max(lo, range.max));
  let x = lo + random() * (hi - lo);
  // 别连续丢在同一个地方，看起来才自然
  if (previousX !== undefined && Math.abs(x - previousX) < 0.15) {
    x = x < (lo + hi) / 2 ? x + 0.2 : x - 0.2;
    x = Math.min(hi, Math.max(lo, x));
  }
  // 纵向均匀散开（0~1），避免所有蔬菜都落在最靠前那一条
  const lane = random();
  return { kind, x: Number(x.toFixed(3)), lane: Number(lane.toFixed(3)) };
}

/**
 * 猪圈导演。房主持有一个实例，按需产出事件。
 *
 * 现在的职责很薄：投喂链路里的 eat 事件仍走 produceEat；
 * 定时刷食物已按需求移除（食物只能靠投喂）。
 */
export class PenDirector {
  private lastVegX: number | undefined;

  constructor(private readonly random: Random = Math.random) {}

  /** 生成"DDY 丢蔬菜"。只有一头猪时收窄落点，避开右侧的邀请提示。 */
  produceToss(now: number, pigCount = 2): Extract<PenEvent, { kind: "toss" }> {
    const range = pigCount <= 1 ? { min: 0.06, max: 0.36 } : { min: 0.06, max: 0.94 };
    const veg = randomVegetable(this.random, this.lastVegX, range);
    this.lastVegX = veg.x;
    return {
      kind: "toss",
      id: `toss-${now}-${Math.floor(this.random() * 1e6)}`,
      ts: now,
      npc: NPC_NAME,
      veg,
    };
  }

  /** 生成"某头猪吃掉蔬菜"。 */
  produceEat(now: number, actor: string, veg: VegetableKind): Extract<PenEvent, { kind: "eat" }> {
    return { kind: "eat", id: `eat-${now}-${actor}`, ts: now, actor, veg };
  }
}

/** 事件过期时间：到点就从画面上撤掉。 */
export function eventTtl(event: PenEvent): number {
  return EVENT_TTL_MS[event.kind];
}

/** 清掉已经过期的事件（纯函数，便于单测）。 */
export function pruneEvents(
  events: { event: PenEvent; expiresAt: number }[],
  now: number,
): { event: PenEvent; expiresAt: number }[] {
  return events.filter((entry) => entry.expiresAt > now);
}

/**
 * 纵深（lane 0~1）↔ 视口脚部带。
 *
 * 草坡背景是 fixed 到视口的，所以猪/菜的纵深必须按**视口高度**归一：
 * 脚只允许落在视口高度的 [8%, 50%] 区间内（上不越过天际线，下不踩进控制栏）。
 * 这也是跨分辨率同步的基础——同一 lane 在任何窗口高度都落在同一视口高度。
 */
export const FEET_MIN_VH = 0.08;
export const FEET_MAX_VH = 0.5;

/** lane（0=最远 1=最近）→ 脚部距视口底部的像素。 */
export function feetViewportPx(lane: number, innerHeight: number): number {
  const l = Math.min(1, Math.max(0, lane));
  return innerHeight * (FEET_MIN_VH + (FEET_MAX_VH - FEET_MIN_VH) * l);
}

/** 猪走向蔬菜要多久。 */
export const EAT_APPROACH_MS = 5_000;
/** 走到之后低头吃多久（吃完菜才消失）。 */
export const EAT_MUNCH_MS = 3_200;

/**
 * 把横向位置夹回允许范围。
 *
 * 存在的意义：猪走动的位置**必须**在停下/被打断时按真实值记下来。
 * 之前只在动画 onfinish 里记录，而"说话导致停下"走的是 cancel()，
 * 不触发 onfinish，于是位置还停在这趟的起点——下一次漫步就把猪拽回原地
 * （用户看到的就是"听到声音后跑回原地重新走"）。
 */
export function clampToRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

export type PenActionPhase =
  | "none"
  /** 正在走向蔬菜 */
  | "approach"
  /** 已走到蔬菜前，低头在吃 */
  | "munch";

/**
 * 某头猪此刻的动作阶段。
 *
 * 吃分两段（走过去 → 低头吃）。
 * 用 `now` 与事件时间戳推算，所以同一份事件在任何端都会得到一致的画面，
 * 不需要额外广播"进行到第几段"。
 */
export function phaseForActor(
  events: readonly PenEvent[],
  actorId: string,
  now: number,
): { action: "none" | "eat"; phase: PenActionPhase } {
  const matches = (actor: string) => actor === actorId || actor === "*";
  let result: { action: "none" | "eat"; phase: PenActionPhase } = {
    action: "none",
    phase: "none",
  };

  for (const event of events) {
    if (event.kind !== "eat" || !matches(event.actor)) continue;
    const elapsed = now - event.ts;
    if (elapsed < 0 || elapsed > EAT_APPROACH_MS + EAT_MUNCH_MS) continue;
    result =
      elapsed < EAT_APPROACH_MS
        ? { action: "eat", phase: "approach" }
        : { action: "eat", phase: "munch" };
  }

  return result;
}

/** 该猪此刻在做什么（只有动作，不含阶段）。 */
export function actionForActor(
  events: readonly PenEvent[],
  actorId: string,
): "none" | "eat" {
  let action: "none" | "eat" = "none";
  for (const event of events) {
    // actor 为 "*" 表示调试用的"所有猪都做这个动作"
    if (event.kind === "eat" && (event.actor === actorId || event.actor === "*")) {
      action = "eat";
    }
  }
  return action;
}


/**
 * 算出哪些蔬菜已经被吃掉了（返回被吃掉的蔬菜 id）。
 *
 * 判断规则不能简单化：
 * - 用"最近一次吃的时间"一刀切，会把之后新丢的菜也误删；
 * - 只记住上一棵菜，快速连丢时会被覆盖，导致菜永远留在地上。
 *
 * 所以按时间顺序维护一份"还在地上的菜"，每遇到一次"吃"就摘掉最匹配的
 * 那一棵：先看有没有种类吻合又落点接近的，其次退回最早丢下的。
 */
export function consumedVegetableIds(events: readonly PenEvent[]): Set<string> {
  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  const onGround: { id: string; kind: VegetableKind; x: number }[] = [];
  const consumed = new Set<string>();

  for (const event of ordered) {
    if (event.kind === "toss") {
      onGround.push({ id: event.id, kind: event.veg.kind, x: event.veg.x });
      continue;
    }
    if (event.kind !== "eat" || onGround.length === 0) continue;

    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < onGround.length; i += 1) {
      const candidate = onGround[i]!;
      const score = (candidate.kind === event.veg ? 0 : 10) + Math.abs(candidate.x - 0.5);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    consumed.add(onGround[bestIndex]!.id);
    onGround.splice(bestIndex, 1);
  }

  return consumed;
}
