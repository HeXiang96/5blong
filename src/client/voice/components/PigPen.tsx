import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";

import { EAT_APPROACH_MS, FEET_MAX_VH, FEET_MIN_VH, clampToRange, feetViewportPx, type PenActionPhase } from "../pen";
import type { MediaLinkState } from "../engine";
import { INTERACT_KINDS, type InteractEvent, type InteractKind } from "../protocol";
import { daypartForHour, daypartOverride, type Daypart } from "../daypart";
import { registerPenPoseReader, readPenSnapshots } from "../pen-registry";
import { latestPenPose, registerPigFollower } from "../pen-follow";
import pigJoinUrl from "../assets/pig-join.webp?url";
import pigHoistUrl from "../assets/pig-hoist.webp?url";
import pigRunUrl from "../assets/pig-run.webp?url";
import pigWalkUrl from "../assets/pig-walk.webp?url";
import pigIdleUrl from "../assets/pig-idle.webp?url";
import pigDanceUrl from "../assets/pig-dance.webp?url";
import pigSleepUrl from "../assets/pig-sleep.webp?url";
import pigMunchUrl from "../assets/pig-munch.webp?url";
import pigPatUrl from "../assets/pig-pat.webp?url";
import pigBooUrl from "../assets/pig-boo.webp?url";
import pigPokeUrl from "../assets/pig-poke.webp?url";
import pigWaveUrl from "../assets/pig-wave.webp?url";
import pigTickleUrl from "../assets/pig-tickle.webp?url";
import pigCheerUrl from "../assets/pig-cheer.webp?url";

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
 * 当前光照时段（清晨/白天/傍晚/夜晚），按本地时钟每分钟刷新。
 * `?daypart=` URL 参数可强制指定，方便开发时目检各时段场景。
 * 除了挂到场景层（.vx-pen-frame），也挂到 <html> 上——浅色主题下
 * UI 色板会跟着时段一起微调（styles.css 里按 html[data-daypart] 覆盖）。
 */
