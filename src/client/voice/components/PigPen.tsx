import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";

import { EAT_APPROACH_MS, POOP_STRAIN_MS, clampToRange, type PenActionPhase } from "../pen";
import type { MediaLinkState } from "../engine";
import { INTERACT_KINDS, type InteractEvent, type InteractKind } from "../protocol";
import { Pig } from "./Pig";

/**
 * 整页猪圈。
 *
 * 房间就是一片简洁的暖色草坡：没有四边木栏，小猪直接在整片场地里走动、
 * 吃食物；顶部信息木牌与底部控制托盘浮在场景之上。
 *
 * 走动用 **Web Animations 直接驱动**（而不是 CSS 关键帧）：
 * 因为"走到蔬菜跟前再吃"需要精确停在某个横向位置，
 * 而 CSS 关键帧只能做固定路径的往返。
 * 三个 transform 分工，互不覆盖：
 *   .vx-pig-walker 用 left 定位（横向位置）
 *   .vx-pig-flip   用 scaleX 转身
 *   .vx-pig        姿态：走路起伏 / 说话跳 / 睡觉趴下
 */

/** 观察容器尺寸，用来算每头猪能走多远、走哪条"跑道"。 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () =>
      setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, ...size };
}

/**
 * 场景背板。
 *
 * 围栏已撤掉，改成干净简洁的背景板（顶部天光、底部一点点地面暖色暗示），
 * 小猪直接在简洁背板上走动、吃食物；不再有四边木栏。
 */
export function PenFrame({ width: _width = 0 }: { width?: number }) {
  return (
    <div className="vx-pen-frame" aria-hidden="true">
      <div className="vx-pen-frame-sky" />
      <div className="vx-pen-frame-ground" />
    </div>
  );
}

/** 地面点缀的图案：草 / 木头 / 野花 / 石子 / 蘑菇，全部内联 SVG。 */
function ScatterArt({ kind }: { kind: string }) {
  if (kind === "grass") {
    return (
      <svg viewBox="0 0 40 30" className="vx-scatter-svg">
        <path d="M8 30 C6 20 10 12 8 6 C13 13 12 22 12 30 Z" fill="#96b97c" />
        <path d="M16 30 C15 18 20 10 19 3 C24 12 22 22 21 30 Z" fill="#a6c68d" />
        <path d="M24 30 C24 21 29 14 28 8 C32 15 30 23 29 30 Z" fill="#87ab6d" />
        <path d="M31 30 C31 23 35 18 34 13 C37 19 35 25 34 30 Z" fill="#9bbf84" />
        <ellipse cx="20" cy="29" rx="15" ry="2.4" fill="rgba(74, 52, 24, 0.16)" />
      </svg>
    );
  }
  if (kind === "flower") {
    return (
      <svg viewBox="0 0 30 30" className="vx-scatter-svg">
        <path d="M15 17 C15 22 14 26 14 30" stroke="#7ea568" strokeWidth="1.8" fill="none" />
        <circle cx="15" cy="9" r="3.3" fill="#f0b8cc" />
        <circle cx="20.4" cy="12.6" r="3.3" fill="#f0b8cc" />
        <circle cx="19" cy="18.4" r="3.3" fill="#f0b8cc" />
        <circle cx="11" cy="18.4" r="3.3" fill="#f0b8cc" />
        <circle cx="9.6" cy="12.6" r="3.3" fill="#f0b8cc" />
        <circle cx="15" cy="14" r="2.6" fill="#f6d98a" />
        <ellipse cx="15" cy="29" rx="9" ry="1.7" fill="rgba(74, 52, 24, 0.14)" />
      </svg>
    );
  }
  if (kind === "pebble") {
    return (
      <svg viewBox="0 0 40 24" className="vx-scatter-svg">
        <ellipse cx="12" cy="16" rx="9" ry="6" fill="#b3aea2" />
        <ellipse cx="12" cy="13.6" rx="9" ry="3.2" fill="#cec9bd" />
        <ellipse cx="28" cy="18" rx="7" ry="4.6" fill="#a49f94" />
        <ellipse cx="28" cy="16.2" rx="7" ry="2.5" fill="#c0bbb0" />
      </svg>
    );
  }
  if (kind === "mushroom") {
    return (
      <svg viewBox="0 0 30 30" className="vx-scatter-svg">
        <rect x="12.5" y="15" width="6" height="12" rx="2.5" fill="#f3e6cc" />
        <path d="M6 16 C6 8 24 8 24 16 Z" fill="#e0734f" />
        <circle cx="12" cy="12.6" r="1.7" fill="#fff2e0" />
        <circle cx="18" cy="11" r="1.5" fill="#fff2e0" />
        <circle cx="16" cy="15" r="1.3" fill="#fff2e0" />
        <ellipse cx="15" cy="28" rx="9" ry="1.7" fill="rgba(74, 52, 24, 0.14)" />
      </svg>
    );
  }
  /* log：一截木头，顶面亮、侧面暗，端面年轮 */
  return (
    <svg viewBox="0 0 52 30" className="vx-scatter-svg">
      <rect x="8" y="10" width="36" height="14" rx="6" fill="#b98a4c" />
      <rect x="8" y="10" width="36" height="6" rx="3" fill="#d3a869" />
      <ellipse cx="10" cy="17" rx="4.6" ry="7" fill="#c99a5b" />
      <ellipse cx="10" cy="17" rx="2.6" ry="4.2" fill="#a87c44" />
      <ellipse cx="10" cy="17" rx="1.2" ry="2" fill="#8d6534" />
      <ellipse cx="28" cy="25" rx="20" ry="2.6" fill="rgba(74, 52, 24, 0.18)" />
    </svg>
  );
}

