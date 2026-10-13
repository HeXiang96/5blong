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
    }
  | {
      kind: "poop";
      id: string;
      ts: number;
      /** 拉屎的猪（成员 id）。 */
      actor: string;
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

/** DDY 丢蔬菜的间隔：偶尔来一次，别太频繁。 */
export const TOSS_INTERVAL_MS = { min: 55_000, max: 150_000 };

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

/** 从 `?pen=pose:eat|poop` 里取出要强制摆出的动作（仅调试可用）。 */
export function debugPoseFrom(search: string): "eat" | "poop" | null {
  if (!isPenDebug(search)) return null;
  const match = /pose:(eat|poop)/.exec(search);
  return match ? (match[1] as "eat" | "poop") : null;
}

/** 蔬菜落地到被吃掉之间的等待。 */
export const EAT_DELAY_MS = { min: 6_000, max: 16_000 };

/** 吃完到拉屎之间的间隔。 */
export const POOP_DELAY_MS = { min: 14_000, max: 40_000 };

/** 猪自己偶尔也会拉一次（跟吃没吃无关）。 */
export const IDLE_POOP_MS = { min: 90_000, max: 260_000 };

/** 一次事件在画面上保留多久。 */
export const EVENT_TTL_MS = {
  toss: 40_000,
  /** 吃是"正在发生"的动作，短一点，别让猪看起来一直在嚼。 */
  eat: 2_400,
  /** 那一坨留久一点，但下面还限制了最多同时显示几坨。 */
  poop: 26_000,
};

/** 地上最多同时留几坨，免得越积越多看着像垃圾场。 */
export const MAX_POOP_PILES = 3;

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
 * 猪圈导演。房主持有一个实例，定时产出事件。
 *
 * 用法：调用 nextDelay() 拿到下次该等多久；到点后调用 produce()（丢菜）
 * 或 producePoop(actor)，把返回的事件广播出去。
 */
export class PenDirector {
  private lastVegX: number | undefined;

  constructor(private readonly random: Random = Math.random) {}

  /** 下一次丢蔬菜要等多久。 */
  nextTossDelay(): number {
    return randomBetween(this.random, TOSS_INTERVAL_MS.min, TOSS_INTERVAL_MS.max);
  }

  /** 距离吃完还有多久。 */
  nextEatDelay(): number {
    return randomBetween(this.random, EAT_DELAY_MS.min, EAT_DELAY_MS.max);
  }

  /** 吃完之后多久拉屎。 */
  nextPoopDelay(): number {
    return randomBetween(this.random, POOP_DELAY_MS.min, POOP_DELAY_MS.max);
  }

  /** 猪自己闲得无聊拉一泡。 */
  nextIdlePoopDelay(): number {
    return randomBetween(this.random, IDLE_POOP_MS.min, IDLE_POOP_MS.max);
  }

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

  /** 生成"某头猪拉屎"。 */
  producePoop(now: number, actor: string): Extract<PenEvent, { kind: "poop" }> {
    return { kind: "poop", id: `poop-${now}-${actor}`, ts: now, actor };
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

/** 猪走向蔬菜要多久。 */
export const EAT_APPROACH_MS = 5_000;
/** 走到之后低头吃多久（吃完菜才消失）。 */
export const EAT_MUNCH_MS = 3_200;
/** 蹲着使劲多久（那一坨在这段时间里从屁股后面冒出来落地）。 */
export const POOP_STRAIN_MS = 2_600;
/** 拉完回过头闻一闻多久。 */
export const POOP_SNIFF_MS = 2_600;

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

/** 从 CSS 的 left 值里解析出像素数；解析不出来返回 null。 */
export function parsePositionPx(left: string): number | null {
  const value = Number.parseFloat(left);
  return Number.isFinite(value) ? value : null;
}

export type PenActionPhase =
  | "none"
  /** 正在走向蔬菜 */
  | "approach"
  /** 已走到蔬菜前，低头在吃 */
  | "munch"
  /** 蹲下使劲，那一坨正冒出来 */
  | "strain"
  /** 闻一闻自己刚拉的 */
  | "sniff";

/**
 * 某头猪此刻的动作阶段。
 *
 * 吃分两段（走过去 → 低头吃），拉分两段（使劲 → 闻一闻）。
 * 用 `now` 与事件时间戳推算，所以同一份事件在任何端都会得到一致的画面，
 * 不需要额外广播"进行到第几段"。
 */
export function phaseForActor(
  events: readonly PenEvent[],
  actorId: string,
  now: number,
): { action: "none" | "eat" | "poop"; phase: PenActionPhase } {
  const matches = (actor: string) => actor === actorId || actor === "*";
  let result: { action: "none" | "eat" | "poop"; phase: PenActionPhase } = {
    action: "none",
    phase: "none",
  };

  // 先算拉（优先级低，会被吃覆盖）
  for (const event of events) {
    if (event.kind !== "poop" || !matches(event.actor)) continue;
    const elapsed = now - event.ts;
    if (elapsed < 0 || elapsed > POOP_STRAIN_MS + POOP_SNIFF_MS) continue;
    result =
      elapsed < POOP_STRAIN_MS
        ? { action: "poop", phase: "strain" }
        : { action: "poop", phase: "sniff" };
  }

  // 再算吃（覆盖拉的显示）
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
): "none" | "eat" | "poop" {
  let action: "none" | "eat" | "poop" = "none";
  for (const event of events) {
    // actor 为 "*" 表示调试用的"所有猪都做这个动作"
    if (event.kind === "eat" && (event.actor === actorId || event.actor === "*")) {
      action = "eat";
    } else if (
      event.kind === "poop" &&
      (event.actor === actorId || event.actor === "*") &&
      action === "none"
    ) {
      action = "poop";
    }
  }
  return action;
}

/** 挑选一头离蔬菜最近的猪来吃（按跑道横向位置近似）。 */
export function nearestActor(
  x: number,
  actors: { id: string; x: number }[],
): string | null {
  if (actors.length === 0) return null;
  let best = actors[0]!;
  let bestDistance = Math.abs(best.x - x);
  for (const actor of actors.slice(1)) {
    const distance = Math.abs(actor.x - x);
    if (distance < bestDistance) {
      best = actor;
      bestDistance = distance;
    }
  }
  return best.id;
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
