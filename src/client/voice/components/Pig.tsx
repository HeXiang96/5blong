/**
 * 小猪：纯内联 SVG，不依赖任何图片素材。
 *
 * 造型按"Q 版大眼坐姿"风格：
 * - 大头小身（头部占比明显大于身体），两只圆润大耳；
 * - 大眼珠 + 白色高光点，猪鼻带鼻孔，笑容露舌，脸颊大面积粉色腮红；
 * - 层次：填充用径向渐变（高光→本色→暗部），再叠内阴影与边缘光，
 *   配合落地阴影做出 2.5D 的体积感。
 *
 * 配色决定：**猪身固定粉色系**，不跟随成员头像色。
 * 之前让猪身取头像色，结果出现"绿猪粉鼻子"这种搭配（头像色是随机分配的），
 * 与参考图的粉色系完全不符。成员身份改用**蹄子/项圈颜色**表达（material 来自 color）。
 *
 * 两个硬约束，改这个文件时别破坏：
 * 1. 耳朵必须是 SVG 里**最前面的几条 path**（左耳、左耳内、右耳、右耳内），
 *    CSS 用 nth-of-type 选中它们做"说话竖耳朵 / 睡觉耳朵下垂"。
 * 2. 眼睛的 fill 必须是 INK（CSS 用属性选择器做眨眼动画）。
 */

export type PigPose = "side" | "front";

/** 猪的额外状态：吃、拉。 */
export type PigAction = "none" | "eat" | "poop";

/** 动作阶段：决定头低到什么程度、有没有爱心。 */
export type PigPhase =
  | "none"
  | "approach"
  | "munch"
  | "strain"
  | "sniff";

interface PigProps {
  /** 成员头像色：用于蹄子与项圈，用来认出是谁的猪。 */
  color: string;
  pose: PigPose;
  /** 说话时嘴巴开合。 */
  talking?: boolean;
  /** 吃 / 拉时替换嘴部并压低头。 */
  action?: PigAction;
  /** 动作阶段：munch 才算吃到、sniff 要回头闻。 */
  phase?: PigPhase;
  /** 每个实例的唯一后缀，避免同页多个 SVG 的渐变 id 冲突。 */
  uid: string;
}

/** 由主色派生一档明暗；amount>0 更亮，<0 更暗。 */
function shade(hex: string, amount: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const value = parseInt(match[1]!, 16);
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const mix = (channel: number) =>
    amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount);
  const r = clamp(mix((value >> 16) & 0xff));
  const g = clamp(mix((value >> 8) & 0xff));
  const b = clamp(mix(value & 0xff));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/** 固定的粉色猪（取自参考图）：身体、耳朵、猪鼻、腮红、嘴。 */
const SKIN = "#f8b8c4";
const SKIN_LIGHT = "#ffd6de";
const SKIN_HIGHLIGHT = "#ffeef2";
const SKIN_DARK = "#eb9aab";
const PINK = "#f78fa8";
const PINK_SOFT = "#fbc0cd";
const MOUTH = "#8c3f52";
const TONGUE = "#ef7f97";
const INK = "#4a2b34";
const OUTLINE = "#8a5a63";