/** 空地上的点缀：草、野花、石子、蘑菇与木料，把整片泥地填得自然。 */
export function PenScatter({ seed }: { seed: number }) {
  /*
   * 位置用固定序列 + 少量由 seed 决定的偏移，而不是随机：
   * 随机会在每次重渲染时跳位置，看着像在闪。
   */
  const items = [
    { kind: "flower", x: 14, y: 83, s: 0.78 },
    { kind: "grass", x: 29, y: 90, s: 0.76 },
    { kind: "flower", x: 56, y: 87, s: 0.7 },
    { kind: "grass", x: 73, y: 91, s: 0.78 },
    { kind: "flower", x: 88, y: 85, s: 0.76 },
  ] as const;

  return (
    <div className="vx-pen-scatter" aria-hidden="true">
      {items.map((item, i) => {
        // 由 seed 决定的一点点抖动，不同房间的摆放略有差别
        const jitterX = (((seed + i * 37) % 11) - 5) * 0.5;
        const jitterY = (((seed + i * 53) % 9) - 4) * 0.6;
        return (
          <span
            key={i}
            className={`vx-scatter vx-scatter-${item.kind}`}
            style={{
              left: `${item.x + jitterX}%`,
              top: `${item.y + jitterY}%`,
              ["--vx-scatter-scale" as string]: item.s,
            }}
          >
            <ScatterArt kind={item.kind} />
          </span>
        );
      })}
    </div>
  );
}

export interface PigActorProps {
  /** 在圈里的序号，用来错开起步位置、跑道与步速。 */
  index: number;
  /** 圈里的猪总数。 */
  total: number;
  /** 场地宽度（px）。 */
  stageWidth: number;
  /** 场地高度（px），用来分配跑道。 */
  stageHeight: number;
  /** 成员颜色（用在蹄子上）。 */
  color: string;
  /** 是否正在说话。 */
  speaking: boolean;
  /** 是否静音（趴下睡觉）。 */
  sleeping: boolean;
  /** 是否闭听（戴上耳罩）。 */
  deafened?: boolean;
  /** 是不是房主：房主是大猪，其他成员是小猪。 */
  isHost: boolean;
  /** 点击回调（打开音量面板）。 */
  onSelect?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** 猪脖子上挂的木牌文字。 */
  label: string;
  /** 木牌上的小标记（房主 / 我 / 收听）。 */
  badges?: React.ReactNode;
  /** 正在吃 / 正在拉。 */
  action?: "none" | "eat" | "poop";
  /** 动作进行到哪一段。 */
  phase?: PenActionPhase;
  /** 要吃的那棵菜的横向位置（0~1）；没有就继续漫步。 */
  targetX?: number;
  /** 猪的跑道纵向比例（0=最远，1=最近），报给道具层对齐那一坨。 */
  laneRatio?: number;
  /** 把当前横向位置（0~1）报给引擎，房主据此挑最近的猪去吃菜。 */
  onReportPosition?: (x: number) => void;
  /** 与该成员的媒体连接状态（本地自己不传，不显示）。 */
  mediaState?: MediaLinkState;
  /** 最近一次冲着这头猪来的互动（戳/打招呼/投喂）。 */
  reaction?: InteractEvent;
}

