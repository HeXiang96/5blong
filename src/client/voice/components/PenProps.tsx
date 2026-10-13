import { MAX_POOP_PILES, POOP_STRAIN_MS, VEGETABLE_LABEL, EAT_APPROACH_MS, consumedVegetableIds, type PenEvent } from "../pen";
import { Vegetable } from "./Vegetable";

/**
 * 猪圈里的道具层：DDY 丢进来的蔬菜、以及猪拉在地上的那一坨。
 *
 * 蔬菜用百分比横向定位，窗口尺寸变化时仍落在原处；
 * 那一坨按猪的跑道对齐，看起来就是它刚拉在那儿。
 */

export interface PenPropEntry {
  event: PenEvent;
  expiresAt: number;
}

interface PenPropsLayerProps {
  entries: PenPropEntry[];
  /** 成员 id → 跑道纵向比例（0=最远，1=最近）。 */
  laneOf: (actorId: string) => number;
  /** 成员 id → 最新上报的横向位置（0~1）；没有就返回 undefined。 */
  xOf: (actorId: string) => number | undefined;
  /** 兜底横向位置（例如调试用的通配符没有真实位置）。 */
  fallbackX: number;
  /** 当前时间，用来判断吃进行到哪一段。 */
  now: number;
}

export function PenPropsLayer({ entries, laneOf, xOf, fallbackX, now }: PenPropsLayerProps) {
  // 哪些蔬菜已经被吃掉（配对规则见 pen.ts，那里有单测覆盖）。
  // 注意：吃分两段，猪要先走过去——所以只有进入"低头吃"才算真吃掉。
  const munching = entries.filter(
    (entry) => entry.event.kind === "eat" && now >= entry.event.ts + EAT_APPROACH_MS,
  );
  const consumed = consumedVegetableIds(munching.map((entry) => entry.event));

  const veggies = entries.filter(
    (entry): entry is PenPropEntry & { event: Extract<PenEvent, { kind: "toss" }> } =>
      entry.event.kind === "toss" && !consumed.has(entry.event.id),
  );
  const piles = entries
    .filter(
      (entry): entry is PenPropEntry & { event: Extract<PenEvent, { kind: "poop" }> } =>
        entry.event.kind === "poop",
    )
    // 只留最近几坨，否则地上会越积越多
    .sort((a, b) => b.event.ts - a.event.ts)
    .slice(0, MAX_POOP_PILES);

  return (
    <div className="vx-pen-props" aria-hidden="true">
      {veggies.map(({ event }) => (
        <span
          key={event.id}
          className="vx-veg"
          style={{
            left: `${(event.veg.x * 100).toFixed(2)}%`,
            // 纵向和猪的跑道同一套映射（6%~68%），看起来就落在某条跑道上
            bottom: `calc(6% + ${(event.veg.lane * 62).toFixed(1)}%)`,
            animationDelay: "0s",
          }}
        >
          <i className="vx-veg-shadow" />
          <Vegetable kind={event.veg.kind} label={VEGETABLE_LABEL[event.veg.kind]} />
        </span>
      ))}

      {piles.map(({ event }) => (
        <span
          key={event.id}
          className="vx-poop"
          style={{
            // 横向优先用猪当时站的位置，这样那一坨就落在它脚边；
            // 没有位置上报（例如调试通配符）就退回场地里一个偏左的位置。
            left: `${((xOf(event.actor) ?? fallbackX) * 100).toFixed(2)}%`,
            bottom: `${24 + laneOf(event.actor) * 84}px`,
            // 从屁股后面冒出来需要一点时间，这之前先别显示
            animationDelay: `${event.ts + POOP_STRAIN_MS * 0.35 - now}ms`,
          }}
        >
          <Pile />
        </span>
      ))}
    </div>
  );
}

/**
 * DDY 本尊：会从右侧栏外走过来、在栏边停下丢菜、再走回去。
 *
 * 之前只弹个名牌，人物不存在。现在由 `active` 控制出场，
 * 丢菜的时刻（`ts`）和 CSS 动画里的时间点对齐（见 styles.css 的 vx-npc-visit）。
 */
