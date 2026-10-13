import { VEGETABLE_LABEL, EAT_APPROACH_MS, feetViewportPx, consumedVegetableIds, type PenEvent } from "../pen";
import { Vegetable } from "./Vegetable";

/**
 * 猪圈里的道具层：投喂时 DDY 丢进来的蔬菜。
 * 蔬菜用百分比横向定位，窗口尺寸变化时仍落在原处。
 */

export interface PenPropEntry {
  event: PenEvent;
  expiresAt: number;
}

interface PenPropsLayerProps {
  entries: PenPropEntry[];
  /** 舞台底边到视口底部的距离（px）：把"视口脚部带"换算成舞台内 bottom 用。 */
  stageBottomGap: number;
  /** 当前时间，用来判断吃进行到哪一段。 */
  now: number;
}

export function PenPropsLayer({ entries, stageBottomGap, now }: PenPropsLayerProps) {
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
  return (
    <div className="vx-pen-props" aria-hidden="true">
      {veggies.map(({ event }) => (
        <span
          key={event.id}
          className="vx-veg"
          style={{
            left: `${(event.veg.x * 100).toFixed(2)}%`,
            // 纵向与猪的脚部带同一套视口映射（8%~50%），菜落在猪的活动带里
            bottom: `${(
              feetViewportPx(event.veg.lane, window.innerHeight) - stageBottomGap
            ).toFixed(1)}px`,
            /*
             * 等 DDY 走到猪跟前再把菜"抛"出来：入场走位约占 4.4s 动画的
             * 前 1.1s，所以延迟 1.1s 落下（vx-veg-toss 是 both 填充，
             * 延迟期间保持 0% 帧 = 透明，不会提前冒出来）。
             */
            animationDelay: "1.1s",
          }}
        >
          <i className="vx-veg-shadow" />
          <Vegetable kind={event.veg.kind} label={VEGETABLE_LABEL[event.veg.kind]} />
        </span>
      ))}


    </div>
  );
}

/**
 * DDY 本尊：从右侧走进来、走到目标位置（丢菜/抚摸）、再走回去。
 *
 * `mission` 决定表演内容：
 * - "feed"：走到蔬菜落点旁，抬手把菜抛出去（定时丢菜与成员投喂共用）；
 * - "pat"：走到目标猪身边，弯腰摸两下（成员点"摸一摸"）。
 * 横向位置 `targetX`（0~1）由 RoomView 按事件算好传入；
 * 入场距离 `stageWidth` 换算成 CSS 变量，让"从右缘外走进来"对任意落点都成立。
 */
export function NpcVisitor({
  name,
  active,
  mission = "feed",
  targetX = 0.8,
  stageWidth = 0,
}: {
  name: string;
  active: boolean;
  mission?: "feed" | "pat";
  targetX?: number;
  stageWidth?: number;
}) {
  if (!active) return null;
  const clamped = Math.min(0.86, Math.max(0.1, targetX));
  // 从右缘外走到落点需要的位移：落点越靠左，入场距离越长
  const enterPx = Math.max(90, Math.round(stageWidth * (1 - clamped) + 70));
  return (
    <div className="vx-npc" aria-hidden="true">
      <div
        className={`vx-npc-walker vx-npc-mission-${mission}`}
        style={{
          left: `${(clamped * 100).toFixed(2)}%`,
          ["--vx-npc-enter" as string]: `${enterPx}px`,
        }}
      >
        <div className="vx-npc-body">
          <DdyFigure />
        </div>
        <span className="vx-npc-name">{name}</span>
      </div>
    </div>
  );
}