const NETWORK_TITLE: Record<MediaLinkState, string> = {
  connecting: "正在建立语音连接…",
  connected: "直连，网络良好",
  relay: "经中继连接，可能略有延迟",
  failed: "连不上对方，可能听不到声音",
};

/** 每种互动冒出来的气泡文字。 */
const BUBBLE_TEXT: Record<InteractKind, string> = {
  poke: "！",
  wave: "你好~",
  feed: "♡",
  pat: "哼哼~",
  tickle: "哈哈哈",
  hug: "抱抱",
  boo: "！！",
  cheer: "耶~",
};

/** 互动时加在猪身上的动作 class，用全量移除保证连续触发也能重播。 */
const REACT_CLASSES = INTERACT_KINDS.map((kind) => `vx-pig-react-${kind}`).join(" ");

/** 一头会走、会走过去吃、会拉完闻一闻的小猪。 */
export function PigActor({
  index,
  total,
  stageWidth,
  stageHeight,
  color,
  speaking,
  sleeping,
  deafened = false,
  isHost,
  onSelect,
  label,
  badges,
  action = "none",
  phase = "none",
  targetX,
  laneRatio = 0.5,
  onReportPosition,
  mediaState,
  reaction,
}: PigActorProps) {
  const crowd = total > 5 ? 0.68 : total > 3 ? 0.8 : total > 1 ? 0.92 : 1;
  const size = Math.round((isHost ? 132 : 88) * crowd);
  const half = size / 2;

  // 活动范围：左右各留 40px 给木栏，右端再多留半只猪，走到头也不会被切掉。
  const leftLimit = 40;
  const rightLimit = Math.max(leftLimit, stageWidth - 40 - size);
  /*
   * 猪可以在整片场地上走（不再只占左侧）：
   * 单人提示浮在场地中间偏上，猪走的是下半部分的跑道，两者本来就错开。
   */
  const roamMax = rightLimit;

  // 跑道
  const groundTop = Math.round(stageHeight * 0.13);
  const groundHeight = Math.max(size + 8, stageHeight - groundTop - 8);
  /*
   * 猪要在整片泥地上活动，不能都贴着下栏走。
   * 跑道数由体型决定（通常 3 条）；人少时**不减少跑道**，只把猪分配到
   * 不同的跑道上，这样单只猪也站在场地中间而不是贴着下栏。
   */
  const lanes = Math.max(1, Math.min(3, Math.floor(groundHeight / (size * 0.78)) || 1));
  const laneSpan = Math.max(0, groundHeight - size - 26);
  const laneCount = Math.max(1, lanes - 1);
  /*
   * 跑道分配：
   * - 单人（空房等待）时让猪贴最下面那条跑道、横向在场地中央漫步，
   *   中上部完整留给"圈里只有你一头"提示块，二者在垂直方向彻底不重叠
   *   （运行时自检曾测到猪站立时顶到提示按钮 6px）。
   * - 多人时按序铺开到底、中、上跑道。
   */
  const lane = total <= 1 ? 0 : index % lanes;
  const depth = lanes === 1 ? 1 : 0.8 + (lane / laneCount) * 0.2;
  const laneBottom =
    lanes === 1 ? 26 + laneSpan * 0.18 : 26 + (lane / laneCount) * laneSpan;

  const walkerRef = useRef<HTMLDivElement | null>(null);
  const flipRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** 猪此刻的横向位置（px，相对场地左边缘）——由采样持续更新。 */
  const livePosRef = useRef(leftLimit);
  /** 每趟漫步的起点，仅用于决定往哪边走。 */
  const posRef = useRef(leftLimit);
  const playerRef = useRef<Animation | null>(null);
  /** 上报回调放进 ref：避免它变化导致采样/动画重启。 */
  const onReportPositionRef = useRef(onReportPosition);
  onReportPositionRef.current = onReportPosition;
  /** 空闲漫步：走到端点后歇一会儿再往回走。 */
  const [restKey, setRestKey] = useState(0);
  /**
   * 会随布局/成员变化的值统一放 ref：
   * 让行走的 effect 只依赖"是否在走"，而不是这些每帧可能变的值，
   * 否则动画会被反复掐断重开（实测走两步就被拽回起点）。
   */
  const stageWidthRef = useRef(stageWidth);
  stageWidthRef.current = stageWidth;
  const cfgRef = useRef({ leftLimit, roamMax, rightLimit, half, stageWidth, durationMs: 0 });
  cfgRef.current = { leftLimit, roamMax, rightLimit, half, stageWidth, durationMs: 0 };

  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");

  const busy = action !== "none";
  const walking = !speaking && !sleeping && !busy;
  // 吃 / 拉优先于说话，否则侧面那套动作会被正面姿态顶掉
  // 闭听的猪仍是侧躺睡觉姿态（戴耳罩），不正面、不讲话。
  const frontPose = speaking && !busy;

  const bumpRef = useRef<HTMLDivElement | null>(null);
  // 收到互动时给猪加对应的动作 class（移除再重加，强制重播动画）。
  useEffect(() => {
    const el = bumpRef.current;
    if (!el || !reaction) return;
    el.classList.remove(...REACT_CLASSES.split(" "));
    void el.offsetWidth;
    el.classList.add(`vx-pig-react-${reaction.kind}`);
  }, [reaction]);

  /*
   * 走动过程中**持续采样真实位置**。
   *
   * 为什么必须采样而不是停下时去读：
   * - `walker.style.left` 是 Web Animations 的**起点值**，动画不会改写 inline style，
   *   所以读它永远是这趟的起点（上一版就是这么错的，等于没修）；
   * - 用 `getComputedStyle` 去读动画中的值又受"取消后填充帧还在不在"影响，不可靠。
   *
   * 采样值同时供两个用途：停下时把位置钉住、以及上报给房主挑最近的猪去吃菜。
   */
  const samplePosition = useCallback(() => {
    const walker = walkerRef.current;
    const stage = stageRef.current;
    if (!walker || !stage) return;
    const stageRect = stage.getBoundingClientRect();
    if (stageRect.width <= 0) return;
    const rect = walker.getBoundingClientRect();
    const { leftLimit: lo, roamMax: hi } = cfgRef.current;
    const px = clampToRange(rect.left - stageRect.left, lo, hi);
    livePosRef.current = px;
    onReportPositionRef.current?.(Math.min(1, Math.max(0, (px + rect.width / 2) / stageRect.width)));
  }, []);

  // 走动时高频采样（每帧），停下/说话时也采一次，保证最后一帧是准的
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      samplePosition();
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [samplePosition]);

  /*
   * 从"正在走动"切到"停下"时，把**采样到的真实位置**钉住。
   *
   * 这是"听到声音就退回原地重新走"的根因修复：位置原本只在动画 onfinish 里记录，
   * 而说话导致的停下走的是 cancel()，不触发 onfinish，于是下次漫步从起点重开。
   */
  const wasWalkingRef = useRef(false);
  useEffect(() => {
    const walker = walkerRef.current;
    const wasWalking = wasWalkingRef.current;
    wasWalkingRef.current = walking;
    if (!walker || !wasWalking || walking) return;

    playerRef.current?.cancel();
    playerRef.current = null;
    // 用采样值（最后一帧的真实位置），而不是可能已失效的样式读数
    const settled = clampToRange(livePosRef.current, cfgRef.current.leftLimit, cfgRef.current.roamMax);
    posRef.current = settled;
    livePosRef.current = settled;
    walker.style.left = `${settled}px`;
  }, [walking]);

  /*
   * 空闲漫步：在活动范围里往返。
   *
   * 关键：**起点永远取采样到的当前位置**，而不是"上一趟的起点"。
   * 之前只在"走→停"跳变时把位置写回 posRef，而 effect 因依赖变化自己重跑
   * （例如 resizable 的场地宽度、歇息计时器）并不会产生这种跳变，
   * 于是 from 一直是旧值、to 又按中点规则算回同一点，distance≈0，
   * 结果就是 animation 被 cancel 后再也起不来、猪卡在起点（实测抓到的就是这样）。
   *
   * 现在每次重跑都用 livePosRef 当前值作为起点，顺便把它同步进 posRef。
   */
  useEffect(() => {
    const walker = walkerRef.current;
    if (!walker || !walking || stageWidthRef.current <= 0) return;

    const { leftLimit: lo, roamMax: hi } = cfgRef.current;
    // 以"此刻真实站的地方"为起点
    const from = clampToRange(livePosRef.current, lo, hi);
    posRef.current = from;
    const to =
      Math.abs(from - lo) < 4 ? hi : Math.abs(from - hi) < 4 ? lo : from < (lo + hi) / 2 ? hi : lo;
    const distance = Math.abs(to - from);

    if (distance < 4) {
      // 真的没地方可走（场地太窄）：歇一下再看，别空转
      const idle = window.setTimeout(() => setRestKey((n) => n + 1), 1200);
      return () => window.clearTimeout(idle);
    }

    // 慢悠悠：约 70px/s
    const ms = Math.max(3000, (distance / 70) * 1000);
    if (flipRef.current) {
      const facingLeft = to < from;
      flipRef.current.style.scale = facingLeft ? "-1 1" : "1 1";
      flipRef.current.classList.toggle("vx-pig-flip-l", facingLeft);
    }

    const anim = walker.animate(
      [{ left: `${from}px` }, { left: `${to}px` }],
      { duration: ms, easing: "linear", fill: "forwards" },
    );
    playerRef.current = anim;
    let restTimer = 0;
    anim.onfinish = () => {
      posRef.current = to;
      livePosRef.current = to;
      if (walkerRef.current) walkerRef.current.style.left = `${to}px`;
      playerRef.current = null;
      // 各头猪歇的时长不同，看起来才不像排队
      const rest = 1500 + ((index * 733) % 2800);
      restTimer = window.setTimeout(() => setRestKey((n) => n + 1), rest);
    };

    return () => {
      window.clearTimeout(restTimer);
      anim.cancel();
      playerRef.current = null;
      /*
       * 这里**不要**去读样式来恢复位置：
       * 动画一被 cancel，计算值立刻回落到 inline 的旧值（也就是起点），
       * 读出来的必然是错的（上一版就是这么错的）。
       * 正确的位置由采样循环持续维护在 livePosRef 里，下一次 effect 会用它当起点。
       */
    };
    // walking 与 restKey 是唯一的开关；index 只影响歇息时长
  }, [walking, restKey, index]);

  /*
   * 窗口缩放时把猪钳回新的活动范围。
   * 猪的横向位置是 px 值，且走动动画只在出发那一刻算一次边界；窗口缩小后
   * 旧位置可能超出新的右边界，采样循环虽然会把 livePos 钳到新值，但只改数字
   * 不移动 DOM，于是猪还停在画面外（实测"调窗口大小猪走没了"）。
   */
  const prevWidthRef = useRef(stageWidth);
  useEffect(() => {
    if (prevWidthRef.current === stageWidth) return;
    prevWidthRef.current = stageWidth;
    const walker = walkerRef.current;
    if (!walker) return;
    const { leftLimit: lo, roamMax: hi } = cfgRef.current;
    const p = clampToRange(livePosRef.current, lo, hi);
    livePosRef.current = p;
    posRef.current = p;
    playerRef.current?.cancel();
    playerRef.current = null;
    walker.style.left = `${p}px`;
    if (walking) setRestKey((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageWidth]);

  // 走向蔬菜：按住当前位置，再用 5 秒挪到菜跟前
  useEffect(() => {
    const walker = walkerRef.current;
    if (!walker || action !== "eat" || phase !== "approach") return;
    if (targetX === undefined || stageWidth <= 0) return;

    const target = Math.max(
      leftLimit,
      Math.min(rightLimit, targetX * stageWidth - half),
    );
    const from = Math.max(leftLimit, Math.min(rightLimit, posRef.current));
    playerRef.current?.cancel();

    if (flipRef.current) {
      const facingLeft = target < from;
      flipRef.current.style.scale = facingLeft ? "-1 1" : "1 1";
      flipRef.current.classList.toggle("vx-pig-flip-l", facingLeft);
    }

    // 剩下的时间刚好用掉"走向蔬菜"那一段，于是走到时正好开始吃
    const remain = EAT_APPROACH_MS;
    const anim = walker.animate(
      [{ left: `${from}px` }, { left: `${target}px` }],
      { duration: remain, easing: "ease-in-out", fill: "forwards" },
    );
    playerRef.current = anim;
    anim.onfinish = () => {
      posRef.current = target;
      if (walkerRef.current) walkerRef.current.style.left = `${target}px`;
      playerRef.current = null;
    };
    return () => {
      anim.cancel();
      playerRef.current = null;
    };
  }, [action, phase, targetX, stageWidth, leftLimit, rightLimit, half]);

  // 位置上报已经并进上面的采样循环（每帧一次，比原来的 1.5 秒轮询准确得多），
  // 这里不再需要单独一套。

  const style = useMemo(
    () =>
      ({
        "--vx-pig-size": `${size}px`,
        "--vx-pig-bottom": `${Math.round(laneBottom)}px`,
        "--vx-pig-fallback-x": `${(0.14 + 0.1 / Math.max(1, total)).toFixed(4)}`,
        "--vx-lane-ratio": laneRatio.toFixed(3),
        "--vx-depth": depth.toFixed(3),
        "--vx-tag-top": `${Math.round(52 + size * 0.06)}%`,
      }) as CSSProperties,
    [size, laneBottom, total, laneRatio, depth],
  );

  return (
    <div className={`vx-pig-slot${walking ? "" : " vx-pig-slot-still"}`} style={style} ref={stageRef}>
      <button
        type="button"
        className="vx-pig-hit"
        onClick={onSelect}
        title={`${label} — 点击调整音量`}
        aria-label={label}
      >
        <div className="vx-pig-walker" ref={walkerRef} style={{ left: `${leftLimit}px` }}>
          <div className="vx-pig-flip" ref={flipRef}>
            {/* 落地阴影跟着猪走 */}
            <span className="vx-pig-shadow" aria-hidden="true" />

            <div
              ref={bumpRef}
              className={`vx-pig${walking ? " vx-pig-walking" : ""}${frontPose ? " vx-pig-speaking" : ""}${sleeping ? " vx-pig-sleeping" : ""}${busy ? ` vx-pig-action-${action} vx-pig-phase-${phase}` : ""}`}
            >
              <Pig
                color={color}
                pose={frontPose ? "front" : "side"}
                talking={frontPose}
                action={action}
                phase={phase}
                uid={uid}
              />

              {deafened ? (
                <span
                  className={`vx-pig-earmuff vx-pig-earmuff-${frontPose ? "front" : "side"}`}
                  aria-hidden="true"
                >
                  <i className="vx-pig-em-band" />
                  <i className="vx-pig-em-cup vx-pig-em-l" />
                  <i className="vx-pig-em-cup vx-pig-em-r" />
                </span>
              ) : null}

              {sleeping ? (
                <span className="vx-pig-zzz" aria-hidden="true">
                  <i>z</i>
                  <i>z</i>
                  <i>z</i>
                </span>
              ) : null}
              {speaking ? <span className="vx-pig-voice" aria-hidden="true" /> : null}

              {mediaState ? (
                <span
                  className={`vx-pig-net vx-pig-net-${mediaState}`}
                  title={NETWORK_TITLE[mediaState]}
                  aria-hidden="true"
                >
                  {mediaState === "connecting" ? <i className="vx-pig-net-spin" /> : null}
                </span>
              ) : null}

              {reaction ? (
                <span
                  key={reaction.ts}
                  className={`vx-pig-bubble vx-pig-bubble-${reaction.kind}`}
                  aria-hidden="true"
                >
                  {BUBBLE_TEXT[reaction.kind]}
                </span>
              ) : null}

              <span className="vx-pig-tag">
                <i className="vx-pig-tag-cord" aria-hidden="true" />
                <span className="vx-pig-tag-face">
                  <span className="vx-pig-tag-name">{label}</span>
                  {badges}
                  {/*
                    连接方式写成**文字**，不只靠头顶那个小点。
                    6 个人时根本看不清谁在走中继，而"走中继"正是
                    "他声音断断续续"的原因——这是排查体验问题最需要的信息。
                    直连是正常状态，不显示，避免名字牌被塞满。
                  */}
                  {mediaState === "relay" ? (
                    <b className="vx-plate-net vx-plate-relay" title={NETWORK_TITLE.relay}>
                      中继
                    </b>
                  ) : null}
                  {mediaState === "failed" ? (
                    <b className="vx-plate-net vx-plate-failed" title={NETWORK_TITLE.failed}>
                      连不上
                    </b>
                  ) : null}
                  {mediaState === "connecting" ? (
                    <b className="vx-plate-net vx-plate-connecting" title={NETWORK_TITLE.connecting}>
                      连接中
                    </b>
                  ) : null}
                </span>
              </span>
            </div>
          </div>
        </div>
      </button>
    </div>
  );
}

export { POOP_STRAIN_MS };