export function Pig({ color, pose, talking = false, action = "none", phase = "none", uid }: PigProps) {
  const collarDark = shade(color, -0.28);

  // 吃的时候低头去够地上的菜；拉的时候后腿下沉；闻的时候把鼻尖凑到地上。
  const eating = action === "eat";
  const pooping = action === "poop";
  const munching = eating && phase === "munch";
  const sniffing = pooping && phase === "sniff";
  const straining = pooping && phase === "strain";
  const bodyTilt = munching ? 8 : eating ? 3 : straining ? -5 : 0;

  /**
   * 耳朵。两种姿态形状不同（正脸是两只对称立耳，侧面是一只耳），
   * 但**都必须是 SVG 里最前面的 4 条 path**，CSS 靠 nth-of-type 选中做动作。
   */


  if (pose === "front") {
    return (
      <svg viewBox="0 0 100 88" className="vx-pig-svg" aria-hidden="true">
        <defs>
          <radialGradient id={`head-${uid}`} cx="36%" cy="24%" r="78%">
            <stop offset="0%" stopColor={SKIN_HIGHLIGHT} />
            <stop offset="48%" stopColor={SKIN_LIGHT} />
            <stop offset="100%" stopColor={SKIN} />
          </radialGradient>
          <radialGradient id={`ear-${uid}`} cx="40%" cy="20%" r="82%">
            <stop offset="0%" stopColor={SKIN_LIGHT} />
            <stop offset="100%" stopColor={SKIN_DARK} />
          </radialGradient>
          <radialGradient id={`body-${uid}`} cx="40%" cy="22%" r="84%">
            <stop offset="0%" stopColor={SKIN_LIGHT} />
            <stop offset="100%" stopColor={SKIN} />
          </radialGradient>
        </defs>

        <g
          className="vx-pig-body-group"
          style={{ transform: `rotate(${bodyTilt}deg)`, transformOrigin: "50px 80px" }}
        >
          {/* 耳朵（最前面 4 条 path，CSS 靠 nth-of-type 做动作） */}
          <rect x="14" y="12" width="21" height="30" rx="10.5" fill={`url(#ear-${uid})`} stroke={OUTLINE} strokeWidth="2.6" transform="rotate(-16 24 27)" />
          <rect x="20" y="19" width="11" height="18" rx="5.5" fill={PINK_SOFT} transform="rotate(-16 25 28)" />
          <rect x="65" y="12" width="21" height="30" rx="10.5" fill={`url(#ear-${uid})`} stroke={OUTLINE} strokeWidth="2.6" transform="rotate(16 75 27)" />
          <rect x="69" y="19" width="11" height="18" rx="5.5" fill={PINK_SOFT} transform="rotate(16 74 28)" />

          {/* 后脚（坐姿向外撇） */}
          <ellipse cx="17" cy="76" rx="13" ry="9.5" fill={SKIN} stroke={OUTLINE} strokeWidth="2.4" />
          <ellipse cx="83" cy="76" rx="13" ry="9.5" fill={SKIN} stroke={OUTLINE} strokeWidth="2.4" />
          <ellipse cx="12" cy="77" rx="4.2" ry="3" fill={collarDark} />
          <ellipse cx="20" cy="77" rx="4.2" ry="3" fill={collarDark} />
          <ellipse cx="80" cy="77" rx="4.2" ry="3" fill={collarDark} />
          <ellipse cx="88" cy="77" rx="4.2" ry="3" fill={collarDark} />

          {/* 小尾巴：坐姿时贴在身体右下，画在头之前但位置够低，
              否则会从脸颊旁边冒出来 */}
          <path
            d="M76 78 C84 78 87 71 82 68 C78 66 75 70 77 73"
            fill="none"
            stroke={OUTLINE}
            strokeWidth="2.4"
            strokeLinecap="round"
          />

          {/* 身体：坐姿的躯干，压在头下方（别顶到嘴） */}
          <ellipse cx="50" cy="73" rx="28" ry="15" fill={`url(#body-${uid})`} />
          <ellipse cx="50" cy="73" rx="28" ry="15" fill="none" stroke={OUTLINE} strokeWidth="2.6" />
          <ellipse cx="50" cy="78" rx="18" ry="8" fill={SKIN_LIGHT} opacity="0.6" />

          {/* 前爪（并拢坐着） */}
          <path d="M40 73 C38 79 38 82 40 84 L48 84 C50 81 50 77 49 73 Z" fill={SKIN} stroke={OUTLINE} strokeWidth="2.2" />
          <path d="M60 73 C62 79 62 82 60 84 L52 84 C50 81 50 77 51 73 Z" fill={SKIN} stroke={OUTLINE} strokeWidth="2.2" />
          <ellipse cx="44" cy="84" rx="4.6" ry="3" fill={collarDark} />
          <ellipse cx="56" cy="84" rx="4.6" ry="3" fill={collarDark} />

          {/* 头（大圆，压在身体上方；与侧视同款层次） */}
          <circle cx="50" cy="42" r="32" fill={`url(#head-${uid})`} stroke={OUTLINE} strokeWidth="2.8" />
          <path d="M24 32 C29 18 39 12 50 12 C57 12 62 14 66 17 C57 15 41 17 32 26 C27 31 25 37 24 43 Z" fill="#ffffff" opacity="0.45" />

          {/* 腮红 */}
          <ellipse cx="21" cy="52" rx="10" ry="7.4" fill={PINK} opacity="0.6" />
          <ellipse cx="79" cy="52" rx="10" ry="7.4" fill={PINK} opacity="0.6" />

          {/* 眼睛 */}
          <ellipse cx="34" cy="41" rx="9" ry="10.5" fill={INK} />
          <ellipse cx="66" cy="41" rx="9" ry="10.5" fill={INK} />
          <ellipse cx="37.4" cy="37.2" rx="3.4" ry="3.9" fill="#fff" />
          <ellipse cx="69.4" cy="37.2" rx="3.4" ry="3.9" fill="#fff" />
          <circle cx="31.4" cy="45.4" r="1.7" fill="#fff" opacity="0.8" />
          <circle cx="63.4" cy="45.4" r="1.7" fill="#fff" opacity="0.8" />

          {/* 猪鼻 */}
          <ellipse cx="50" cy="52" rx="13" ry="10" fill={PINK} stroke={OUTLINE} strokeWidth="2.2" />
          <ellipse cx="45.4" cy="51.4" rx="2.5" ry="3.4" fill={MOUTH} />
          <ellipse cx="54.6" cy="51.4" rx="2.5" ry="3.4" fill={MOUTH} />
          <ellipse cx="46.6" cy="48.2" rx="4.4" ry="1.7" fill="#ffffff" opacity="0.5" />

          {/* 嘴 */}
          {talking || eating ? (
            <>
              <path d="M41 60 C45 66 55 66 59 60 C56 57 44 57 41 60 Z" fill={MOUTH} />
              <ellipse cx="50" cy="63.4" rx="4.6" ry="2.6" fill={TONGUE} />
            </>
          ) : (
            <path d="M42 60 C46 65 54 65 58 60" fill="none" stroke={OUTLINE} strokeWidth="2.2" strokeLinecap="round" />
          )}

          {/* 吃东西时冒小爱心（呼应参考图） */}
          {eating ? (
            <path
              className="vx-pig-heart"
              d="M18 20 C18 16.5 22 15.5 23.6 18 C25.2 15.5 29.2 16.5 29.2 20 C29.2 23.8 23.6 27.5 23.6 27.5 C23.6 27.5 18 23.8 18 20 Z"
              fill="#ff5d7a"
            />
          ) : null}
        </g>
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 104 88" className="vx-pig-svg" aria-hidden="true">
      <defs>
        <radialGradient id={`shead-${uid}`} cx="34%" cy="22%" r="80%">
          <stop offset="0%" stopColor={SKIN_HIGHLIGHT} />
          <stop offset="48%" stopColor={SKIN_LIGHT} />
          <stop offset="100%" stopColor={SKIN} />
        </radialGradient>
        <radialGradient id={`sear-${uid}`} cx="40%" cy="20%" r="82%">
          <stop offset="0%" stopColor={SKIN_LIGHT} />
          <stop offset="100%" stopColor={SKIN_DARK} />
        </radialGradient>
        <radialGradient id={`sbody-${uid}`} cx="38%" cy="20%" r="84%">
          <stop offset="0%" stopColor={SKIN_LIGHT} />
          <stop offset="100%" stopColor={SKIN} />
        </radialGradient>
      </defs>

      <g
        className="vx-pig-body-group"
        style={{ transform: `rotate(${bodyTilt}deg)`, transformOrigin: "56px 80px" }}
      >
        {/* 远侧两条腿（先画，颜色暗，被身体压住） */}
        <g className="vx-pig-leg vx-pig-leg-b">
          <rect x="40" y="62" width="11" height="20" rx="5" fill={SKIN_DARK} />
          <rect x="40" y="77" width="11" height="5" rx="2.6" fill={collarDark} />
        </g>
        <g className="vx-pig-leg vx-pig-leg-d">
          <rect x="66" y="62" width="11" height="20" rx="5" fill={SKIN_DARK} />
          <rect x="66" y="77" width="11" height="5" rx="2.6" fill={collarDark} />
        </g>

        {/* 小尾巴：紧贴身体后缘 */}
        <path
          d="M23 44 C16 41 16 33 22 33 C27 33 27 40 22 40"
          fill="none"
          stroke={OUTLINE}
          strokeWidth="2.6"
          strokeLinecap="round"
        />

        {/* 耳朵：贴在头顶偏左，先画再画头，于是露出一大截 */}
        <rect x="34" y="6" width="20" height="28" rx="10" fill={`url(#sear-${uid})`} stroke={OUTLINE} strokeWidth="2.6" transform="rotate(-18 44 20)" />
        <rect x="39" y="12" width="10" height="17" rx="5" fill={PINK_SOFT} transform="rotate(-18 44 20)" />
        <rect x="58" y="9" width="18" height="25" rx="9" fill={SKIN_DARK} stroke={OUTLINE} strokeWidth="2.4" transform="rotate(6 67 21)" />
        <rect x="62" y="14" width="9" height="15" rx="4.5" fill={PINK} opacity="0.7" transform="rotate(6 67 21)" />

        {/* 身体 */}
        <ellipse cx="58" cy="54" rx="32" ry="22" fill={`url(#sbody-${uid})`} />
        <ellipse cx="58" cy="54" rx="32" ry="22" fill="none" stroke={OUTLINE} strokeWidth="2.6" />
        <path d="M30 42 C36 32 48 30 60 32 C48 33 37 38 31 48 Z" fill="#ffffff" opacity="0.45" />

        {/*
          头和五官单独成组：闻那一坨的时候整组绕脖子（约 62,58）往下转，
          鼻尖凑到地上。拆成单个元素改坐标太容易画歪。
        */}
        <g
          className="vx-pig-head"
          style={
            sniffing
              ? { transform: "rotate(19deg)", transformOrigin: "62px 56px" }
              : undefined
          }
        >
          {/* 头（大圆，略靠右） */}
          <circle cx="70" cy="36" r="28" fill={`url(#shead-${uid})`} stroke={OUTLINE} strokeWidth="2.8" />
          <path d="M48 26 C54 15 66 12 76 15 C66 16 56 21 50 31 Z" fill="#ffffff" opacity="0.42" />

          {/*
            侧面只画一只眼，而且要大、居中——Q 版侧脸就靠这只眼立住。
            之前眼睛偏小、位置偏高，整张脸看起来像正脸（还像青蛙）。
          */}
          <ellipse cx="74" cy="33" rx="8.6" ry="9.8" fill={INK} />
          <ellipse cx="77.2" cy="28.6" rx="3.3" ry="3.7" fill="#fff" />
          <circle cx="70.6" cy="37.4" r="1.7" fill="#fff" opacity="0.85" />

          {/* 腮红（往下、往嘴的方向靠一点） */}
          <ellipse cx="61" cy="49" rx="7.4" ry="5.4" fill={PINK} opacity="0.55" />

          {/* 猪鼻（朝右，侧面看是扁长的） */}
          <ellipse cx="95" cy="45" rx="10" ry="7.6" fill={PINK} stroke={OUTLINE} strokeWidth="2.2" />
          <ellipse cx="93.4" cy="45" rx="2.1" ry="2.7" fill={MOUTH} />
          <ellipse cx="97.6" cy="45" rx="2.1" ry="2.7" fill={MOUTH} />
          <ellipse cx="93.6" cy="42.4" rx="3.4" ry="1.3" fill="#ffffff" opacity="0.5" />

          {/* 嘴：吃的时候是"咀嚼"（靠 CSS 张合），拉和平时是抿嘴 */}
          {eating ? (
            <path
              className="vx-pig-chomp"
              d="M79 53 C83 60 91 60 95 53 C91 49 83 49 79 53 Z"
              fill={MOUTH}
            />
          ) : pooping ? (
            <path d="M81 55 C85 58 91 58 94 55" fill="none" stroke={OUTLINE} strokeWidth="2" strokeLinecap="round" />
          ) : (
            <path d="M79 53 C83 58 91 58 94 53" fill="none" stroke={OUTLINE} strokeWidth="2.2" strokeLinecap="round" />
          )}
        </g>

        {/* 近侧两条腿（后画，压在身体前） */}
        <g className="vx-pig-leg vx-pig-leg-a">
          <rect x="46" y="62" width="12" height="21" rx="5.4" fill={SKIN} />
          <rect x="46" y="77.5" width="12" height="5.5" rx="3" fill={collarDark} />
        </g>
        <g className="vx-pig-leg vx-pig-leg-c">
          <rect x="72" y="62" width="12" height="21" rx="5.4" fill={SKIN} />
          <rect x="72" y="77.5" width="12" height="5.5" rx="3" fill={collarDark} />
        </g>
      </g>
    </svg>
  );
}