/** DDY 的形象：戴草帽的饲养员，手里拎一篮菜（扁平风，与猪同一画风）。 */
function DdyFigure() {
  return (
    <svg viewBox="0 0 76 94" className="vx-npc-svg">
      {/* 腿：背带裤裤腿 */}
      <rect className="vx-npc-leg vx-npc-leg-a" x="27" y="58" width="10" height="26" rx="5" fill="#7b9ec9" />
      <rect className="vx-npc-leg vx-npc-leg-b" x="41" y="58" width="10" height="26" rx="5" fill="#7b9ec9" />
      <ellipse cx="32" cy="87" rx="7" ry="3.6" fill="#8a6b4a" />
      <ellipse cx="46" cy="87" rx="7" ry="3.6" fill="#8a6b4a" />

      {/* 身体：背带裤 + 衬衫肩背 */}
      <path d="M25 44 C25 35 31 30 39 30 C47 30 53 35 53 44 L53 62 C53 66 49 68 39 68 C29 68 25 66 25 62 Z" fill="#7b9ec9" />
      <path d="M27 42 C27 34 32 30 39 30 C46 30 51 34 51 40 L51 46 C46 49 32 49 27 46 Z" fill="#cfe0af" />
      {/* 背带 */}
      <rect x="30" y="30" width="4.4" height="14" rx="2.2" fill="#6a8cb8" />
      <rect x="44" y="30" width="4.4" height="14" rx="2.2" fill="#6a8cb8" />

      {/* 挽起的袖子 / 手臂（这只手负责丢菜、抚摸） */}
      <g className="vx-npc-arm">
        <rect x="49" y="38" width="8" height="20" rx="4" fill="#cfe0af" transform="rotate(-32 53 42)" />
        <circle cx="58" cy="35" r="4.6" fill="#f7c79e" />
      </g>
      <rect x="20" y="38" width="8" height="20" rx="4" fill="#cfe0af" />
      <circle cx="24" cy="59" r="4.6" fill="#f7c79e" />

      {/* 一篮菜（挂在另一只手上） */}
      <g className="vx-npc-basket">
        <path d="M11 60 L31 60 L28 74 L14 74 Z" fill="#c9955c" />
        <path d="M11 60 L31 60" stroke="#a8763f" strokeWidth="2" />
        <path d="M14.5 60 L16 74 M21 60 L21 74 M27.5 60 L26 74" stroke="#a8763f" strokeWidth="1.2" />
        <ellipse cx="16.5" cy="59" rx="4.4" ry="3.8" fill="#8fbf63" />
        <ellipse cx="24" cy="58" rx="4" ry="3.4" fill="#a3cf7a" />
        <ellipse cx="20.5" cy="55.4" rx="3.2" ry="2.8" fill="#ef8933" />
      </g>

      {/* 脖子 + 头 */}
      <rect x="35" y="24" width="8" height="8" rx="3" fill="#eeb086" />
      <circle cx="39" cy="17" r="12" fill="#f7c79e" />
      {/* 头发：一撮压在帽檐下 */}
      <path d="M28 14 C29 8 34 5 39 5 C44 5 49 8 50 14 C45 11 33 11 28 14 Z" fill="#6b4a2e" />
      <circle cx="35" cy="16" r="1.8" fill="#33323d" />
      <circle cx="43" cy="16" r="1.8" fill="#33323d" />
      <path d="M36 22 C38 24 40 24 42 22" fill="none" stroke="#b5703f" strokeWidth="1.6" strokeLinecap="round" />
      <ellipse cx="31.4" cy="20" rx="2.4" ry="1.6" fill="#ef7cba" opacity="0.45" />
      <ellipse cx="46.6" cy="20" rx="2.4" ry="1.6" fill="#ef7cba" opacity="0.45" />

      {/* 草帽：帽檐 + 帽顶 + 品红帽带（与小猪耳朵同色，全场景呼应） */}
      <ellipse cx="39" cy="10" rx="21" ry="5.4" fill="#f2ce7b" />
      <path d="M27 10 C27 2 51 2 51 10 Z" fill="#f6d98d" />
      <path d="M27 9.4 C27 6.4 51 6.4 51 9.4" fill="none" stroke="#e23f9c" strokeWidth="2.6" />
    </svg>
  );
}