export function NpcVisitor({ name, active }: { name: string; active: boolean }) {
  if (!active) return null;
  return (
    <div className="vx-npc" aria-hidden="true">
      <div className="vx-npc-walker">
        <div className="vx-npc-body">
          <DdyFigure />
        </div>
        <span className="vx-npc-name">{name}</span>
      </div>
    </div>
  );
}

/** DDY 的形象：戴草帽的饲养员，手里拎一篮菜。 */
function DdyFigure() {
  return (
    <svg viewBox="0 0 74 92" className="vx-npc-svg">
      <defs>
        <linearGradient id="ddy-shirt" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7fb3d9" />
          <stop offset="100%" stopColor="#568cb5" />
        </linearGradient>
        <linearGradient id="ddy-hat" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f0d79a" />
          <stop offset="100%" stopColor="#d3ac63" />
        </linearGradient>
        <linearGradient id="ddy-pants" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5e6b7d" />
          <stop offset="100%" stopColor="#3f4a58" />
        </linearGradient>
      </defs>

      {/* 腿 */}
      <rect className="vx-npc-leg vx-npc-leg-a" x="26" y="62" width="9" height="26" rx="4" fill="url(#ddy-pants)" />
      <rect className="vx-npc-leg vx-npc-leg-b" x="39" y="62" width="9" height="26" rx="4" fill="url(#ddy-pants)" />
      <ellipse cx="30.5" cy="89" rx="7" ry="3.4" fill="#6b5236" />
      <ellipse cx="43.5" cy="89" rx="7" ry="3.4" fill="#6b5236" />

      {/* 身体 */}
      <path d="M22 40 C22 32 30 28 37 28 C44 28 52 32 52 40 L52 64 C52 68 48 70 37 70 C26 70 22 68 22 64 Z" fill="url(#ddy-shirt)" />
      {/* 挽起的袖子 / 手臂 */}
      <g className="vx-npc-arm">
        <rect x="48" y="36" width="8" height="22" rx="4" fill="#6ba1c9" transform="rotate(-38 52 40)" />
        <circle cx="57" cy="31" r="5" fill="#f2c9a0" />
      </g>
      <rect x="18" y="36" width="8" height="22" rx="4" fill="#6ba1c9" />
      <circle cx="22" cy="58" r="5" fill="#f2c9a0" />

      {/* 一篮菜（挂在另一只手上） */}
      <g className="vx-npc-basket">
        <path d="M12 62 L30 62 L27 76 L15 76 Z" fill="#c08a4a" />
        <path d="M12 62 L30 62" stroke="#9a6a34" strokeWidth="2" />
        <path d="M15 62 L17 76 M21 62 L21 76 M27 62 L25 76" stroke="#9a6a34" strokeWidth="1.2" />
        <ellipse cx="17" cy="61" rx="4.6" ry="4" fill="#7fb551" />
        <ellipse cx="24" cy="60" rx="4.2" ry="3.6" fill="#93c765" />
        <ellipse cx="21" cy="57" rx="3.4" ry="3" fill="#e08a3c" />
      </g>

      {/* 脖子 + 头 */}
      <rect x="33" y="22" width="8" height="8" rx="3" fill="#e8b98d" />
      <circle cx="37" cy="16" r="12" fill="#f6cfa6" />
      <circle cx="33" cy="15" r="1.8" fill="#4a3626" />
      <circle cx="41" cy="15" r="1.8" fill="#4a3626" />
      <path d="M34 21 C36 23 38 23 40 21" fill="none" stroke="#a5704a" strokeWidth="1.6" strokeLinecap="round" />

      {/* 草帽 */}
      <ellipse cx="37" cy="10" rx="22" ry="5.6" fill="url(#ddy-hat)" />
      <path d="M25 10 C25 1 49 1 49 10 Z" fill="url(#ddy-hat)" />
      <path d="M25 9.4 C25 6 49 6 49 9.4" fill="none" stroke="#b8914d" strokeWidth="2.4" />
    </svg>
  );
}

/** 那一坨：分层画，带一点高光和两只飘起来的小虫，不至于是一块纯色。 */
function Pile() {
  return (
    <span className="vx-poop-pile">
      <i className="vx-poop-layer vx-poop-layer-1" />
      <i className="vx-poop-layer vx-poop-layer-2" />
      <i className="vx-poop-layer vx-poop-layer-3" />
      <span className="vx-poop-stink">
        <em />
        <em />
      </span>
    </span>
  );
}