function useDaypart(): Daypart {
  const compute = () => {
    const forced = daypartOverride(window.location.search);
    if (forced) return forced;
    const now = new Date();
    return daypartForHour(now.getHours() + now.getMinutes() / 60);
  };
  const [daypart, setDaypart] = useState<Daypart>(compute);
  useEffect(() => {
    const update = () => {
      const value = compute();
      setDaypart(value);
      document.documentElement.dataset.daypart = value;
      syncTitlebar(value);
    };
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return daypart;
}

/*
 * 桌面客户端的窗口标题栏颜色跟随时段天空色：
 * 之前标题栏是系统默认的白色，夜里一个白条压在深色场景上非常突兀。
 * 各时段取天空渐变的顶部色（与 .vx-pen-frame-sky 保持一致）。
 */
const TITLEBAR_COLORS: Record<Daypart, string> = {
  morning: '#f9e9e3',
  day: '#f7e9d4',
  dusk: '#f8e3c8',
  night: '#171c2c',
};

function syncTitlebar(daypart: Daypart): void {
  const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (!isDesktop) return;
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('set_window_bg', { color: TITLEBAR_COLORS[daypart] }))
    .catch(() => {});
}

/**
 * 场景背板。
 *
 * 分层静帧插画（与落地页同一暖调）：天空渐变 → 太阳/云（夜晚换月亮星星）→
 * 远山 → 近坡 → 走道草地。猪在草坡上走动。
 * 配色由 CSS 按 `data-daypart`（清晨/白天/傍晚/夜晚，跟随本地时钟）与
 * 深浅主题切换，这里只负责把层摆出来。
 */
export function PenFrame({ width: _width = 0 }: { width?: number }) {
  const daypart = useDaypart();
  return (
    <div className="vx-pen-frame" data-daypart={daypart} aria-hidden="true">
      <div className="vx-pen-frame-sky" />
      <i className="vx-sun" />
      <i className="vx-cloud vx-cloud-1" />
      <i className="vx-cloud vx-cloud-2" />
      <i className="vx-moon" />
      <i className="vx-star vx-star-1" />
      <i className="vx-star vx-star-2" />
      <i className="vx-star vx-star-3" />
      <i className="vx-star vx-star-4" />
      <i className="vx-star vx-star-5" />
      <svg
        className="vx-pen-frame-hills"
        viewBox="0 0 1000 300"
        preserveAspectRatio="none"
      >
        <path
          className="vx-hill vx-hill-far"
          d="M0 132 C150 84 330 110 490 92 C670 72 840 102 1000 82 L1000 300 L0 300 Z"
        />
        <path
          className="vx-hill vx-hill-mid"
          d="M0 192 C190 148 410 178 620 158 C790 142 910 164 1000 150 L1000 300 L0 300 Z"
        />
        <path
          className="vx-hill vx-hill-ground"
          d="M0 238 C250 216 530 236 770 226 C880 221 950 226 1000 222 L1000 300 L0 300 Z"
        />
      </svg>
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
  action?: "none" | "eat";
  /** 动作进行到哪一段。 */
  phase?: PenActionPhase;
  /** 要吃的那棵菜：横向位置（0~1）与落地高度（px，相对场地底边）。 */
  targetX?: { x: number; bottomPx: number };
  /** 猪的跑道纵向比例（0=最远，1=最近）——出生时的兜底值。 */
  /** 把当前位置（横向 0~1、纵深 0~1）报给引擎，房主据此挑最近的猪去吃菜。 */
  onReportPosition?: (x: number, lane: number) => void;
  /** 与该成员的媒体连接状态（本地自己不传，不显示）。 */
  mediaState?: MediaLinkState;
  /** 最近一次冲着这头猪来的互动（戳/打招呼/投喂）。 */
  reaction?: InteractEvent;
  /** 该成员第一次出现在名册的时刻（本地毫秒）。入圈时播"天降吊猪"动画。 */
  entryAt?: number;
  /** 这头猪被投喂过的次数（本地视角）：喂得越多体型越大一点点。 */
  feedCount?: number;
  /**
   * 访客端：跟随房主权威位置渲染（数据从 pen-follow store 按帧读取，
   * 刻意不走 React state——50ms 一条快照 setState 会把主线程拖垮）。
   */
  followEnabled?: boolean;
  /** 成员 id：猪位快照注册表的键（房主后台广播用）。 */
  actorId: string;
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
  hoist: "哇啊～",
};

/**
 * 各互动对应的精灵素材。
 * 抱抱暂时借用"被摸"、投喂借用"撒花"的动画，后续有专属素材再换。
 */
const REACT_SRC: Partial<Record<InteractKind, string>> = {
  poke: pigPokeUrl,
  wave: pigWaveUrl,
  tickle: pigTickleUrl,
  pat: pigPatUrl,
  boo: pigBooUrl,
  cheer: pigCheerUrl,
  hug: pigPatUrl,
  feed: pigCheerUrl,
};

/** 互动时加在猪身上的动作 class，用全量移除保证连续触发也能重播。 */
const REACT_CLASSES = INTERACT_KINDS.map((kind) => `vx-pig-react-${kind}`).join(" ");

/**
 * 新成员"空降入圈"动画的总时长：精灵是"伞张开悬停"循环，
 * 下落由 CSS 演（2.1s 垂降 + 落地轻弹），这里多留一点缓冲。
 */
export const ENTRY_TOTAL_MS = 2_400;

/** 一头会走、会走过去吃、会拉完闻一闻的小猪。 */
export function PigActor({
  index,
  total,
  stageWidth,
  stageHeight,
  actorId,
  speaking,
  sleeping,
  deafened = false,
  onSelect,
  label,
  badges,
  action = "none",
  phase = "none",
  targetX,
  onReportPosition,
  mediaState,
  reaction,
  entryAt,
  feedCount = 0,
  followEnabled = false,
}: PigActorProps) {
  const crowd = total > 5 ? 0.68 : total > 3 ? 0.8 : total > 1 ? 0.92 : 1;
  /*
   * 全员默认同一体型（112px 基准）；被投喂多了会长大一点点：
   * 每次 +0.8%、封顶 12 次（+9.6%），最大 ≈123px，不会变成巨猪。
   */
  const feedGrowth = 1 + Math.min(feedCount, 12) * 0.008;
  const size = Math.round(112 * crowd * feedGrowth);
  const half = size / 2;

  /*
   * 自由漫步的活动范围：横向左右各留 40px；纵向从贴地 14px 到场地上部
   * ——四面八方都能走，不再锁死在固定跑道上。
   */
  const leftLimit = 40;
  const rightLimit = Math.max(leftLimit, stageWidth - 40 - size);
  const roamMax = rightLimit;

  /*
   * 跑道参数只作为**出生兜底**：真正的出生点是随机的（见漫步 effect），
   * 阴影浓淡（深度感）也先按出生兜底给个初值。
   */
  const groundTop = Math.round(stageHeight * 0.13);
  const groundHeight = Math.max(size + 8, stageHeight - groundTop - 8);
  const lanes = Math.max(1, Math.min(3, Math.floor(groundHeight / (size * 0.78)) || 1));
  const laneSpan = Math.max(0, groundHeight - size - 26);
  const laneCount = Math.max(1, lanes - 1);
  const lane = total <= 1 ? 0 : index % lanes;
  const depth = lanes === 1 ? 1 : 0.8 + (lane / laneCount) * 0.2;
  const laneBottom =
    lanes === 1 ? 26 + laneSpan * 0.18 : 26 + (lane / laneCount) * laneSpan;

  const walkerRef = useRef<HTMLDivElement | null>(null);
  const flipRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** 猪此刻的位置（px，相对场地左/下边缘）——由采样持续更新。 */
  const livePosRef = useRef(leftLimit);
  const liveBottomRef = useRef(laneBottom);
  /** 每趟漫步的起点，仅用于决定往哪边走。 */
  const posRef = useRef(leftLimit);
  /** 出生点是否已经随机化过（场地尺寸就绪后一次性随机）。 */
  const spawnedRef = useRef(false);
  /** 朝向（1=面右 -1=面左）：只用于翻转视觉。 */
  const facingRef = useRef<1 | -1>(1);
  /** 当前走位动画的解析参数（供后台快照用，见 pen-registry）。 */
  const segRef = useRef<{ fromX: number; fromB: number; toX: number; toB: number; player: Animation } | null>(null);
  const playerRef = useRef<Animation | null>(null);
  /** 统一设置朝向：翻转视觉 + 记录给上报。 */
  const setFacing = useCallback((facingLeft: boolean) => {
    facingRef.current = facingLeft ? -1 : 1;
    if (flipRef.current) {
      flipRef.current.style.scale = facingLeft ? "-1 1" : "1 1";
      flipRef.current.classList.toggle("vx-pig-flip-l", facingLeft);
    }
  }, []);

  /**
   * 视口脚部带（stage 相对 bottom 的上下限）。
   * 草坡背景是 fixed 到视口的，所以纵深必须按**视口**归一：
   * 猪脚只允许落在视口高度的 [FEET_MIN_VH, FEET_MAX_VH] 区间内——
   * 任何分辨率下都不会再"走到天上"，而且同一 lane 在任何窗口里
   * 都落在同一视口高度（跨端同步的基础）。
   */
  const feetRange = useCallback((): { min: number; max: number } => {
    const slot = stageRef.current;
    const root = (slot?.closest(".vx-stage") ?? slot) as HTMLElement | null;
    const ih = typeof window !== "undefined" ? window.innerHeight : 800;
    if (!root) return { min: 14, max: Math.max(140, stageHeight * 0.52) };
    const rootRect = root.getBoundingClientRect();
    const min = rootRect.bottom - ih * (1 - FEET_MIN_VH);
    const max = Math.min(rootRect.height - size - 6, rootRect.bottom - ih * (1 - FEET_MAX_VH));
    return { min: Math.max(8, min), max: Math.max(min + 8, max) };
  }, [stageHeight, size]);

  /** 其他猪的实时中心点（舞台 px）——出生/选点的互斥距离检查用。 */
  const otherCenters = useCallback((): Array<{ x: number; b: number }> => {
    const width = stageWidthRef.current;
    if (width <= 0) return [];
    const feet = feetRange();
    const out: Array<{ x: number; b: number }> = [];
    for (const [id, snap] of readPenSnapshots()) {
      if (id === actorId) continue;
      out.push({
        x: snap.x * width,
        b: feet.min + snap.lane * (feet.max - feet.min),
      });
    }
    return out;
  }, [actorId, feetRange]);

  /** 出生点：随机 + 与其他猪保持距离（ rejection sampling，最多试 14 次）。 */
  const pickSpreadSpawn = useCallback((): { x: number; b: number } => {
    const cfg = cfgRef.current;
    const feet = feetRange();
    const others = otherCenters();
    const randX = () => cfg.leftLimit + Math.random() * Math.max(1, cfg.roamMax - cfg.leftLimit);
    const randB = () => feet.min + Math.random() * Math.max(1, feet.max - feet.min);
    for (let i = 0; i < 14; i += 1) {
      const x = randX();
      const b = randB();
      if (others.every((o) => Math.hypot(o.x - x, (o.b - b) * 1.6) >= 150)) return { x, b };
    }
    return { x: randX(), b: randB() };
  }, [otherCenters, feetRange]);
  /** 上报回调放进 ref：避免它变化导致采样/动画重启。 */
  const onReportPositionRef = useRef(onReportPosition);
  onReportPositionRef.current = onReportPosition;
  /** 空闲漫步：走到目标点后歇一会儿再挑下一个目标。 */
  const [restKey, setRestKey] = useState(0);
  /**
   * 会随布局/成员变化的值统一放 ref：
   * 让行走的 effect 只依赖"是否在走"，而不是这些每帧可能变的值，
   * 否则动画会被反复掐断重开（实测走两步就被拽回起点）。
   */
  const stageWidthRef = useRef(stageWidth);
  stageWidthRef.current = stageWidth;
  const cfgRef = useRef({
    leftLimit,
    roamMax,
    rightLimit,
    half,
    stageWidth,
  });
  cfgRef.current = { leftLimit, roamMax, rightLimit, half, stageWidth };

  const busy = action !== "none";

  /*
   * 新成员吊装入圈：entryAt 起 ENTRY_TOTAL_MS 内播放
   * "吊绳下放 → 落地打个滚"，期间不漫步、不蹦迪（纯 CSS 双段动画，
   * JS 只负责到点把 entering 撤掉）。
   */
  const [entering, setEntering] = useState(
    () => entryAt !== undefined && Date.now() - entryAt < ENTRY_TOTAL_MS,
  );
  useEffect(() => {
    if (entryAt === undefined) {
      setEntering(false);
      return;
    }
    const remain = ENTRY_TOTAL_MS - (Date.now() - entryAt);
    if (remain <= 0) {
      setEntering(false);
      return;
    }
    setEntering(true);
    const timer = window.setTimeout(() => setEntering(false), remain);
    return () => window.clearTimeout(timer);
  }, [entryAt]);

  /*
   * 互动反应窗口内（约 3.2s）猪停下当前活动做反应：
   * 否则漫步/说话/睡觉的动画类会和反应/吊起动画在同一元素上打架
   * （同一个 transform/animation 属性只能有一份）。
   */
  const reacting = Boolean(reaction);
  /*
   * 访客端的猪跟随房主权威位置：不本地漫步，走位由 rAF 插值循环驱动。
   * （房主端 followEnabled=false，一切照旧。）
   */
  const following = followEnabled;
  const walking = !speaking && !sleeping && !busy && !entering && !reacting && !following;
  // 吃 / 拉优先于说话，否则侧面那套动作会被正面姿态顶掉
  // 闭听的猪仍是侧躺睡觉姿态（戴耳罩），不正面、不讲话。
  const frontPose = speaking && !busy && !entering && !reacting;
  /** 跟随模式下"正在移动"（用来播走路素材）。 */
  const [remoteMoving, setRemoteMoving] = useState(false);

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
   * 走动过程中**持续采样真实位置**（横向 + 纵深）。
   *
   * 为什么必须采样而不是停下时去读：
   * - `walker.style.left` 是 Web Animations 的**起点值**，动画不会改写 inline style，
   *   所以读它永远是这趟的起点（上一版就是这么错的，等于没修）；
   * - 用 `getComputedStyle` 去读动画中的值又受"取消后填充帧还在不在"影响，不可靠。
   *
   * 采样值同时供两个用途：停下时把位置钉住、以及上报（横向 0~1 + 纵深 0~1，
   * 房主据此挑最近的猪去吃菜）。
   */
  const samplePosition = useCallback(() => {
    const walker = walkerRef.current;
    const slot = stageRef.current;
    if (!walker || !slot) return;
    /*
     * 注意量测基准：
     * - slot 是猪的小格子（121px），walker 的 left 是"槽内坐标"（动画/边界用它）；
     * - 上报给引擎的百分比必须按**真正的舞台**（.vx-stage）归一化——
     *   历史上这里错用了小格子宽度，横向百分比全被 clamp 成 1.0
     *   （表现为"投喂的菜永远落在最右边/同一处"）。
     */
    const root = slot.closest(".vx-stage") ?? slot;
    const rootRect = root.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();
    if (rootRect.width <= 0) return;
    const rect = walker.getBoundingClientRect();
    const { leftLimit: lo, roamMax: hi } = cfgRef.current;
    const feetBand = feetRange();
    const px = clampToRange(rect.left - slotRect.left, lo, hi);
    livePosRef.current = px;
    liveBottomRef.current = clampToRange(rootRect.bottom - rect.bottom, feetBand.min, feetBand.max);
    /*
     * lane 按**视口**归一（不是舞台）：草坡背景 fixed 在视口上，
     * 同一 lane 在任何窗口高度都落在同一视口高度——跨分辨率同步的基础。
     */
    const ih = typeof window !== "undefined" ? window.innerHeight : 800;
    const feet = ih - rect.bottom;
    const band = (FEET_MAX_VH - FEET_MIN_VH) * ih;
    const lane = band > 0 ? Math.min(1, Math.max(0, (feet - FEET_MIN_VH * ih) / band)) : 0.5;
    onReportPositionRef.current?.(
      Math.min(1, Math.max(0, (rect.left - rootRect.left + rect.width / 2) / rootRect.width)),
      lane,
    );
  }, [feetRange]);

  /**
   * 位置快照（不依赖 rAF）：直接量 DOM 矩形。
   * 猪的走位动画跑的是 left/bottom（主线程布局属性），
   * getBoundingClientRect 在后台标签页里也是准的——房主切后台时
   * 广播出去的坐标不会冻结（否则全房跟着卡住）。
   */
  const snapshotPose = useCallback((): { x: number; lane: number } | null => {
    const walker = walkerRef.current;
    const slot = stageRef.current;
    if (!walker || !slot) return null;
    const root = slot.closest(".vx-stage") ?? slot;
    const rootRect = root.getBoundingClientRect();
    if (rootRect.width <= 0) return null;
    /*
     * 房主广播热路径：走位动画在跑时**解析式**算位置（动画起点/终点 +
     * currentTime），不逐帧量 DOM（50ms × 8 头猪的强制布局也是负担）。
     * 动画不在跑（待机/停下）时才落到下面的矩形量测。
     */
    const seg = segRef.current;
    if (seg && seg.player.playState === "running") {
      const timing = seg.player.effect?.getComputedTiming();
      const duration = typeof timing?.duration === "number" ? timing.duration : 0;
      const t =
        duration > 0 ? Math.min(1, Math.max(0, Number(seg.player.currentTime ?? 0) / duration)) : 1;
      const slotRect = slot.getBoundingClientRect();
      const leftPx = seg.fromX + (seg.toX - seg.fromX) * t + (slotRect.left - rootRect.left);
      const bottomPx =
        seg.fromB + (seg.toB - seg.fromB) * t + (rootRect.bottom - slotRect.bottom);
      const x = Math.min(1, Math.max(0, (leftPx + cfgRef.current.half) / rootRect.width));
      const ih = typeof window !== "undefined" ? window.innerHeight : 800;
      const feet = ih - (rootRect.bottom - bottomPx);
      const band = (FEET_MAX_VH - FEET_MIN_VH) * ih;
      const lane = band > 0 ? Math.min(1, Math.max(0, (feet - FEET_MIN_VH * ih) / band)) : 0.5;
      return { x, lane };
    }
    const rect = walker.getBoundingClientRect();
    const x = Math.min(
      1,
      Math.max(0, (rect.left - rootRect.left + rect.width / 2) / rootRect.width),
    );
    const ih = typeof window !== "undefined" ? window.innerHeight : 800;
    const feet = ih - rect.bottom;
    const band = (FEET_MAX_VH - FEET_MIN_VH) * ih;
    const lane = band > 0 ? Math.min(1, Math.max(0, (feet - FEET_MIN_VH * ih) / band)) : 0.5;
    return { x, lane };
  }, []);

  // 注册到快照表：房主广播（含后台标签页）从这里取实时位置
  useEffect(() => registerPenPoseReader(actorId, snapshotPose), [actorId, snapshotPose]);

  // 走动时高频采样（每帧），停下/说话时也采一次，保证最后一帧是准的。
  // 访客端跳过：走位由 rAF 插值循环直接维护，无需再量 DOM。
  useEffect(() => {
    if (following) return;
    let raf = 0;
    const loop = () => {
      samplePosition();
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [samplePosition, following]);

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
    segRef.current = null;
    // 用采样值（最后一帧的真实位置），而不是可能已失效的样式读数
    const settledX = clampToRange(livePosRef.current, cfgRef.current.leftLimit, cfgRef.current.roamMax);
    const feet = feetRange();
    const settledB = clampToRange(liveBottomRef.current, feet.min, feet.max);
    posRef.current = settledX;
    livePosRef.current = settledX;
    liveBottomRef.current = settledB;
    walker.style.left = `${settledX}px`;
    walker.style.bottom = `${settledB}px`;
  }, [walking]);

  /**
   * 出生点零散化：场地尺寸就绪后**随机落位一次**（不依赖是否在走——
   * 空降入场也要落在随机点，落地后就在这个点开始活动）。
   * 跟随模式（访客端）则用房主的第一帧权威位置当出生点——空降落在
   * 全房一致的位置上。
   */
  useEffect(() => {
    const walker = walkerRef.current;
    if (spawnedRef.current || !walker || stageWidth <= 0) return;
    if (following) return; // 跟随模式的首帧落位由 rAF 插值循环负责
    const { x, b } = pickSpreadSpawn();
    spawnedRef.current = true;
    livePosRef.current = x;
    liveBottomRef.current = b;
    posRef.current = x;
    walker.style.left = `${x}px`;
    walker.style.bottom = `${b}px`;
  }, [stageWidth, following, pickSpreadSpawn]);

  /*
   * 房主权威位置的平滑跟随（访客端）。
   *
   * - 数据：pen-follow store 按需读取（不进 React，避免 20Hz 渲染风暴）；
   * - 推进：统一走 pen-follow 的共享推进器——前台 rAF 每帧、后台
   *   Worker 计时器 100ms 小步（后台不节流），回来不跳变；
   * - 平滑：指数逼近，时间常数 ≈170ms。广播 600ms 一条，
   *   这个常数让猪始终"在路上"，看起来是连续散步而不是一格一格挪。
   *
   * ⚠ 分工（不会与"分散算法"冲突，别在这里加走位随机）：
   * - 房主端：分散算法产生权威位置并广播，**从不 follow**；
   * - 访客端：只 follow，本地漫步/分散算法整体被 !following 关掉。
   */
  /** 空降入场期间先别被跟随推进器挪走（落地后自然接上）。 */
  const enteringForFollowRef = useRef(entering);
  enteringForFollowRef.current = entering;
  const followStateRef = useRef({
    last: 0,
    moving: false,
    facingDir: 1 as 1 | -1,
    facingAt: 0,
  });
  const rootCacheRef = useRef<{ rect: DOMRect | null; at: number }>({ rect: null, at: 0 });

  const stepFollow = useCallback(
    (now: number) => {
      const walker = walkerRef.current;
      if (!walker || enteringForFollowRef.current) return;
      const pose = latestPenPose(actorId);
      if (!pose) return;
      const cfg = cfgRef.current;
      const state = followStateRef.current;
      const dt = state.last > 0 ? Math.min(200, Math.max(8, now - state.last)) : 16;
      state.last = now;

      // 舞台几何缓存 1s 一刷新（窗口 resize 会触发重渲染 + effect 重启）
      const cache = rootCacheRef.current;
      if (!cache.rect || now - cache.at > 1000) {
        const root = (stageRef.current?.closest(".vx-stage") ??
          stageRef.current) as HTMLElement | null;
        rootCacheRef.current = { rect: root ? root.getBoundingClientRect() : null, at: now };
      }
      const rootRect = rootCacheRef.current.rect;
      if (!rootRect) return;
      const ih = window.innerHeight;
      const gap = ih - rootRect.bottom;
      const feet = feetRange();
      const desiredX = clampToRange(pose.x * cfg.stageWidth - cfg.half, cfg.leftLimit, cfg.roamMax);
      const desiredB = clampToRange(feetViewportPx(pose.lane, ih) - gap, feet.min, feet.max);

      // 首帧：直接落在权威位置上（空降入场也从这个点落）
      if (!spawnedRef.current) {
        spawnedRef.current = true;
        livePosRef.current = desiredX;
        liveBottomRef.current = desiredB;
        posRef.current = desiredX;
        walker.style.left = `${desiredX}px`;
        walker.style.bottom = `${desiredB}px`;
        return;
      }

      let curX = livePosRef.current;
      let curB = liveBottomRef.current;
      const dist = Math.hypot(desiredX - curX, desiredB - curB);
      const dxBefore = desiredX - curX;
      if (dist > 320) {
        // 极端跳变（长时间后台 + 广播间断）：吸附，别冲刺
        curX = desiredX;
        curB = desiredB;
      } else if (dist > 0.4) {
        const k = 1 - Math.exp(-dt / 170);
        curX += (desiredX - curX) * k;
        curB += (desiredB - curB) * k;
      }
      livePosRef.current = curX;
      liveBottomRef.current = curB;
      posRef.current = curX;
      walker.style.left = `${curX}px`;
      walker.style.bottom = `${curB}px`;

      /*
       * 朝向：带迟滞。微小位移里的噪声不能让猪"倒着走"：
       * 位移超过 4px、且距上次翻转 ≥300ms，才认这个方向。
       */
      const movingNow = dist > 3.5;
      if (movingNow) {
        const dir: 1 | -1 = dxBefore > 0 ? 1 : -1;
        if (dir !== state.facingDir && Math.abs(dxBefore) > 4 && now - state.facingAt > 300) {
          state.facingDir = dir;
          state.facingAt = now;
          setFacing(dir === -1);
        }
      }
      if (movingNow !== state.moving) {
        state.moving = movingNow;
        setRemoteMoving(movingNow);
      }
    },
    [actorId, setFacing, feetRange],
  );

  useEffect(() => {
    if (!following || stageWidth <= 0) return;
    followStateRef.current.last = 0;
    return registerPigFollower(actorId, stepFollow);
  }, [following, stageWidth, actorId, stepFollow]);

  /*
   * 自由漫步：每次随机挑一个离当前位置足够远的点（四面八方都可能），
   * 两段坐标（left / bottom）一起线性挪过去，到了就地歇一会儿再挑下一个。
   *
   * 关键：**起点永远取采样到的当前位置**——动画被 cancel 后读样式
   * 只能读到旧起点（历史 bug），采样循环维护的 live 值才是真相。
   */
  useEffect(() => {
    const walker = walkerRef.current;
    if (!walker || !walking || stageWidthRef.current <= 0) return;

    const { leftLimit: lo, roamMax: hi } = cfgRef.current;
    const { min: bLo, max: bHi } = feetRange();
    // 以"此刻真实站的地方"为起点（空降落地后就是落点）
    const fromX = clampToRange(livePosRef.current, lo, hi);
    const fromB = clampToRange(liveBottomRef.current, bLo, bHi);
    posRef.current = fromX;

    // 目标：随机一点，既要离自己够远，也尽量别贴着别的猪（试 8 次取最优）
    const others = otherCenters();
    let toX = fromX;
    let toB = fromB;
    for (let tries = 0; tries < 8; tries += 1) {
      toX = lo + Math.random() * Math.max(1, hi - lo);
      toB = bLo + Math.random() * Math.max(1, bHi - bLo);
      const awayFromSelf = Math.hypot(toX - fromX, (toB - fromB) * 1.6) > Math.max(80, (hi - lo) * 0.22);
      const awayFromOthers = others.every(
        (o) => Math.hypot(o.x - toX, (o.b - toB) * 1.6) >= 110,
      );
      if (awayFromSelf && awayFromOthers) break;
    }
    const distance = Math.hypot(toX - fromX, (toB - fromB) * 1.6);

    if (distance < 8) {
      // 真的没地方可走（场地太小）：歇一下再看，别空转
      const idle = window.setTimeout(() => setRestKey((n) => n + 1), 1200);
      return () => window.clearTimeout(idle);
    }

    // 慢悠悠：约 70px/s
    const ms = Math.max(2600, (distance / 70) * 1000);
    setFacing(toX < fromX);

    const anim = walker.animate(
      [
        { left: `${fromX}px`, bottom: `${fromB}px` },
        { left: `${toX}px`, bottom: `${toB}px` },
      ],
      { duration: ms, easing: "linear", fill: "forwards" },
    );
    playerRef.current = anim;
    segRef.current = { fromX, fromB, toX, toB, player: anim };
    let restTimer = 0;
    anim.onfinish = () => {
      livePosRef.current = toX;
      liveBottomRef.current = toB;
      if (walkerRef.current) {
        walkerRef.current.style.left = `${toX}px`;
        walkerRef.current.style.bottom = `${toB}px`;
      }
      playerRef.current = null;
      segRef.current = null;
      // 各头猪歇的时长不同，看起来才不像排队
      const rest = 1400 + Math.random() * 3000;
      restTimer = window.setTimeout(() => setRestKey((n) => n + 1), rest);
    };

    return () => {
      window.clearTimeout(restTimer);
      anim.cancel();
      playerRef.current = null;
      segRef.current = null;
      /*
       * 这里**不要**去读样式来恢复位置：
       * 动画一被 cancel，计算值立刻回落到 inline 的旧值（也就是起点），
       * 读出来的必然是错的。正确位置由采样循环维护在 live refs 里。
       */
    };
    // walking 与 restKey 是唯一的开关
  }, [walking, restKey, setFacing, otherCenters]);

  /*
   * 窗口缩放时把猪钳回新的活动范围（横向 + 纵深）。
   * 走动动画只在出发那一刻算一次边界；窗口缩小后旧位置可能越界，
   * 采样循环只改数字不移动 DOM，所以要在这里把 DOM 一并拽回来。
   */
  const prevSizeRef = useRef({ width: stageWidth, height: stageHeight });
  useEffect(() => {
    const prev = prevSizeRef.current;
    if (prev.width === stageWidth && prev.height === stageHeight) return;
    prevSizeRef.current = { width: stageWidth, height: stageHeight };
    const walker = walkerRef.current;
    if (!walker) return;
    const { leftLimit: lo, roamMax: hi } = cfgRef.current;
    const feetBand = feetRange();
    const px = clampToRange(livePosRef.current, lo, hi);
    const pb = clampToRange(liveBottomRef.current, feetBand.min, feetBand.max);
    livePosRef.current = px;
    liveBottomRef.current = pb;
    posRef.current = px;
    playerRef.current?.cancel();
    playerRef.current = null;
    segRef.current = null;
    walker.style.left = `${px}px`;
    walker.style.bottom = `${pb}px`;
    if (walking) setRestKey((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageWidth, stageHeight, feetRange]);

  // 跑向蔬菜：横向对准菜，纵深也挪到菜落的那个深度，5 秒内赶到正好开吃
  useEffect(() => {
    const walker = walkerRef.current;
    if (!walker || action !== "eat" || phase !== "approach") return;
    if (!targetX || stageWidth <= 0) return;

    const cfg = cfgRef.current;
    const targetXpx = clampToRange(targetX.x * stageWidth - cfg.half, cfg.leftLimit, cfg.rightLimit);
    const feetNow = feetRange();
    const targetB = clampToRange(targetX.bottomPx - 4, feetNow.min, feetNow.max);
    const fromX = clampToRange(livePosRef.current, cfg.leftLimit, cfg.rightLimit);
    const fromB = clampToRange(liveBottomRef.current, feetNow.min, feetNow.max);
    playerRef.current?.cancel();
    segRef.current = null;

    setFacing(targetXpx < fromX);

    // 剩下的时间刚好用掉"走向蔬菜"那一段，于是走到时正好开始吃
    const remain = EAT_APPROACH_MS;
    const anim = walker.animate(
      [
        { left: `${fromX}px`, bottom: `${fromB}px` },
        { left: `${targetXpx}px`, bottom: `${targetB}px` },
      ],
      { duration: remain, easing: "ease-in-out", fill: "forwards" },
    );
    playerRef.current = anim;
    segRef.current = { fromX, fromB, toX: targetXpx, toB: targetB, player: anim };
    anim.onfinish = () => {
      livePosRef.current = targetXpx;
      liveBottomRef.current = targetB;
      posRef.current = targetXpx;
      if (walkerRef.current) {
        walkerRef.current.style.left = `${targetXpx}px`;
        walkerRef.current.style.bottom = `${targetB}px`;
      }
      playerRef.current = null;
      segRef.current = null;
    };
    return () => {
      anim.cancel();
      playerRef.current = null;
      segRef.current = null;
    };
  }, [action, phase, targetX, stageWidth, setFacing, feetRange]);

  // 位置上报已经并进上面的采样循环（每帧一次，比原来的 1.5 秒轮询准确得多），
  // 这里不再需要单独一套。

  const style = useMemo(
    () =>
      ({
        "--vx-pig-size": `${size}px`,
        // 纵向位置完全由 JS 控制 walker.bottom，槽位本身不再额外垫高
        "--vx-pig-bottom": "0px",
        "--vx-pig-fallback-x": `${(0.14 + 0.1 / Math.max(1, total)).toFixed(4)}`,
        "--vx-depth": depth.toFixed(3),
        "--vx-tag-top": `${Math.round(52 + size * 0.06)}%`,
      }) as CSSProperties,
    [size, total, depth],
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
        <div className="vx-pig-walker" ref={walkerRef} style={{ left: `${leftLimit}px`, bottom: `${laneBottom}px` }}>
          <div className="vx-pig-flip" ref={flipRef}>
            {/* 落地阴影跟着猪走 */}
            <span className="vx-pig-shadow" aria-hidden="true" />

            <div
              ref={bumpRef}
              className={`vx-pig${entering ? " vx-pig-entering" : ""}${reaction?.kind === "hoist" ? " vx-pig-hoisted" : ""}${walking ? " vx-pig-walking" : ""}${frontPose ? " vx-pig-speaking" : ""}${sleeping && !reacting ? " vx-pig-sleeping" : ""}${busy ? ` vx-pig-action-${action} vx-pig-phase-${phase}` : ""}`}
            >
              {/*
                精灵状态机（优先级从上到下）：
                空降入圈 → 吊起来 → 互动反应 → 吃/拉的动作分段 → 睡觉 → 蹦迪（说话）
                → 走路 → 待机。素材都是 3D 模型生成的绿幕序列帧，抠好底、
                统一 256px；单次动作靠状态窗口（约 3.2s）截断循环播放时长。
                下落/吊起动画挂在容器（.vx-pig）上：名字牌跟着飞、
                影子留在地上（"离地感"的来源）。
              */}
              {entering ? (
                <img src={pigJoinUrl} className="vx-pig-sprite" alt="" aria-hidden="true" />
              ) : reaction?.kind === "hoist" ? (
                <img src={pigHoistUrl} className="vx-pig-sprite" alt="" aria-hidden="true" />
              ) : reaction && REACT_SRC[reaction.kind] ? (
                <img src={REACT_SRC[reaction.kind]} className="vx-pig-sprite" alt="" aria-hidden="true" />
              ) : action === "eat" ? (
                phase === "approach" ? (
                  // 跑向食物：快跑猪冲刺
                  <img src={pigRunUrl} className="vx-pig-sprite" alt="" aria-hidden="true" />
                ) : (
                  <img src={pigMunchUrl} className="vx-pig-sprite" alt="" aria-hidden="true" />
                )
              ) : sleeping ? (
                <img src={pigSleepUrl} className="vx-pig-sprite" alt="" aria-hidden="true" />
              ) : frontPose ? (
                // 说话：蹦迪猪上线（谁的猪在跳舞，谁就在说话）
                <img src={pigDanceUrl} className="vx-pig-sprite" alt="" aria-hidden="true" />
              ) : walking || remoteMoving ? (
                <img src={pigWalkUrl} className="vx-pig-sprite" alt="" aria-hidden="true" />
              ) : (
                <img src={pigIdleUrl} className="vx-pig-sprite" alt="" aria-hidden="true" />
              )}

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

