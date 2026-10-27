/**
 * 屏幕共享 · SFU 客户端（Cloudflare Realtime SFU）。
 *
 * 设计铁律（docs/archive/SCREENSHARE-PLAN.md §H）：这里的所有 RTCPeerConnection **只连 SFU**，
 * 与语音的 PeerJS 媒体链路零共享——共享链路崩了只表现为"电视雪花"，
 * 绝不触碰语音状态。本文件也不 import 引擎（单向依赖：use-voice 粘合）。
 *
 * 信令路径：前端 → /sfu/*（vite dev/preview 代理到本地 dev-sfu-server.mjs；
 * 线上是同接口的 Cloudflare Worker）→ 补 Bearer 密钥 → rtc.live.cloudflare.com。
 *
 * 协议序列（官方 connection patterns，已逐字核对）：
 * - 发布：sessions/new → tracks/new（带 offer + local 轨）→ setRemote(answer)
 * - 订阅：sessions/new → tracks/new（remote 轨，无 offer）→ 收 SFU offer
 *         → setRemote + createAnswer → renegotiate（交答案）
 */

import { isPenDebug } from "./pen";

/** SFU 代理的根路径（同源，vite 代理转发）。 */
/**
 * SFU 接口基址（按运行环境解析）：
 * - 开发：/sfu → vite 代理到本机 scripts/dev-sfu-server.mjs；
 * - 网页生产：/sfu → Pages 同域（_worker.js 提供，见 worker/_worker.pages.js）；
 * - 桌面端（tauri.localhost）：没有同域服务端，直连 https://5blong.pages.dev/sfu。
 */
export const SFU_BASE = (() => {
  if (import.meta.env.DEV) return "/sfu";
  const host = typeof location !== "undefined" ? location.hostname : "";
  if (host === "tauri.localhost" || host.endsWith(".tauri.localhost")) {
    return "https://5blong.pages.dev/sfu";
  }
  return "/sfu";
})();

/** SFU 视频轨名（全房固定；订阅方按它拉流）。 */
export const TRACK_VIDEO = "screen";
/** SFU 音频轨名（共享系统/标签页声音时才有）。 */
export const TRACK_AUDIO = "screen-audio";

/** P2P 模式的随机会话标识（只在房间内分发，用于把广播状态和 P2P 呼叫对上号）。 */
export function randomSessionId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  } catch {
    return `p2p${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16)}`;
  }
}

// ---------------------------------------------------------------------------
// 画质档位（业主指定：高清 HD 720p60 = 5000 kbps / 超清 1080p60 = 8000 kbps）
// ---------------------------------------------------------------------------

export type ShareQuality = "hd720" | "hd720p30" | "fhd1080" | "fhd1080p30";

export interface ShareQualityPreset {
  label: string;
  /** 采集目标分辨率（ideal，浏览器可能按窗口实际尺寸就近取）。 */
  width: number;
  height: number;
  /** 目标帧率。 */
  fps: number;
  /** 发送端最大码率（bps）。 */
  maxBitrate: number;
}

/**
 * 档位码率：**匹配链路**而不是"堆高"（docs/archive/SCREENSHARE-PERF-PLAN.md §P0-1）。
 *
 * 依据：B站 1080p60 实测只用 2.64 Mbps 就流畅——流畅靠的是编码效率与链路质量，
 * 不是把上限堆到 20 Mbps。上限远超链路可达带宽时，浏览器的拥塞控制反正会把
 * 实际码率压回去，但"上限"仍会干扰编码器前期的码率分配；P2P 模式下更糟：
 * 它会按上限同时对多条上行推流，把家用上行打爆。
 *
 * 取值（业主口径：在"匹配链路"的基线上**统一上浮 2 Mbps**，给运动画面留余量）：
 * 720p60 = 5 Mbps（基线 3M + 2M）、1080p60 = 8 Mbps（基线 6M + 2M）。
 * 仍远低于原先的 8M / 20M，不会把上行打爆。
 */
export const SHARE_QUALITY_PRESETS: Record<ShareQuality, ShareQualityPreset> = {
  /*
   * 标签只写"清晰度 + 分辨率"：帧率/码率由菜单的第二行单独给。
   * 原来标签里也带 fps（"高清 720p·60"），下面一行又是 "60fps · 5000k"，
   * 同一件事写两遍，230px 宽的卡片里还把它挤成三行（业主截图）。
   */
  hd720: { label: "高清 720p", width: 1280, height: 720, fps: 60, maxBitrate: 5_000_000 },
  /*
   * 30fps 档（对齐 Piik 的档位表）：看文档/PPT/网页时 60fps 毫无收益，
   * 却要多花一倍码率。弱网或观众多时选这个，房主上行能省一半。
   */
  hd720p30: { label: "高清 720p", width: 1280, height: 720, fps: 30, maxBitrate: 3_000_000 },
  fhd1080: { label: "超清 1080p", width: 1920, height: 1080, fps: 60, maxBitrate: 12_000_000 },
  fhd1080p30: { label: "超清 1080p", width: 1920, height: 1080, fps: 30, maxBitrate: 5_000_000 },
};

/**
 * 抖动缓冲目标（ms），按链路分级（docs/archive/SCREENSHARE-PERF-PLAN.md §P0-5）。
 *
 * 原先 P2P 与 SFU 一律 4000ms（规范上限），等于给"同城直连"也强加 4 秒排队，
 * 围炉看屏会对不上嘴。直连 RTT 通常 <50ms，600ms 足够吸收抖动；SFU 多为跨境
 * 转发，保留大缓冲换平滑（这类场景延迟不敏感）。
 */
export const JITTER_BUFFER_MS = {
  /** P2P 的**上限**（详见 JITTER_ADAPTIVE_MS：实际取值在 150~1200ms 间自适应）。 */
  p2p: 1200,
  sfu: 3000,
} as const;

/**
 * P2P 抖动缓冲的自适应区间（ms）。
 *
 * 固定的 600ms 是个折中值：同城直连嫌大（白等半秒、围炉对不上嘴），
 * 跨城/移动网络又可能不够（一抖就卡顿）。改成按**实测抖动**动态取值：
 * 目标 ≈ 4 × 抖动，夹在 150~1200ms 之间（见 `jitterBufferTargetFor`）。
 * SFU 是跨境转发、延迟不敏感，仍用固定的 `JITTER_BUFFER_MS.sfu` 换平滑。
 */
export const JITTER_ADAPTIVE_MS = { min: 150, max: 1200, interval: 2500 } as const;

/**
 * 观众端"延迟换稳定"的档位（2026-10-22）。
 *
 * 抖动缓冲本质就是"多等一会儿，换不卡"。三档的取舍：
 * - low      ≤0.5 秒：看操作/游戏跟手，但抖一下就花屏；
 * - balanced 自适应：按实测抖动在 150~1200ms 之间调（默认，多数人够用）；
 * - smooth   ≥1.5 秒：基本不卡，代价是明显滞后（看视频/直播无感）。
 *
 * ⚠️ 加延迟必须**画面和共享声音一起加**：只延迟画面会让声音先到，
 * 变成"口型对不上"。下面的 applyReceiverJitter 就是成对下发的。
 */
export type ShareLatency = "low" | "balanced" | "smooth";

/** P2P 用的自适应区间（low/smooth 也走同一个 tuner，只是区间不同）。 */
export function jitterTargetFor(mode: ShareLatency): { min: number; max: number } {
  switch (mode) {
    case "low":
      return { min: 120, max: 400 };
    case "smooth":
      return { min: 1500, max: 2000 };
    default:
      return { min: JITTER_ADAPTIVE_MS.min, max: JITTER_ADAPTIVE_MS.max };
  }
}

/** SFU 用的固定目标（跨境转发，延迟本身就不敏感）。 */
export function jitterFixedFor(mode: ShareLatency): number {
  switch (mode) {
    case "low":
      return 800;
    case "smooth":
      return 4500;
    default:
      return JITTER_BUFFER_MS.sfu;
  }
}

/**
 * 把"画面 + 共享声音"成对设成同一个抖动缓冲目标。
 *
 * 只设视频会声画不同步；只设音频又会把语音房的语音无故加延迟——
 * 所以这里只处理这条**画面 PC** 上的 receiver（语音是各自独立的 PC）。
 */
export function applyReceiverJitter(pc: RTCPeerConnection, targetMs: number, onlyKinds?: string[]): void {
  for (const receiver of pc.getReceivers()) {
    const kind = receiver.track?.kind;
    if (!kind) continue;
    if (onlyKinds && !onlyKinds.includes(kind)) continue;
    try {
      receiver.jitterBufferTarget = targetMs;
    } catch {
      /* 个别实现不支持时忽略 */
    }
  }
}

/**
 * 由实测抖动（秒）算抖动缓冲目标（ms）。纯函数，便于把取值边界钉在单测里。
 *
 * 取 4 倍抖动：缓冲只要盖住"抖动的峰-峰波动"即可，官方 W3C 示例也是这个量级；
 * 拿不到抖动读数（0/NaN）时取**下限**——宁可让画面更跟手。
 */
export function jitterBufferTargetFor(
  jitterSeconds: number,
  min: number = JITTER_ADAPTIVE_MS.min,
  max: number = JITTER_ADAPTIVE_MS.max,
): number {
  if (!Number.isFinite(jitterSeconds) || jitterSeconds <= 0) return min;
  const target = Math.round(jitterSeconds * 1000 * 4);
  return Math.min(max, Math.max(min, target));
}

/**
 * 给接收端挂"自适应抖动缓冲"：每 `interval` 毫秒读一次 inbound-rtp 的实测 jitter，
 * 换算成目标值下发到所有 receiver。返回停止函数（连接关闭时调用）。
 *
 * 只作用于**接收方向**（P2P 观众端、以及共享者本机看不到的 SFU 链路不用它）。
 */
export function createJitterBufferTuner(
  pc: RTCPeerConnection,
  options: { minMs?: number; maxMs?: number; intervalMs?: number } = {},
): () => void {
  const minMs = options.minMs ?? JITTER_ADAPTIVE_MS.min;
  const maxMs = options.maxMs ?? JITTER_ADAPTIVE_MS.max;
  let stopped = false;

  const apply = (targetMs: number) => {
    if (stopped) return;
    /*
     * 画面和共享声音**成对**下发同一个目标值：
     * 只给视频排队会让声音先到（口型对不上）；只给音频排队又白加延迟。
     * 语音房的声音走各自的 PC，不受这里影响。
     */
    applyReceiverJitter(pc, targetMs);
  };

  const tick = async () => {
    if (stopped || pc.connectionState === "closed") return;
    let jitter = 0;
    try {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && (report as { kind?: string }).kind === "video") {
          const value = (report as { jitter?: number }).jitter;
          if (typeof value === "number" && value > jitter) jitter = value;
        }
      });
    } catch {
      return; // 连接关闭后的取数失败
    }
    apply(jitterBufferTargetFor(jitter, minMs, maxMs));
  };

  apply(minMs);
  const timer = window.setInterval(() => void tick(), options.intervalMs ?? JITTER_ADAPTIVE_MS.interval);
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}

/**
 * P2P 模式下"每路画面"的码率上限。
 *
 * 共享者要同时向 N 个观众各推一份（上行 ×N），不做分摊就是把家用上行打爆。
 * 下限 1.2 Mbps 兜住可看性——观众再多应该切 SFU，而不是继续摊薄。
 * （下限不随档位同步上浮：它是"分摊后别低于可看线"的保底，抬高了反而会让
 *  多人场景每路都超过档位本身，等于绕过分摊、把上行重新打爆。）
 */
/**
 * P2P 共享时每个观众分到的上行码率。
 *
 * 两个约束同时成立才合理：
 * 1. **不低于 1.2 Mbps**（再低就看不清文字，这是"保底"的意义）；
 * 2. **总上行不被地板顶爆**——12 位观众 × 1.2 Mbps = 14.4 Mbps，
 *    家用上行根本给不出（房间上限已提到 13 人，这条现在真的会踩到）。
 * 所以再按"总预算 12 Mbps"反推每人上限，取两者较小值。
 *
 * 注：观众 >4 时默认走 SFU（见 autoTransportFor），这条只在
 * "手动选 P2P + 很多人看"时才生效。
 */
export const P2P_TOTAL_UPLINK_BUDGET = 12_000_000;

export function perViewerBitrate(quality: ShareQuality, viewers: number): number {
  const cap = SHARE_QUALITY_PRESETS[quality].maxBitrate;
  const n = Math.max(1, Math.floor(viewers));
  const fairShare = Math.round(cap / n);
  const budgetPerViewer = Math.round(P2P_TOTAL_UPLINK_BUDGET / n);
  const floor = Math.min(1_200_000, budgetPerViewer);
  return Math.max(floor, Math.min(fairShare, budgetPerViewer));
}

/**
 * 分辨率降级阶梯（`scaleResolutionDownBy` 取值）。
 *
 * 带宽不足时**降分辨率**、而不是让编码器一味压质量——"画面小一点但干净"
 * 远比"1080p 满屏马赛克"耐看（这也是 B站 ABR 的选择）。
 * 1080p 起点换算：1 → 1080p、1.5 → 720p、2 → 540p、2.85 → 380p。
 */
export const RESOLUTION_LADDER = [1, 1.5, 2, 2.85] as const;

/** 阶梯档位的可读标签（界面提示用）。 */
export const RESOLUTION_LADDER_LABEL = ["原始", "720p", "540p", "380p"] as const;

// ---------------------------------------------------------------------------
// 降档策略：帧率阶梯 + 观众偏好（清晰优先 / 流畅优先）
// ---------------------------------------------------------------------------

/**
 * 帧率阶梯（fps）。
 *
 * 屏幕内容多半是**准静态**的（文档、PPT、代码、桌面），30 帧在阅读时几乎无感，
 * 所以链路吃紧时应当**先让帧率、后让分辨率**——省下的码率全留给清晰度，
 * 比"1080p 满屏马赛克"耐看得多（这也是 B站 ABR 的选择）。
 */
export const FPS_LADDER = [60, 45, 30, 24] as const;

/** 观众端画质偏好：自动 / 清晰优先 / 流畅优先。 */
export type ScreenViewPreference = "auto" | "detail" | "motion";

/** 一个降档档位：分辨率阶梯下标 + 目标帧率。 */
export interface TunePoint {
  /** `RESOLUTION_LADDER` 下标（0 = 原分辨率）。 */
  step: number;
  fps: number;
}

/**
 * 由"观众偏好"生成**降档序列**（索引 0 = 最好，越大越省）。
 *
 * 三种策略（都从"原分辨率 + 最高帧率"出发）：
 * - `auto`：帧率先让到 30（60→45→30），再逐档降分辨率，最后帧率再让到 24；
 * - `detail`：先保清晰——帧率一路让到 24，再降分辨率；
 * - `motion`：先保帧率——分辨率逐档降到底，帧率只让到 30（不再往下）。
 *
 * 抽成纯函数：降档顺序是"画质观感"的核心策略，必须能用单测钉住，
 * 不能散落在定时器回调里靠肉眼验证。
 */
export function tuneLadder(preference: ScreenViewPreference, maxFps: number): TunePoint[] {
  const cap = Number.isFinite(maxFps) && maxFps > 0 ? Math.round(maxFps) : 60;
  const rungs = [...new Set([...FPS_LADDER.filter((fps) => fps < cap), cap])].sort((a, b) => b - a);
  const best = rungs[0]!;
  const worst = rungs[rungs.length - 1]!;
  const last = RESOLUTION_LADDER.length - 1;
  const points: TunePoint[] = [];
  if (preference === "motion") {
    // 保帧率：分辨率逐档降到底，帧率最低只让到 30
    for (let step = 0; step <= last; step += 1) points.push({ step, fps: best });
    for (const fps of rungs) if (fps < best && fps >= 30) points.push({ step: last, fps });
  } else if (preference === "detail") {
    // 保清晰：帧率先让到最低，再降分辨率
    for (const fps of rungs) points.push({ step: 0, fps });
    for (let step = 1; step <= last; step += 1) points.push({ step, fps: worst });
  } else {
    // 自动：帧率先让到 30（阅读无感的区间），再降分辨率，最后帧率让到最低
    const floor = rungs.filter((fps) => fps >= 30);
    const mid = floor[floor.length - 1] ?? best;
    for (const fps of floor) points.push({ step: 0, fps });
    for (let step = 1; step <= last; step += 1) points.push({ step, fps: mid });
    if (worst < mid) points.push({ step: last, fps: worst });
  }
  // 去掉连续重复点（例如档位少的组合），保证每一步都真的变了什么
  return points.filter(
    (point, index) =>
      index === 0 || point.step !== points[index - 1]!.step || point.fps !== points[index - 1]!.fps,
  );
}

/** 在阶梯里找与目标档位最接近的下标（切换偏好时保持大致画质，避免跳变）。 */
export function nearestLadderIndex(ladder: TunePoint[], point: TunePoint): number {
  let bestIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [index, candidate] of ladder.entries()) {
    const score = Math.abs(candidate.step - point.step) * 1000 + Math.abs(candidate.fps - point.fps);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/**
 * SFU simulcast 三档（f/h/q）的码率分配（bps）。
 *
 * 原实现是"逐层减半"（8M → 4M → 2M）——问题出在 **q 层**：它被缩到 1/4 分辨率，
 * 2 Mbps 却仍按"够大"的路数让 SFU 在上面放大 4 倍，观众端看到的就是马赛克。
 * 改成按"层该有的像素量"配：f = 档位上限、h ≈ f×31%（上限 2.5M）、q ≈ h/3（上限 800k）。
 * 1080p 档即 8M / 2.48M / 800k，与直播平台的层配比一致。
 */
export function simulcastLayerBitrates(baseBitrate: number): { f: number; h: number; q: number } {
  const f = Math.max(150_000, Math.round(baseBitrate));
  const h = Math.max(150_000, Math.min(2_500_000, Math.round(f * 0.31)));
  const q = Math.max(120_000, Math.min(800_000, Math.round(h / 3)));
  return { f, h, q };
}

/**
 * 观众端"当前订阅到哪一层"的可读标签：用发布档位高度 ÷ 实际收到高度 估算层号
 * （f=1×、h=2×、q=4×）。偏差过大时返回 null（不猜、不误导）。
 */
export function simulcastLayerLabel(sourceHeight: number, receivedHeight: number): string | null {
  if (!(sourceHeight > 0) || !(receivedHeight > 0)) return null;
  const ratio = sourceHeight / receivedHeight;
  const layers: readonly (readonly [number, string])[] = [
    [1, "f 满档"],
    [2, "h 半档"],
    [4, "q 省流"],
  ];
  let best = layers[0]!;
  for (const layer of layers) {
    if (Math.abs(layer[0] - ratio) < Math.abs(best[0] - ratio)) best = layer;
  }
  return Math.abs(best[0] - ratio) > best[0] * 0.35 ? null : best[1];
}

/**
 * 把多位观众的偏好聚合成轨道的 `contentHint`：**只要有一位要"流畅优先"就按
 * motion 走**。轨道只有一个 hint，不能逐人不同；宁可让"清晰优先"那位掉几帧，
 * 也不要让"流畅优先"那位卡住（卡顿的观感损失更大，且对方是明确提过要求的人）。
 */
export function screenHintFor(
  prefs: Iterable<ScreenViewPreference>,
): "motion" | "detail" | "" {
  /*
   * ⚠️ 这个返回值决定"带宽一紧，浏览器先砍什么"：
   *   detail = 保住分辨率、**砍帧率**（适合看文档/代码）
   *   motion = 保住帧率、降低分辨率（适合游戏/视频）
   *
   * 原来的实现：只要没有观众选「流畅优先」就返回 detail —— 也就是**默认全是 detail**。
   * 后果（2026-10-25 实测）：Apex 共享 + 链路丢包 5%，浏览器的拥塞控制一压码率，
   * detail 策略就把帧率砍到 **2 fps**，分辨率停在 1280×720、码率 571kbps，
   * 观众看到的就是"又卡又糊"。CPU 是 7800X3D，根本不是算力问题。
   *
   * 现在：有人要流畅 → motion；**所有观众都明确要清晰**才 detail；
   * 只要有一个是「自动」，就不设 contentHint（空串），交给浏览器自己平衡。
   */
  let hasMotion = false;
  let hasDetail = false;
  let hasAuto = false;
  for (const pref of prefs) {
    if (pref === "motion") hasMotion = true;
    else if (pref === "detail") hasDetail = true;
    else hasAuto = true;
  }
  if (hasMotion) return "motion";
  if (hasDetail && !hasAuto) return "detail";
  return "";
}

/**
 * 观众偏好 → SFU 订阅层：清晰优先/自动都取满档 f，流畅优先退半档 h。
 * （q 档只有 1/4 分辨率，文字会糊，不作为观众主动选择的目标。）
 */
export function preferredRidFor(pref: ScreenViewPreference): "f" | "h" {
  return pref === "motion" ? "h" : "f";
}

/**
 * P2P / SFU 传输方式的自动选择（docs/archive/SCREENSHARE-PERF-PLAN.md §P1-11）。
 *
 * P2P 的上行是"每路码率 × 观众数"：观众不多时直连最省事、画质最好（走本地运营商
 * 互联，延迟低）；观众多到一定程度家宽上行会被打爆，必须切 SFU 转发
 * （上行从 N 路变成 1 路，由 SFU 分发）。
 *
 * 阈值由业主定：**观众 ≤4 走直连**（2026-10-14 从 ≤2 上调——实测共享端上行余量
 * 有 14 Mbps，8 Mbps 档位摊到 4 路仍够；且直连画质明显优于绕境外的 SFU）。
 * 观众的显式选择永远优先，"auto" 才按人数决定。
 */
export function autoTransportFor(
  preference: "p2p" | "sfu" | "auto",
  memberCount: number,
): { transport: "p2p" | "sfu"; reason: string } {
  if (preference === "p2p") return { transport: "p2p", reason: "你选了直连" };
  if (preference === "sfu") return { transport: "sfu", reason: "你选了 SFU 转发" };
  const viewers = Math.max(0, memberCount - 1);
  /*
   * 2026-10-21 从 ≤4 收到 ≤2（对齐 Piik 的端点出站配额思路）：
   * 每一路直连都是一份完整上行。4 个观众按 1080p60 的 8Mbps 上限就是 32Mbps，
   * 家用上行必炸，表现为"房主自己卡、观众全糊"。3 个观众起改走 SFU。
   */
  if (viewers <= 2) return { transport: "p2p", reason: `观众 ${viewers} 人，直连画质最好` };
  return { transport: "sfu", reason: `观众 ${viewers} 人，直连上行会打爆，自动走 SFU` };
}

/** getDisplayMedia 选择器提示项（Chromium 支持；TS 类型未收录，运行时透传）。
 *  注意：preferCurrentTab 与 selfBrowserSurface:"exclude" 互斥
 *  （Chromium 抛 TypeError: Self-contradictory configuration），
 *  不能同时开——这里保留"剔除自己页面"（防把房间网页共享进房间）。
 *  `withSystemAudio=false`（客户端走内置 WASAPI 采集时）：选择器里不再出现
 *  "共享系统音频"开关——从源头绕开 Chromium 在多声道设备上回环失败的坑。 */
export function pickerHints(withSystemAudio = true): Record<string, unknown> {
  return {
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    monitorTypeSurfaces: "include",
    systemAudio: withSystemAudio ? "include" : "exclude",
  };
}

/** getDisplayMedia 的视频约束（按档位生成；ideal+max 双限，4K 显示器不会被原样采集）。 */
export function shareVideoConstraints(quality: ShareQuality): MediaTrackConstraints {
  const preset = SHARE_QUALITY_PRESETS[quality];
  return {
    width: { ideal: preset.width, max: preset.width },
    height: { ideal: preset.height, max: preset.height },
    frameRate: { ideal: preset.fps, max: preset.fps },
  };
}

export interface ScreenSenderOptions {
  /** 码率上限覆盖（P2P 按观众数分摊时用；缺省取档位值）。 */
  maxBitrate?: number;
  /** 分辨率缩放（降级阶梯；1 = 原分辨率）。 */
  scaleResolutionDownBy?: number;
  /** 帧率上限覆盖（CPU 受限时降到 30 帧）。 */
  maxFramerate?: number;
}

/**
 * 把档位下发到发送端（码率 / 帧率上限 / 分辨率缩放）。返回是否全部落盘。
 *
 * 两个已核实的事实（docs/archive/SCREENSHARE-PERF-PLAN.md §P0-3）：
 * - `degradationPreference` 已废弃、Chrome 不支持，写在 `encodings[0]` 里是**空转**
 *   （原代码就是这么写的，等于什么都没设）；
 * - 真正决定"带宽不足时降什么"的是轨道上的 `contentHint`（见 `publishScreen`），
 *   这里只负责上限与缩放。
 *
 * 返回 `Promise<boolean>`：协商时序不当时 `setParameters` 会被浏览器拒绝。
 * 原实现用 `.catch(() => {})` 静默吞掉，参数可能压根没生效而界面上完全看不出来
 * （这就是"选了超清却没有任何变化"的观测盲区）。调用方应在连接建立后重试一次。
 */
export async function applyScreenSenderParams(
  pc: RTCPeerConnection,
  quality: ShareQuality,
  options: ScreenSenderOptions = {},
): Promise<boolean> {
  const preset = SHARE_QUALITY_PRESETS[quality];
  const baseBitrate = options.maxBitrate ?? preset.maxBitrate;
  const framerate = options.maxFramerate ?? preset.fps;
  const scale = options.scaleResolutionDownBy ?? 1;
  const senders = pc.getSenders().filter((sender) => sender.track?.kind === "video");
  if (senders.length === 0) return false;
  try {
    await Promise.all(
      senders.map((sender) => {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        if (params.encodings.length > 1) {
          // simulcast 发布：逐层分配码率（层按 rid 顺序 f > h > q）。
          // 保留各层原有的 scaleResolutionDownBy / rid——那是发布时按 rid 定好的
          // 层结构，在这里改掉会把"多档"变成"三档一样大"。
          const tiers = simulcastLayerBitrates(baseBitrate);
          const byRid: Record<string, number> = { f: tiers.f, h: tiers.h, q: tiers.q };
          params.encodings = params.encodings.map((encoding, index) => ({
            ...encoding,
            maxBitrate: byRid[encoding.rid ?? ""] ?? (index === 0 ? tiers.f : index === 1 ? tiers.h : tiers.q),
            maxFramerate: framerate,
            // 语音永远优先于画面：全屏共享（8 Mbps 上行）与语音抢带宽时，
            // 先牺牲画面的清晰度/帧率，绝不让语音断续（P0-6）。
            priority: "low",
          }));
        } else {
          params.encodings[0] = {
            ...params.encodings[0],
            maxBitrate: baseBitrate,
            maxFramerate: framerate,
            scaleResolutionDownBy: scale,
            priority: "low",
          };
        }
        return sender.setParameters(params);
      }),
    );
    return true;
  } catch {
    /* 失败由调用方在连接建立后重试；这里不吞掉"是否成功"这个信息 */
    return false;
  }
}

const ICE_SERVERS: RTCIceServer[] = [
  // Cloudflare 自家 STUN 足够（SFU 本身就是公网可达的，无需打洞）
  { urls: "stun:stun.cloudflare.com:3478" },
];

/** 等待 ICE 候选收集完成（带超时：SFU 不需要完整候选表，0.8s 内有多少用多少）。 */
async function gatherIce(pc: RTCPeerConnection, timeoutMs = 800): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      window.clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = window.setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

/** 等待连接建立（失败/超时抛错，由调用方降级为"电视雪花"）。 */
async function waitConnected(pc: RTCPeerConnection, timeoutMs = 15_000): Promise<void> {
  if (pc.connectionState === "connected") return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`SFU 连接超时（${pc.connectionState}）`));
    }, timeoutMs);
    const onState = () => {
      if (pc.connectionState === "connected") {
        cleanup();
        resolve();
      } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        cleanup();
        reject(new Error(`SFU 连接失败（${pc.connectionState}）`));
      }
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      pc.removeEventListener("connectionstatechange", onState);
    };
    pc.addEventListener("connectionstatechange", onState);
  });
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  // sessions/new 要求**无 body**（空对象会被 400 拒掉），其余端点带 JSON body。
  const hasBody = body !== null && body !== undefined;
  const res = await fetch(`${SFU_BASE}${path}`, {
    method: "POST",
    headers: hasBody ? { "Content-Type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = typeof data["errorDescription"] === "string" ? `：${data["errorDescription"]}` : "";
    throw new Error(`SFU ${path} 失败（${res.status}）${detail}`);
  }
  return data;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// 链路读数（灯箱底部的数据条）
// ---------------------------------------------------------------------------

/** getStats 条目的宽松形状（规范字段很多，这里只取用得到的几个）。 */
export interface StatsEntry {
  type?: string;
  id?: string;
  kind?: string;
  codecId?: string;
  mimeType?: string;
  payloadType?: number;
  [key: string]: unknown;
}

/** 上一次采样的码率基线（跨两次采样算差值）。 */
export interface RateSample {
  bytes: number;
  ts: number;
  /**
   * simulcast 时每一层的独立基线（key = rid）。
   *
   * 为什么需要：simulcast 发布会同时产生 **3 条 outbound-rtp**（f/h/q）。
   * 只看第一条会让数据条随机显示某一层——实测里正好显示到 q 层，
   * 于是"发出 353×254 · 480 kbps"被误读成"整条流只有这么糊"。
   */
  layers?: Record<string, RateSample>;
}

/** 一层 simulcast 的读数。 */
export interface ScreenLayerStat {
  rid: string;
  width: number;
  height: number;
  fps: number;
  kbps: number;
}

export interface ScreenStatsSummary {
  /** 这份报告里是"发送端"还是"接收端"（都没有则为 null）。 */
  role: "send" | "recv" | null;
  width: number;
  height: number;
  fps: number;
  /** 实际码率（kbps，两次采样的差值；首帧为 0）。 */
  kbps: number;
  /** 协商到的编码（如 h264 / vp8）。 */
  codec: string;
  /** 编码器/解码器实现名——判断有没有吃到 NVENC / NVDEC 靠它。 */
  implementation: string;
  powerEfficient: boolean;
  /** 发送端：受限原因（none / bandwidth / cpu / other）。 */
  limitation: string;
  /**
   * 链路可用带宽估计（kbps）。
   *
   * 取自 `candidate-pair.availableOutgoingBitrate`——**链路真实容量**。
   * 原实现读的是 `outbound-rtp` 上的同名字段，而 Chrome 不往那里报，
   * 导致发送端永远看不到"可用 XXX kbps"这一项（调参等于闭眼掷骰子）。
   */
  availableKbps: number;
  /** 这条链路实际走通的候选对类型：直连 / 经中继（relay = 走了 TURN 中继）。 */
  linkType: "direct" | "relay" | "unknown";
  /** 发送端：单帧编码耗时（ms）——持续走高＝没吃到硬编。 */
  encodeMs: number;
  /** 接收端：卡顿/冻结计数。 */
  frozen: number;
  /** 接收端：累计丢包率（%）。 */
  lossPct: number;
  /**
   * simulcast 发布时的**逐层读数**（按分辨率从大到小；单档 = 空数组）。
   * 有了它才能回答"码率低在哪一层"——之前数据条随机显示某一层，误导性极强。
   */
  layers: ScreenLayerStat[];
  /** 已经拼好的可显示文本。 */
  text: string;
  sample: RateSample | null;
}

const EMPTY_SUMMARY: ScreenStatsSummary = {
  role: null,
  width: 0,
  height: 0,
  fps: 0,
  kbps: 0,
  codec: "",
  implementation: "",
  powerEfficient: false,
  limitation: "none",
  availableKbps: 0,
  linkType: "unknown",
  encodeMs: 0,
  frozen: 0,
  lossPct: 0,
  layers: [],
  text: "",
  sample: null,
};

const LIMITATION_TEXT: Record<string, string> = {
  none: "不受限",
  bandwidth: "带宽受限",
  cpu: "CPU 受限",
  other: "受限",
};

/**
 * 把一份 getStats 快照压成"一眼能看懂"的一段话（灯箱数据条）。
 *
 * 这是整套优化的**观测前提**：分辨率看编码器实际输出、码率看参数有没有生效、
 * `limitation` 分辨"链路不够"还是"没吃到硬编"、`implementation` 分辨硬编还是软编。
 * 观看者与共享者共用这一条（谁是发送、谁是接收由报告里实际存在的流决定）。
 *
 * 纯函数：只吃 stats 条目数组 + 上一次采样，方便单测（不依赖真实 RTCPeerConnection）。
 */
export function summarizeScreenStats(entries: StatsEntry[], prev: RateSample | null): ScreenStatsSummary {
  const byId = new Map<string, StatsEntry>();
  let fallbackCodec = "";
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
    if (entry.type === "codec" && typeof entry.mimeType === "string") {
      const mime = entry.mimeType.toLowerCase();
      if (mime.startsWith("video/") && !/rtx|red|ulpfec|flexfec/.test(mime)) {
        fallbackCodec = mime.slice("video/".length);
      }
    }
  }

  /*
   * simulcast 发布时同向会有**多条** outbound-rtp（f/h/q 各一条）。原实现取第一条，
   * 于是数据条随机显示到某一层——实测里正好落在 q 层，屏幕上就成了
   * "发出 353×254 · 480 kbps"，看着像整条流都糊透了（其实是三层里最小的那层）。
   * 现在：取**分辨率最高的一条**作代表（= 主层），码率按**所有层求和**（那才是真实上行），
   * 并额外给出逐层读数（`layers`）。
   */
  const videoEntries: StatsEntry[] = [];
  let firstOutbound: StatsEntry | null = null;
  let firstInbound: StatsEntry | null = null;
  for (const entry of entries) {
    if (entry.kind !== "video") continue;
    if (entry.type === "outbound-rtp") {
      videoEntries.push(entry);
      firstOutbound ??= entry;
    } else if (entry.type === "inbound-rtp") {
      videoEntries.push(entry);
      firstInbound ??= entry;
    }
  }
  // 发送/接收方向：有 outbound 就按发送端看（与旧行为一致），否则看 inbound
  if (!firstOutbound && !firstInbound) return EMPTY_SUMMARY;
  const send = firstOutbound !== null;
  const sameDirection = videoEntries.filter((entry) =>
    send ? entry.type === "outbound-rtp" : entry.type === "inbound-rtp",
  );
  // 代表条目 = 分辨率最高的一层（单档时就是它自己）
  const target = sameDirection.reduce<StatsEntry | null>(
    (best, entry) =>
      best === null || num(entry["frameWidth"]) > num(best["frameWidth"]) ? entry : best,
    null,
  );
  if (!target) return EMPTY_SUMMARY;

  // ICE 候选对里藏着两件"链路真相"，而 outbound-rtp 上都没有：
  // ① availableOutgoingBitrate = 链路真实可用带宽（发送端判断"到底够不够"的唯一可靠依据）；
  // ② 本地候选类型 relay = 画面经 TURN 中继（公共免费 TURN 常被限速，
  //    是国内"糊成马赛克"的高频元凶；之前界面完全看不到这一项）。
  let linkType: "direct" | "relay" | "unknown" = "unknown";
  let linkAvailable = 0;
  for (const entry of entries) {
    if (entry.type !== "candidate-pair") continue;
    if (entry["state"] !== "succeeded" && entry["nominated"] !== true) continue;
    const local = byId.get(String(entry["localCandidateId"] ?? ""));
    linkType = local?.["candidateType"] === "relay" ? "relay" : "direct";
    linkAvailable = Math.max(linkAvailable, num(entry["availableOutgoingBitrate"]));
  }

  const codecEntry = target.codecId ? byId.get(String(target.codecId)) : undefined;
  const codec = (codecEntry?.mimeType ? String(codecEntry.mimeType) : "").replace(/^video\//i, "") || fallbackCodec;

  // 逐层读数 + 总码率：单档时 layers 为空、总码率就等于这一条
  const layerSamples: Record<string, RateSample> = {};
  const layers: ScreenLayerStat[] = [];
  let layerBytes = 0;
  for (const [index, entry] of sameDirection.entries()) {
    const bytes = send ? num(entry["bytesSent"]) : num(entry["bytesReceived"]);
    const ts = num(entry["timestamp"]) || Date.now();
    layerBytes += bytes;
    const rid = str(entry["rid"]) || (sameDirection.length > 1 ? `#${index}` : "");
    const previous = rid ? prev?.layers?.[rid] : undefined;
    const layerKbps =
      previous && ts > previous.ts
        ? Math.max(0, Math.round(((bytes - previous.bytes) * 8) / (ts - previous.ts)))
        : 0;
    if (rid) {
      layerSamples[rid] = { bytes, ts };
      layers.push({
        rid,
        width: num(entry["frameWidth"]),
        height: num(entry["frameHeight"]),
        fps: Math.round(num(entry["framesPerSecond"])),
        kbps: layerKbps,
      });
    }
  }
  layers.sort((a, b) => b.width - a.width);

  const bytes = send ? num(target["bytesSent"]) : num(target["bytesReceived"]);
  const ts = num(target["timestamp"]) || Date.now();
  const multiLayer = sameDirection.length > 1;
  const totalBytes = multiLayer ? layerBytes : bytes;
  // 上一次的基线：多档要按层求和，单档用整条
  const prevBytes = multiLayer
    ? prev?.layers
      ? Object.values(prev.layers).reduce((sum, item) => sum + item.bytes, 0)
      : 0
    : (prev?.bytes ?? 0);
  const kbps =
    prev && prevBytes > 0 && ts > prev.ts && totalBytes >= prevBytes
      ? Math.max(0, Math.round(((totalBytes - prevBytes) * 8) / (ts - prev.ts)))
      : 0;
  const sample: RateSample = { bytes: totalBytes, ts, ...(layers.length > 0 ? { layers: layerSamples } : {}) };

  const width = num(target["frameWidth"]);
  const height = num(target["frameHeight"]);
  const fps = Math.round(num(target["framesPerSecond"]));
  const implementation = str(target[send ? "encoderImplementation" : "decoderImplementation"]);
  const powerEfficient = target[send ? "powerEfficientEncoder" : "powerEfficientDecoder"] === true;
  const limitation = send ? str(target["qualityLimitationReason"]) || "none" : "none";
  // 优先 candidate-pair（真实容量）；outbound-rtp 上的同名字段留作老浏览器兜底
  const availableKbps = Math.round((linkAvailable || num(target["availableOutgoingBitrate"])) / 1000);
  const frames = num(target["framesEncoded"]);
  const encodeMs = send && frames > 0 ? Number((num(target["totalEncodeTime"]) / frames * 1000).toFixed(1)) : 0;
  const frozen = num(target["freezeCount"]);
  const packets = num(target["packetsReceived"]);
  const lost = num(target["packetsLost"]);
  const lossPct = !send && packets + lost > 0 ? Number(((lost / (packets + lost)) * 100).toFixed(1)) : 0;

  const parts: string[] = [];
  // 多档（simulcast）时明确标"主层"，并把合计码率放在最前——那是真实上行带宽
  parts.push(
    `${send ? "发出" : "收到"} ${width && height ? `${width}×${height}` : "?"}${multiLayer ? "（主层）" : ""}`,
  );
  parts.push(`${fps || "?"} fps`);
  if (multiLayer) parts.push(`三层合计 ${kbps || "?"} kbps`);
  else parts.push(`${kbps || "?"} kbps`);
  const accel = powerEfficient ? (send ? "硬编" : "硬解") : send ? "软编" : "软解";
  parts.push([codec, implementation, accel].filter(Boolean).join(" ") || "编码器?");
  // 走没走中继直接写在数据条里：中继被限速时，"码率上不去"就不是编码参数能救的
  if (linkType !== "unknown") parts.push(linkType === "relay" ? "经中继" : "直连");
  if (send) {
    if (limitation !== "none") parts.push(LIMITATION_TEXT[limitation] ?? limitation);
    if (encodeMs) parts.push(`编码 ${encodeMs}ms/帧`);
    if (availableKbps) parts.push(`可用 ${availableKbps} kbps`);
  } else {
    if (frozen) parts.push(`卡顿 ${frozen} 次`);
    if (lossPct >= 0.1) parts.push(`丢包 ${lossPct}%`);
  }

  return {
    role: send ? "send" : "recv",
    width,
    height,
    fps,
    kbps,
    codec,
    implementation,
    powerEfficient,
    limitation,
    availableKbps,
    linkType,
    encodeMs,
    frozen,
    lossPct,
    layers,
    text: parts.join(" · "),
    sample,
  };
}

/**
 * 逐层读数的单行文本（灯箱第二行用）：`f 1414×1018 5200k · h 707×509 2100k · q 353×254 400k`。
 * 没有多档时返回空串（界面就不显示第二行）。
 */
export function formatScreenLayers(layers: ScreenLayerStat[]): string {
  if (layers.length < 2) return "";
  return layers
    .map(
      (layer) =>
        `${layer.rid} ${layer.width}×${layer.height} ${layer.kbps || "?"}k${layer.fps ? `@${layer.fps}` : ""}`,
    )
    .join(" · ");
}

/**
 * 这个共享流能不能接"声音电平探针"？
 *
 * 不能：`createMediaStreamSource` 要求流里**至少有一条音轨**，否则直接抛
 * InvalidStateError。而 effect 里抛错在 React 里等于整棵树卸载 ——
 * 2026-10-26 就是它让"共享开始后才进房的人"点开灯箱整窗白屏：
 * 后进者拿到的是画面先到、音轨还没有（或干脆没开声音）的那条流。
 */
export function canProbeShareAudio(stream: MediaStream | null | undefined): boolean {
  return Boolean(stream && stream.getAudioTracks().length > 0);
}

/** 直接吃 RTCStatsReport 的便捷包装（组件里用）。 */
export function summarizeScreenReport(report: RTCStatsReport, prev: RateSample | null): ScreenStatsSummary {
  const entries: StatsEntry[] = [];
  report.forEach((entry) => entries.push(entry as unknown as StatsEntry));
  return summarizeScreenStats(entries, prev);
}

// ---------------------------------------------------------------------------
// 发送端自适应：带宽不足时降分辨率，而不是把画质压成马赛克
// ---------------------------------------------------------------------------

/** 自适应采样间隔。 */
const TUNE_INTERVAL_MS = 3000;
/** 连续几次"受限"才降一档（抗抖动，避免来回跳）。 */
const LIMIT_STRIKES = 2;
/** 连续几次"健康"才回升一档（迟滞，避免振荡）。 */
const RECOVER_SAMPLES = 6;
/**
 * "链路吃紧"的判据：**可用带宽**低于码率上限的这个比例才算不够。
 *
 * 比旧判据（实际码率 < 上限 30%）宽松，且看的是链路真实容量、不是"发出去了多少"。
 */
const CAPACITY_FLOOR = 0.6;

export interface ScreenSenderTunerOptions {
  /** 码率上限（P2P 分摊后的值；缺省取档位值）。 */
  maxBitrate?: number;
  /** 起始阶梯档（0 = 原始分辨率）。仅当没有档位记忆时生效。 */
  startStep?: number;
  /** 是否 simulcast 发布（多档编码时不做"总码率偏低"的推断）。 */
  simulcast?: boolean;
  /** 观众偏好（决定降档顺序，见 tuneLadder）。缺省 auto。 */
  preference?: ScreenViewPreference;
  /**
   * 档位记忆：把当前档位写进 localStorage，下次开播/重连**从上次的档位起步**
   * （而不是每次从 1080p 重新爬），坏链路因此不用再花 ~18 秒才收敛。
   */
  memory?: boolean;
  /** 档位变化回调（界面可提示"已自动降到 720p"）。 */
  onStep?: (point: TunePoint, reason: string) => void;
}

export interface ScreenSenderTuner {
  stop: () => void;
  /** 码率上限变化（观众数增减）时重新下发，**保持当前档位**。 */
  retune: (maxBitrate?: number) => void;
  /** 切换观众偏好：按"最接近当前观感"的档位续走，不跳变。 */
  setPreference: (preference: ScreenViewPreference) => void;
  step: () => number;
  fps: () => number;
  applied: () => number;
}

/** 档位记忆的存储键（与 settings/theme 同一命名空间）。 */
const TUNE_MEMORY_KEY = "5blong:v1:screen-tune";

interface TuneMemory {
  quality: ShareQuality;
  preference: ScreenViewPreference;
  point: TunePoint;
}

function readTuneMemory(quality: ShareQuality, preference: ScreenViewPreference): TunePoint | null {
  try {
    const raw = localStorage.getItem(TUNE_MEMORY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TuneMemory>;
    if (parsed.quality !== quality || parsed.preference !== preference) return null;
    const point = parsed.point;
    if (!point || typeof point.step !== "number" || typeof point.fps !== "number") return null;
    return { step: point.step, fps: point.fps };
  } catch {
    return null;
  }
}

function writeTuneMemory(quality: ShareQuality, preference: ScreenViewPreference, point: TunePoint): void {
  try {
    localStorage.setItem(
      TUNE_MEMORY_KEY,
      JSON.stringify({ quality, preference, point } satisfies TuneMemory),
    );
  } catch {
    /* 存不下也不影响本次生效 */
  }
}

/**
 * 发送端此刻是否"链路吃紧"（该降档）。纯函数，便于把判据钉死在单测里。
 *
 * ① 发送端自述受限（`bandwidth` / `cpu`）→ 是；
 * ② 否则看链路**真实可用带宽**是否明显低于我们要的码率上限（低于 60% 才算）；
 * ③ 两者都拿不到 → **判为不吃紧**（宁可不降档，也不误降）。
 *
 * ⚠️ 绝对不要用"实际码率远低于上限"来反推：静态画面（PPT、看文档、桌面不动）
 * 本来就只产出几百 kbps 且 `limitation === "none"`，那会把"画面没动"读成"带宽不够"，
 * 每 6 秒降一档一路降到底；而回升判据若同样基于码率，静态画面永远不满足 →
 * 掉到最低档再也回不来（实测：2 人 P2P 房 1920×1080 自行走到 674×379）。
 *
 * simulcast 多档发布时不做 ② 的推断：这条链路的容量由 SFU 按观众分层消化，
 * 源头降分辨率会连累所有观众。
 */
export function screenLinkStrained(
  summary: ScreenStatsSummary,
  maxBitrate: number,
  simulcast = false,
): boolean {
  if (summary.limitation === "bandwidth" || summary.limitation === "cpu") return true;
  if (simulcast) return false;
  if (!(maxBitrate > 0) || !(summary.availableKbps > 0)) return false;
  // ⚠️ 单位陷阱：availableKbps 是 kbps，maxBitrate 是 bps，必须统一后再比。
  // 原实现的判据 `summary.kbps < baseBitrate * 0.3` 正是栽在这里——
  // 62 kbps < 8_000_000 bps × 0.3（=2.4 Mbps）**恒为真**，
  // 于是 P2P 发送端开播后每 6 秒无条件降一档，约 20 秒降到底（674×379）。
  return summary.availableKbps * 1000 < maxBitrate * CAPACITY_FLOOR;
}

/**
 * 给一条画面发送链路挂上"自适应降档"（docs/archive/SCREENSHARE-PERF-PLAN.md §P0-4 / §P2-14）。
 *
 * 两条依据：
 * - `outbound-rtp.qualityLimitationReason`（发送端自述）：`bandwidth` 链路不够、
 *   `cpu` 编码器跟不上 —— 都降分辨率（省像素比压质量耐看），`cpu` 时另把帧率压到 30；
 * - `candidate-pair.availableOutgoingBitrate`（链路真实容量）：容量低于上限 60% 才算吃紧。
 *
 * ⚠️ 这里**绝不能**拿"实际码率远低于上限"当判据（原实现就是这么写的）：
 * 静态画面（PPT、看文档、桌面不动）本来就只产出几百 kbps，且此时
 * `limitation === "none"`——它把"画面没动"误读成"带宽不够"，于是每 6 秒降一档、
 * 一路降到底；而回升判据同样基于码率，静态画面永远不满足 →
 * 掉到最低档就再也回不来（实测故障：2 人 P2P 房，1920×1080 自行走到 674×379）。
 *
 * 持续健康：缓慢回升一档（迟滞 6 次采样 ≈ 18s，避免来回跳）。
 * 只在"确实受限"时动，且一次只动一档；`stop()` 后不再改参数。
 */
export function createScreenSenderTuner(
  pc: RTCPeerConnection,
  quality: ShareQuality,
  options: ScreenSenderTunerOptions = {},
): ScreenSenderTuner {
  const preset = SHARE_QUALITY_PRESETS[quality];
  let preference: ScreenViewPreference = options.preference ?? "auto";
  let ladder = tuneLadder(preference, preset.fps);
  let baseBitrate = options.maxBitrate;
  let strikes = 0;
  let healthy = 0;
  let stopped = false;
  let applications = 0;
  let prev: RateSample | null = null;

  // 档位记忆：上次同一档位/偏好停在哪儿，就从哪儿起步（坏链路不用再爬 18 秒）
  const remembered = options.memory === true ? readTuneMemory(quality, preference) : null;
  const startStep = Math.min(Math.max(0, options.startStep ?? 0), RESOLUTION_LADDER.length - 1);
  const startIndex = Math.max(
    0,
    ladder.findIndex((item) => item.step >= startStep),
  );
  let index = remembered ? nearestLadderIndex(ladder, remembered) : startIndex;

  const point = (): TunePoint => ladder[index] ?? { step: 0, fps: preset.fps };

  const apply = () => {
    if (stopped || pc.connectionState === "closed") return;
    const current = point();
    void applyScreenSenderParams(pc, quality, {
      maxBitrate: baseBitrate,
      scaleResolutionDownBy: RESOLUTION_LADDER[current.step]!,
      maxFramerate: current.fps,
    }).then((ok) => {
      if (ok) applications += 1;
    });
  };

  const remember = () => {
    if (options.memory === true) writeTuneMemory(quality, preference, point());
  };

  const tick = async () => {
    if (stopped || pc.connectionState === "closed") return;
    const senders = pc.getSenders().filter((sender) => sender.track?.kind === "video");
    if (senders.length === 0) return;
    let summary: ScreenStatsSummary;
    try {
      summary = summarizeScreenReport(await pc.getStats(), prev);
    } catch {
      return; // 连接关闭后的取数失败：忽略
    }
    if (summary.role !== "send") return;
    prev = summary.sample;

    // 判据抽成纯函数（screenLinkStrained）：让"静态画面不许降档"这条有单测钉住，
    // 不至于哪天又被改回"用实际码率反推链路"。
    if (screenLinkStrained(summary, baseBitrate ?? 0, options.simulcast === true)) {
      healthy = 0;
      strikes += 1;
      if (strikes >= LIMIT_STRIKES && index < ladder.length - 1) {
        index += 1;
        strikes = 0;
        apply();
        remember();
        options.onStep?.(point(), summary.limitation === "cpu" ? "cpu" : "bandwidth");
      }
      return;
    }
    strikes = 0;
    healthy += 1;
    if (healthy >= RECOVER_SAMPLES && index > 0) {
      index -= 1;
      healthy = 0;
      apply();
      remember();
      options.onStep?.(point(), "recover");
    }
  };

  apply();
  remember();
  const timer = window.setInterval(() => void tick(), TUNE_INTERVAL_MS);
  return {
    stop: () => {
      stopped = true;
      window.clearInterval(timer);
    },
    retune: (maxBitrate?: number) => {
      if (typeof maxBitrate === "number") baseBitrate = maxBitrate;
      apply();
    },
    setPreference: (next: ScreenViewPreference) => {
      if (next === preference) return;
      const current = point();
      preference = next;
      ladder = tuneLadder(preference, preset.fps);
      index = nearestLadderIndex(ladder, current);
      strikes = 0;
      healthy = 0;
      apply();
      remember();
    },
    step: () => point().step,
    fps: () => point().fps,
    applied: () => applications,
  };
}

// ---------------------------------------------------------------------------
// 断线自愈：先试 ICE restart，而不是立刻雪花
// ---------------------------------------------------------------------------

export interface ScreenHealOptions {
  /** 连续重启仍失败（彻底断）时回调——界面据此降级为雪花。 */
  onFailed?: () => void;
  /** 需要重拨时回调（共享者侧可重新发起画面呼叫）。 */
  onRetry?: () => void;
  /** 最多重启几次（默认 2 次）。 */
  retries?: number;
}

/**
 * 给画面连接挂"抖动自愈"（docs/archive/SCREENSHARE-PERF-PLAN.md §P2-13）。
 *
 * 原实现把 `disconnected` 直接当断线（雪花/永久冻结），可短暂抖一下 ICE
 * 就能自己恢复。这里：`disconnected` 等 2.5s 仍不通 → `restartIce()`；
 * `failed` 立刻重启；重启后给 6s 观察窗，仍不通则再试；超过次数上限才判定
 * 真断（回调 onFailed）。恢复即清零计数。
 */
export function healScreenConnection(pc: RTCPeerConnection, options: ScreenHealOptions = {}): () => void {
  const maxRestarts = options.retries ?? 2;
  let stopped = false;
  let restarts = 0;
  let pending = 0;

  const clearPending = () => {
    if (pending) {
      window.clearTimeout(pending);
      pending = 0;
    }
  };

  const scheduleRestart = (delay: number) => {
    clearPending();
    pending = window.setTimeout(() => {
      pending = 0;
      if (stopped || pc.connectionState === "closed" || pc.connectionState === "connected") return;
      restarts += 1;
      try {
        pc.restartIce();
      } catch {
        /* 个别实现不支持时忽略，靠下一次观察窗继续判 */
      }
      if (restarts > maxRestarts) {
        options.onFailed?.();
        options.onRetry?.();
        return;
      }
      scheduleRestart(6000);
    }, delay);
  };

  const onState = () => {
    if (stopped) return;
    if (pc.connectionState === "connected") {
      clearPending();
      restarts = 0;
      return;
    }
    if (pc.connectionState === "disconnected") scheduleRestart(2500);
    else if (pc.connectionState === "failed") scheduleRestart(0);
  };

  pc.addEventListener("connectionstatechange", onState);
  return () => {
    stopped = true;
    clearPending();
    pc.removeEventListener("connectionstatechange", onState);
  };
}

// ---------------------------------------------------------------------------
// 发布
// ---------------------------------------------------------------------------

export interface ScreenPublication {
  /** SFU 会话 id：交给房主广播，订阅方据此拉流。 */
  sessionId: string;
  /** 是否带了音频轨。 */
  hasAudio: boolean;
  /**
   * **实际**是否用了 simulcast 多档（可能与请求的相反——有硬件编码器时会被否决，见 publishScreen）。
   * 房主据此广播，订阅端才知道该不该按层拉流。
   */
  simulcast: boolean;
  /** 停止发布（关 PC + 通知 SFU 关轨，尽力而为）。 */
  stop: () => void;
  /** 连接中断回调（watchdog 用，界面上表现为雪花）。 */
  onLost?: () => void;
  /** 发送端连接：灯箱据此显示"发送端自检"（编码分辨率/码率/限流原因/编码器）。 */
  pc: RTCPeerConnection;
}

// ---------------------------------------------------------------------------
// 硬件编解码预检（WebCodecs）
// ---------------------------------------------------------------------------

export interface HardwareCodecProbe {
  /** 有 H.264 硬件编码单元（NVENC / QSV / VCE / Apple 芯片）。 */
  h264: boolean;
  /** 有 AV1 硬件编码单元（RTX 40+ / Intel Arc / M3+ / RDNA3）——只有它才能把 AV1 提前。 */
  av1: boolean;
  /** 有 H.264 硬件**解码**单元（观众端能不能轻松解 1080p60）。 */
  decH264: boolean;
  /**
   * 有 AV1 硬件**解码**单元。
   *
   * 双端判断的依据：AV1 的收益（同码率画质高约 30%）建立在本机硬件编码 +
   * **每个观众都能硬件解码**之上；只要有一位观众得软解 1080p60，对他是灾难
   * （软解 AV1 比软解 H.264 还重）。所以发端只有在"所有观众都报了 AV1 硬解"时才启用。
   */
  decAv1: boolean;
  /** 预检是否真的跑过（浏览器没有 WebCodecs 时为 false，一律按"未探到"处理）。 */
  checked: boolean;
}

const NO_PROBE: HardwareCodecProbe = {
  h264: false,
  av1: false,
  decH264: false,
  decAv1: false,
  checked: false,
};

/** 预检结果按会话缓存（同一台机器同一个浏览器，结果不会变）。 */
let probeCache: Promise<HardwareCodecProbe> | null = null;

interface VideoEncoderSupportResult {
  supported?: boolean;
  config?: { hardwareAcceleration?: string };
}

/** MediaCapabilities 的 `encodingInfo` / `decodingInfo` 结果（只取两个字段）。 */
interface MediaCapabilitiesInfo {
  supported?: boolean;
  powerEfficient?: boolean;
}

/**
 * 问一次 `navigator.mediaCapabilities`：**WebRTC 实际会不会用硬件**。
 *
 * ⚠️ 为什么不只用 WebCodecs 的 `VideoEncoder.isConfigSupported`（原来的做法，2026-10-14 实测推翻）：
 * WebCodecs 的 H.264 **编码器在 Chrome/Windows 上并不暴露 MediaFoundation/NVENC**，
 * 它对 `avc1.640028 + require-hardware` 一律回答 supported:false——而真实 WebRTC
 * 协商时同一个 H.264 走的是 MediaFoundation 硬编（灯箱读数：`NVIDIA H.264 Encoder MFT 硬编`）。
 * 于是"有硬编就关掉 simulcast"的判据永远不成立，共享端**继续用 OpenH264 软编三档**
 * （实测 12.2ms/帧、CPU 受限、只能跑到 24~30fps）。
 *
 * `mediaCapabilities.encodingInfo({type:"webrtc"})` 回答的才是 WebRTC 这条路会用谁，
 * `powerEfficient: true` = 会走硬件编码器。拿不到（旧浏览器）时返回 null，
 * 由调用方决定退回 WebCodecs 预检还是保守取值。
 */
async function askMediaCapabilities(
  kind: "encode" | "decode",
  contentType: string,
  preset: ShareQualityPreset,
): Promise<boolean | null> {
  const mc =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as unknown as { mediaCapabilities?: { encodingInfo?: unknown; decodingInfo?: unknown } })
          .mediaCapabilities;
  const api = kind === "encode" ? mc?.encodingInfo : mc?.decodingInfo;
  if (!mc || typeof api !== "function") return null;
  try {
    const info = (await (api as (config: unknown) => Promise<MediaCapabilitiesInfo>).call(mc, {
      type: "webrtc",
      video: {
        contentType,
        width: preset.width,
        height: preset.height,
        bitrate: preset.maxBitrate,
        framerate: preset.fps,
      },
    })) as MediaCapabilitiesInfo | undefined;
    if (!info?.supported) return false;
    return info.powerEfficient === true;
  } catch {
    return null;
  }
}

/**
 * 硬件编解码预检（优先 mediaCapabilities，其次 WebCodecs 兜底）。
 *
 * 结果四处用途：① 共享端决定**能不能上 AV1**；② 共享端决定**要不要开 simulcast**
 * （有硬编就不开——Chrome 的多档强制软件编码）；③④ 每个端把"本机能否 AV1 硬解"
 * 报进 hello / 名册（共享者据此做双端判断）。
 *
 * 这只是一道**预检**：真实协商仍可能因配置不支持而静默回落软编，
 * 所以发布后必须以 `getStats` 的 `encoderImplementation` / `powerEfficientEncoder`
 * 复核（灯箱数据条就是干这个的）。
 */
export function probeHardwareEncoders(quality: ShareQuality): Promise<HardwareCodecProbe> {
  if (probeCache) return probeCache;
  const preset = SHARE_QUALITY_PRESETS[quality];
  probeCache = (async (): Promise<HardwareCodecProbe> => {
    const [encH264, encAv1, decH264, decAv1] = await Promise.all([
      askMediaCapabilities("encode", "video/H264", preset),
      askMediaCapabilities("encode", "video/AV1", preset),
      askMediaCapabilities("decode", "video/H264", preset),
      askMediaCapabilities("decode", "video/AV1", preset),
    ]);
    // 四个都问不出来（浏览器没有 mediaCapabilities）→ 退回 WebCodecs 预检
    if (encH264 === null && encAv1 === null && decH264 === null && decAv1 === null) {
      return probeViaWebCodecs(quality);
    }
    return {
      h264: encH264 === true,
      av1: encAv1 === true,
      decH264: decH264 === true,
      decAv1: decAv1 === true,
      checked: true,
    };
  })();
  return probeCache;
}

/**
 * WebCodecs 兜底预检（`require-hardware`）。
 * 注意它对 **H.264 编码**会误报 false（见 `askMediaCapabilities` 的说明），
 * 所以只在 mediaCapabilities 完全不可用时才用它。
 */
async function probeViaWebCodecs(quality: ShareQuality): Promise<HardwareCodecProbe> {
  const preset = SHARE_QUALITY_PRESETS[quality];
  const Encoder = (globalThis as { VideoEncoder?: { isConfigSupported?: unknown } }).VideoEncoder;
  const isConfigSupported = (Encoder as { isConfigSupported?: (config: unknown) => Promise<VideoEncoderSupportResult> })
    ?.isConfigSupported;
  if (typeof isConfigSupported !== "function") return NO_PROBE;
  const askEncoder = async (codec: string): Promise<boolean> => {
    try {
      const result = await isConfigSupported.call(Encoder, {
        codec,
        width: preset.width,
        height: preset.height,
        bitrate: preset.maxBitrate,
        framerate: preset.fps,
        hardwareAcceleration: "require-hardware",
      });
      return result?.supported === true;
    } catch {
      return false;
    }
  };
  const Decoder = (globalThis as { VideoDecoder?: { isConfigSupported?: unknown } }).VideoDecoder;
  const decodeIsConfigSupported = (
    Decoder as { isConfigSupported?: (config: unknown) => Promise<VideoEncoderSupportResult> }
  )?.isConfigSupported;
  const askDecoder = async (codec: string): Promise<boolean> => {
    if (typeof decodeIsConfigSupported !== "function") return false;
    try {
      const result = await decodeIsConfigSupported.call(Decoder, {
        codec,
          codedWidth: preset.width,
          codedHeight: preset.height,
          hardwareAcceleration: "require-hardware",
        });
        return result?.supported === true;
      } catch {
        return false;
      }
    };
  const [h264, av1, decH264, decAv1] = await Promise.all([
    askEncoder("avc1.640028"),
    askEncoder("av01.0.08M.08"),
    askDecoder("avc1.640028"),
    askDecoder("av01.0.08M.08"),
  ]);
  return { h264, av1, decH264, decAv1, checked: true };
}

/** 仅测试用：清掉预检缓存。 */
export function resetHardwareProbeCache(): void {
  probeCache = null;
}

/**
 * 编解码器偏好：H264 优先（显卡/芯片硬件编码，CPU 几乎零开销——
 * 直播软件 OBS 等同款选择）；VP8 软编 1080p60 是 CPU 杀手（糊+卡的元凶），垫底。
 * setCodecPreferences 只是调整协商顺序，个别实现不支持时回落浏览器默认。
 *
 * `preferAv1` 只在**预检到本机有 AV1 硬件编码**时才置真（P1-10）。AV1 同码率
 * 画质比 H.264 高一档，但没有硬编时软编 1080p60 跑不动（马赛克从 bandwidth 型
 * 变 cpu 型），所以拿不准一律回落 H.264 基线。
 */
function setPreferredVideoCodecs(transceiver: RTCRtpTransceiver, preferAv1 = false): void {
  const caps = RTCRtpSender.getCapabilities("video");
  if (!caps || caps.codecs.length === 0) return;
  /** 只用到这两个字段（lib 里 RTCRtpCodecCapability 的别名不一定存在）。 */
  type CodecCap = { mimeType: string; sdpFmtpLine?: string };
  const score = (codec: CodecCap): number => {
    switch (codec.mimeType.toLowerCase()) {
      case "video/h264":
        return preferAv1 ? 10 : 0;
      case "video/av1":
        return preferAv1 ? 0 : 10;
      case "video/vp9":
        return 20;
      case "video/vp8":
        return 30;
      default:
        return 90; // rtx/red/flexfec 等辅助载荷保持靠后
    }
  };
  try {
    transceiver.setCodecPreferences(
      [...caps.codecs].sort(
        (a, b) =>
          score(a) - score(b) ||
          // 同一编码内：H.264 的 High Profile 优先（见 h264ProfileRank 的说明）
          (score(a) === 0 ? h264ProfileRank(b.sdpFmtpLine ?? "") - h264ProfileRank(a.sdpFmtpLine ?? "") : 0),
      ),
    );
  } catch {
    /* 忽略：回落浏览器默认编解码器 */
  }
}

/**
 * H.264 `profile-level-id` 的档位打分（High > Main > Baseline）。
 *
 * 为什么要在同编码里挑 profile：Baseline 是**软编的典型产物**（OpenH264 只会出
 * Baseline），而硬件编码单元在支持时可以直接出 High/Main——High 有 CABAC 与
 * 8×8 变换，**同码率下文字边缘更干净**（Discord 用的就是这个手法）。
 * 把 High 排前，既提升画质，又能顺带把"硬编"钓出来；Baseline 仍在列表里兜底，
 * 不会因为对端不支持 High 而协商失败。
 */
export function h264ProfileRank(sdpFmtpLine: string): number {
  const match = /profile-level-id=([0-9a-fA-F]{6})/.exec(sdpFmtpLine ?? "");
  if (!match) return 0;
  const profile = Number.parseInt(match[1]!.slice(0, 2), 16);
  if (profile === 0x64) return 3; // High
  if (profile === 0x4d) return 2; // Main
  if (profile === 0x42) return 1; // Baseline / Constrained Baseline
  return 0;
}

/**
 * 把 SDP 的 `m=video` 里**指定编码的载荷类型提到最前**（P2P 链路用）。
 *
 * 为什么必须这么做（这是"P2P 也糊"的直接原因之一）：
 * PeerJS 自己创建 RTCPeerConnection、自己出 offer，我们**没有机会**在协商前调用
 * `setCodecPreferences`（那条路只有 SFU 的 `publishScreen` 走得到）。而浏览器默认的
 * `m=video` 顺序是 **VP8 在前** → P2P 画面协商到 VP8，**软件编码**；
 * 1080p60 下 VP8 软编 CPU 吃紧，编码器只能疯狂降质量 → 观众看到的就是"糊"。
 *
 * H.264 内部再按 profile 排序（High 优先）；AV1 只在本机与**观众端都**探到
 * 硬件编解码时才被提前（见 `probeHardwareEncoders` 与引擎里的双端判断）。
 *
 * PeerJS 恰好留了一个口子：`peer.call(id, stream, { sdpTransform })` 会被
 * `Negotiator._makeOffer` 在 `createOffer` 之后、`setLocalDescription` 之前调用
 * （已读 peerjs 1.5.5 的 bundler.mjs:837 核对）。这里只重排顺序，不改任何语义。
 */
export function preferCodecSdp(sdp: string, codec: "h264" | "av1"): string {
  if (!sdp) return sdp;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(eol);
  const codecOf = new Map<string, string>(); // 载荷类型 → 编码名（小写）
  const fmtpOf = new Map<string, string>();
  for (const line of lines) {
    const rtpmap = /^a=rtpmap:(\d+)\s+([^/\s]+)/.exec(line);
    if (rtpmap) codecOf.set(rtpmap[1]!, rtpmap[2]!.toLowerCase());
    const fmtp = /^a=fmtp:(\d+)\s+(.*)$/.exec(line);
    if (fmtp) fmtpOf.set(fmtp[1]!, fmtp[2]!);
  }
  // 打分：目标编码 ≥ 1（H.264 内部再按 profile 细排），其余 0 保持原序
  const rankOf = (pt: string): number => {
    if (codecOf.get(pt) !== codec) return 0;
    return codec === "h264" ? 1 + h264ProfileRank(fmtpOf.get(pt) ?? "") / 10 : 1;
  };
  let changed = false;
  const out = lines.map((line) => {
    if (!line.startsWith("m=video")) return line;
    const fields = line.split(" ");
    if (fields.length <= 3) return line;
    const payloads = fields.slice(3);
    // Array.prototype.sort 是稳定排序：目标编码整体前移，其余保持浏览器给的原序
    const ordered = [...payloads].sort((a, b) => rankOf(b) - rankOf(a));
    if (ordered.join(" ") === payloads.join(" ")) return line;
    changed = true;
    return [...fields.slice(0, 3), ...ordered].join(" ");
  });
  return changed ? out.join(eol) : sdp;
}

/** 兼容入口：P2P 画面链路把协商拉回 H.264。 */
export function preferH264Sdp(sdp: string): string {
  return preferCodecSdp(sdp, "h264");
}

/**
 * 在 SDP 的 `m=video` 里注入 `x-google-start-bitrate`（跳开"开局爬坡"）。
 *
 * 现象：Chrome 的发送端起始码率只有几百 kbps，需要 5~10 秒才爬到目标码率——
 * 观众看到的就是"刚开播几秒糊得看不清"。显式声明起始码率后，编码器直接
 * 从高档起步（同一条流的总量不变，只是把爬坡那段省掉）。
 *
 * 只动 `m=video` 段里**真正的编码**（rtx/red/ulpfec/flexfec 跳过）；
 * 已有 fmtp 行的追加、没有的补一条；已含该键时原样返回（幂等）。
 */
export function injectStartBitrate(sdp: string, kbps: number): string {
  if (!sdp || !(kbps > 0)) return sdp;
  const value = Math.round(kbps);
  const KEY = "x-google-start-bitrate";
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(eol);
  const helpers = new Set(["rtx", "red", "ulpfec", "flexfec"]);
  const videoPts = new Set<string>();
  const hasFmtp = new Set<string>();
  const hasKey = new Set<string>();
  let inVideo = false;
  for (const line of lines) {
    if (line.startsWith("m=")) {
      inVideo = line.startsWith("m=video");
      continue;
    }
    if (!inVideo) continue;
    const rtpmap = /^a=rtpmap:(\d+)\s+([^/\s]+)/.exec(line);
    if (rtpmap && !helpers.has(rtpmap[2]!.toLowerCase())) videoPts.add(rtpmap[1]!);
    const fmtp = /^a=fmtp:(\d+)\s+(.*)$/.exec(line);
    if (fmtp && videoPts.has(fmtp[1]!)) {
      hasFmtp.add(fmtp[1]!);
      if (fmtp[2]!.includes(KEY)) hasKey.add(fmtp[1]!);
    }
  }
  if (videoPts.size === 0) return sdp;

  const out: string[] = [];
  let changed = false;
  inVideo = false;
  for (const line of lines) {
    if (line.startsWith("m=")) {
      inVideo = line.startsWith("m=video");
      out.push(line);
      continue;
    }
    if (!inVideo) {
      out.push(line);
      continue;
    }
    const fmtp = /^a=fmtp:(\d+)\s+(.*)$/.exec(line);
    if (fmtp && videoPts.has(fmtp[1]!) && !hasKey.has(fmtp[1]!)) {
      out.push(`${line};${KEY}=${value}`);
      changed = true;
      continue;
    }
    out.push(line);
    const rtpmap = /^a=rtpmap:(\d+)\s+([^/\s]+)/.exec(line);
    if (rtpmap && videoPts.has(rtpmap[1]!) && !hasFmtp.has(rtpmap[1]!)) {
      out.push(`a=fmtp:${rtpmap[1]} ${KEY}=${value}`);
      changed = true;
    }
  }
  return changed ? out.join(eol) : sdp;
}

/**
 * P2P 画面 offer 的统一改写：编码优先（H.264 High / 或双端硬编时的 AV1）
 * + 起始码率（跳过开局爬坡）。
 */
export function boostScreenOfferSdp(
  sdp: string,
  options: { codec?: "h264" | "av1"; startBitrateKbps?: number } = {},
): string {
  const preferred = preferCodecSdp(sdp, options.codec ?? "h264");
  return options.startBitrateKbps && options.startBitrateKbps > 0
    ? injectStartBitrate(preferred, options.startBitrateKbps)
    : preferred;
}

/** 画质档位与发送参数（P2P / SFU 两条链路共用同一套档位定义）。 */
export interface PublishScreenOptions {
  /** 画质档位（默认超清 1080p）。 */
  quality?: ShareQuality;
  /**
   * 带宽不足时的降级方向（docs/archive/SCREENSHARE-PERF-PLAN.md §P0-3）：
   * - `"detail"`（默认）：保清晰，宁可掉帧也不糊——屏幕共享多为 UI/文字/视频，
   *   糊了就没法看，"卡一点"还能忍；
   * - `"motion"`：保帧率，宁可降清晰（看高速游戏时更顺）。
   * 这是 Chrome 里唯一真正生效的降级开关（靠 `contentHint`）。
   */
  hint?: "motion" | "detail";
  /** 连接中断回调（ICE restart 也救不回来时才算断，界面上表现为雪花）。 */
  onLost?: () => void;
  /**
   * simulcast 发布（P1-12）：一条轨编 3 档（f/h/q），SFU 按每个观众的网络自动挑层。
   * 只在 SFU 转发模式下有意义（P2P 是点对点，没有"挑层"这一层）。
   * 发布失败会自动回落单档重试（老 SFU / 意外情况都能出画面）。
   */
  simulcast?: boolean;
  /**
   * 是否允许把 AV1 提到 H.264 之前（默认 false = 一律 H.264）。
   *
   * 必须由调用方做**双端判断**（本机有 AV1 硬编 + 所有观众都报了 AV1 硬解，
   * 见 use-voice 里的 preferAv1 计算）：只要有一位观众得软解 1080p60，
   * 对他是灾难，宁可用 H.264。
   */
  preferAv1?: boolean;
  /** 起始码率（kbps）；缺省按档位上限的 75% 起步，跳过编码器的开局爬坡。 */
  startBitrateKbps?: number;
  /** 档位变化提示（自适应降档时回调，界面可显示"已自动降到 720p"）。 */
  onStep?: (point: TunePoint, reason: string) => void;
}

/**
 * 是否真的要开 simulcast 多档。纯函数，便于把"硬件编码与多档互斥"这条钉在单测里。
 *
 * 只有"调用方请求"且"本机没有硬件编码器"时才开：有硬编时多档会强制走软件编码
 * （实测 SimulcastEncoderAdapter + OpenH264×3），画质反而崩掉。
 */
export function shouldUseSimulcast(requested: boolean, probe: HardwareCodecProbe): boolean {
  if (!requested) return false;
  return !(probe.h264 || probe.av1);
}

/**
 * 把采集好的屏幕流发布到 SFU。
 *
 * `stream` 来自 getDisplayMedia（或调试用的 canvas.captureStream）。
 * 返回的 stop() 只管 SFU 侧的清理；停止采集（track.stop()）由调用方负责。
 *
 * ⚠️ **simulcast 与硬件编码互斥**（实测 + Chrome 实现决定）：
 * 请求 `simulcast: true` 时 Chrome 会用 `SimulcastEncoderAdapter` 包多个编码器，
 * 而 MediaFoundation/NVENC 在这种模式下**不会被采用**——实测读数直接写着
 * `H264 SimulcastEncoderAdapter (OpenH264, OpenH264, OpenH264) 软编`，
 * 而同一台机器走 P2P（单档）时是 `MediaFoundation… (NVIDIA H.264 Encoder MFT) 硬编`。
 * 软编三档 1080p60 根本跑不动：实测编码 17.5ms/帧、上行掉到几百 kbps、
 * 观众只拿到 353×254（q 层）。
 *
 * 所以：**本机有硬件编码器时忽略 simulcast，改发布单档硬编**（画质/CPU/上行全面更好；
 * SFU 出口的上行也从"三层之和"降回一路）。只有没有硬件编码器时才保留多档
 * （那时反正是软编，多档至少能让弱网观众拿到小层）。
 */
export async function publishScreen(
  stream: MediaStream,
  options: PublishScreenOptions = {},
): Promise<ScreenPublication> {
  const wantSimulcast = options.simulcast === true;
  let useSimulcast = wantSimulcast;
  if (wantSimulcast) {
    const probe = await probeHardwareEncoders(options.quality ?? "fhd1080");
    useSimulcast = shouldUseSimulcast(true, probe);
    if (!useSimulcast) {
      console.info(
        "[screen-share] 本机有硬件编码器：放弃 simulcast 多档，改发布单档硬编" +
          "（simulcast 在 Chrome 里会强制走软件编码，实测编码跟不上导致画面糊到 353×254）",
      );
    }
  }
  if (!useSimulcast) return publishScreenOnce(stream, { ...options, simulcast: false });
  try {
    return await publishScreenOnce(stream, { ...options, simulcast: true });
  } catch (error) {
    console.warn("[screen-share] simulcast 发布失败，回落单档发布", error);
    return publishScreenOnce(stream, { ...options, simulcast: false });
  }
}

async function publishScreenOnce(
  stream: MediaStream,
  options: PublishScreenOptions = {},
): Promise<ScreenPublication> {
  const quality = options.quality ?? "fhd1080";
  const hint = options.hint ?? "detail";
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  // contentHint 决定"带宽不足时降什么"：motion 保帧率（画面变糊）、
  // detail 保清晰（画面掉帧）。原先写死 "motion" 又配一个空转的
  // degradationPreference，结果带宽一紧就往"糊"的方向走——这正是
  // "1080p 糊成马赛克"的直接诱因。
  for (const track of stream.getVideoTracks()) track.contentHint = hint;

  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  if (!videoTrack && !audioTrack) throw new Error("没有可发布的媒体轨");
  const useSimulcast = options.simulcast === true;
  if (videoTrack) {
    // AV1 只在"本机有硬编 **且** 调用方确认所有观众都能硬解"时才提前（双端判断，P1-10）
    const probe = await probeHardwareEncoders(quality);
    const transceiver = pc.addTransceiver(videoTrack, {
      direction: "sendonly",
      ...(useSimulcast
        ? {
            sendEncodings: [
              { rid: "f", scaleResolutionDownBy: 1, active: true },
              { rid: "h", scaleResolutionDownBy: 2 },
              { rid: "q", scaleResolutionDownBy: 4 },
            ] as RTCRtpEncodingParameters[],
          }
        : {}),
    });
    setPreferredVideoCodecs(transceiver, options.preferAv1 === true && probe.av1);
  }
  if (audioTrack) pc.addTransceiver(audioTrack, { direction: "sendonly" });

  // 跳过开局爬坡：Chrome 的起始码率只有几百 kbps，要爬 5~10 秒才到目标，
  // 观众看到的就是"刚开播几秒糊"。显式给个起始值，编码器直接高档起步。
  const offer = await pc.createOffer();
  const startKbps =
    options.startBitrateKbps ?? Math.round((SHARE_QUALITY_PRESETS[quality].maxBitrate * 0.75) / 1000);
  const boostedSdp = injectStartBitrate(offer.sdp ?? "", startKbps);
  await pc.setLocalDescription(
    boostedSdp === offer.sdp ? offer : { type: offer.type, sdp: boostedSdp },
  );

  // ICE 候选收集与 SFU 会话创建互不依赖：并行发起，省掉一次串行往返（~1s）。
  const [, session] = await Promise.all([gatherIce(pc), postJson("/sessions/new", null)]);
  const sessionId = str(session["sessionId"]);
  if (!sessionId) throw new Error("SFU 未返回 sessionId");

  // mid ↔ trackName 对应：按 transceiver 里的 sender.track 匹配
  const mids = new Map<string, string>(); // mid → trackName
  for (const transceiver of pc.getTransceivers()) {
    const mid = transceiver.mid;
    const track = transceiver.sender.track;
    if (!mid || !track) continue;
    if (track === videoTrack) mids.set(mid, TRACK_VIDEO);
    else if (track === audioTrack) mids.set(mid, TRACK_AUDIO);
  }

  const tracks = [...mids.entries()].map(([mid, trackName]) => ({
    location: "local",
    mid,
    trackName,
  }));
  const result = await postJson(`/sessions/${sessionId}/tracks/new`, {
    sessionDescription: { type: "offer", sdp: pc.localDescription?.sdp ?? "" },
    tracks,
  });

  const answer = result["sessionDescription"] as { type?: string; sdp?: string } | undefined;
  if (!answer?.sdp) throw new Error("SFU 未返回 answer");
  await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
  // 协商后先试下发一次；被拒（协商时序未就绪）不致命，等 connected 再补
  const appliedEarly = await applyScreenSenderParams(pc, quality);

  /*
   * 官方要求：**连接真正建立后**才让 publication 可被订阅
   * （"Wait for the connection to become connected. Share..."）。
   * 这里等 connected 再返回，调用方拿到手就能直接广播 sessionId；
   * 连不上（15s 超时/失败）在这里抛错，调用方停采集并降级。
   */
  await waitConnected(pc);

  // 连接真正建立后再补一次：这是 setParameters 唯一有保证能生效的时刻。
  // （原实现只在协商后调一次、且失败被 `.catch(() => {})` 静默吞掉 → 用户
  //   选了超清却完全没生效，界面上还看不出来。）
  if (!appliedEarly && !(await applyScreenSenderParams(pc, quality))) {
    console.warn("[screen-share] 画质档位下发失败，浏览器将沿用默认编码参数");
  }

  // 自适应降档（P0-4 / P2-14）：链路一紧先降分辨率，而不是把 1080p 压成马赛克
  const tuner = createScreenSenderTuner(pc, quality, {
    simulcast: useSimulcast,
    onStep: options.onStep,
  });
  // 抖动自愈（P2-13）：短暂抖一下先走 ICE restart，不立刻判死
  const stopHeal = healScreenConnection(pc, { onFailed: options.onLost });

  const closed = { value: false };
  const teardown = async () => {
    if (closed.value) return;
    closed.value = true;
    tuner.stop();
    stopHeal();
    try {
      // 尽力而为地关轨；会话没有删除端点，SFU 侧有闲置超时兜底。
      const entries = [...mids.entries()].map(([mid, trackName]) => ({
        location: "local",
        mid,
        trackName,
      }));
      if (entries.length > 0) {
        await fetch(`${SFU_BASE}/sessions/${sessionId}/tracks/close`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tracks: entries }),
        }).catch(() => {});
      }
    } finally {
      try {
        pc.close();
      } catch {
        /* noop */
      }
    }
  };

  return { sessionId, hasAudio: Boolean(audioTrack), simulcast: useSimulcast, stop: () => void teardown(), pc };
}

// ---------------------------------------------------------------------------
// 订阅
// ---------------------------------------------------------------------------

export interface ScreenSubscription {
  /** 收到的媒体流（视频轨 + 可选音频轨），直接喂给 <video>。 */
  stream: MediaStream;
  /** 停止订阅（关 PC，尽力通知 SFU）。 */
  stop: () => void;
  /** 底层连接（放大层用它拉 getStats 显示实时分辨率/帧率/码率/编码器）。 */
  pc: RTCPeerConnection;
}

export interface SubscribeScreenOptions {
  /**
   * 订阅 simulcast 发布（P1-12）：默认取最高层 `f`，并允许 SFU 在带宽不足时
   * 按字母序自动退到 `h`/`q`。
   *
   * 两个字段的官方默认都是 `none`（"带宽不够也死推我指定的那层"），
   * **不显式声明反而更卡**——这是这条链路上最容易踩的坑。
   */
  simulcast?: boolean;
  /** 优先层（默认 `f`，即满档）。 */
  preferredRid?: string;
  /** 延迟档位（观众侧设置）：low / balanced / smooth，默认 balanced。 */
  latency?: ShareLatency;
  /**
   * 是否允许 SFU 自适应降层（`priorityOrdering: "asciibetical"`）。
   *
   * 缺省 **false = 锁住 preferredRid 那一层**：现场问题是观众明明选满档 `f`，
   * SFU 却按"大陆→境外节点"的带宽估计把它降到了 353×254 的 q 层
   * （观感就是"码率太低"）。业主口径：**默认给最高的**，
   * 所以只有观众主动选"流畅优先"时才把它置真（允许退层换平滑）。
   * `ridNotAvailable` 始终为字母序兜底：发布端真停掉该层时才退。
   */
  adaptive?: boolean;
}

/**
 * 订阅 simulcast 轨时下发给 SFU 的层配置。纯函数（便于单测与语义固定）。
 *
 * **默认锁最高层**（业主明确要求："SFU 按它估计的带宽擅自把我从 f 降到 q，我不要；
 * 默认就是最高的来"）：
 * - `preferredRid` 默认满档 `f`；
 * - `adaptive`（默认 false）= `priorityOrdering`：
 *   `"none"` —— **就算 SFU 觉得带宽不够，也保持 f 层**（对应现场问题：
 *   观众选满档却只收到 353×254 的 q 层，因为它按"大陆→境外节点"的估计擅自降了层）；
 *   `"asciibetical"` —— 只在观众**主动**选"流畅优先"时才开，允许 SFU 按
 *   f→h→q 自适应降层换平滑；
 * - `ridNotAvailable: "asciibetical"` 始终保留：**发布端真的停掉该层**时才退层
 *   （这与"带宽不足被降"是两件事，不会导致画面凭空消失）。
 */
export function simulcastSubscribeConfig(options: {
  preferredRid?: string;
  adaptive?: boolean;
}): { preferredRid: string; priorityOrdering: string; ridNotAvailable: string } {
  return {
    preferredRid: options.preferredRid ?? "f",
    priorityOrdering: options.adaptive === true ? "asciibetical" : "none",
    ridNotAvailable: "asciibetical",
  };
}

/**
 * 订阅某个发布者的屏幕轨。
 * 流程是"SFU 出 offer、浏览器回 answer"，与发布方向相反。
 */
export async function subscribeScreen(
  publisherSessionId: string,
  trackNames: string[],
  options: SubscribeScreenOptions = {},
): Promise<ScreenSubscription> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  // 任一步失败都要关掉半开的 PC，别让连接和 ICE 状态泄漏
  try {
    return await subscribeScreenInner(pc, publisherSessionId, trackNames, options);
  } catch (error) {
    try {
      pc.close();
    } catch {
      /* noop */
    }
    throw error;
  }
}

async function subscribeScreenInner(
  pc: RTCPeerConnection,
  publisherSessionId: string,
  trackNames: string[],
  options: SubscribeScreenOptions = {},
): Promise<ScreenSubscription> {
  // 所有收到的轨并进同一个 MediaStream：<video> 一个 srcObject 全搞定
  // （视频轨渲染画面、音频轨经元素出声——用户在放大层里控制音量）。
  const stream = new MediaStream();
  // 抖动缓冲按链路分级：走到这里的只可能是 SFU 转发（P2P 的画面由引擎
  // 直连，不经过这个函数）。跨境链路留 3000ms 排队空间换平滑，比原先
  // 一刀切 4000ms 少一秒延迟。（这只治"抖"，持续带宽不足仍要靠发送端降档。）
  const jitterTarget = jitterFixedFor(options.latency ?? "balanced");
  pc.ontrack = (event) => {
    stream.addTrack(event.track);
    // 画面与声音成对排队，避免"声音追着画面后知后觉"（也只有这条画面 PC）
    if (event.receiver) {
      try {
        event.receiver.jitterBufferTarget = jitterTarget;
      } catch {
        /* 个别实现不支持时忽略 */
      }
    }
  };

  const session = await postJson("/sessions/new", null);
  const sessionId = str(session["sessionId"]);
  if (!sessionId) throw new Error("SFU 未返回 sessionId");

  // simulcast 发布：声明优先层并开启字母序降级（不声明 = 官方默认 none，
  // 带宽不足时 SFU 仍死推最高层，观众端只会更卡）。
  // `lockLayer` 时把 priorityOrdering 设为 none = "就算它觉得带宽不够也别降层"
  // （观众点"清晰优先"就是表达这个诉求）；ridNotAvailable 仍留字母序兜底。
  const simulcast = options.simulcast ? simulcastSubscribeConfig(options) : undefined;
  const result = await postJson(`/sessions/${sessionId}/tracks/new`, {
    tracks: trackNames.map((trackName) => ({
      location: "remote",
      sessionId: publisherSessionId,
      trackName,
      ...(simulcast && trackName === TRACK_VIDEO ? { simulcast } : {}),
    })),
  });

  const offer = result["sessionDescription"] as { type?: string; sdp?: string } | undefined;
  if (!offer?.sdp) throw new Error("SFU 未返回 offer");
  await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await gatherIce(pc);

  const res = await fetch(`${SFU_BASE}/sessions/${sessionId}/renegotiate`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionDescription: { type: "answer", sdp: pc.localDescription?.sdp ?? "" },
    }),
  });
  if (!res.ok) throw new Error(`SFU renegotiate 失败（${res.status}）`);

  await waitConnected(pc);

  return {
    stream,
    pc,
    stop: () => {
      try {
        pc.close();
      } catch {
        /* noop */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 调试入口（与 pen.ts 的调试开关同一套门禁）
// ---------------------------------------------------------------------------

/**
 * `?tv=1`：强制电视亮起（假状态、无真实媒体，电视播测试彩条）。
 * 用于不开 getDisplayMedia 就能目检掉落/聚集/散场全套动画。
 */
export function debugTvFrom(search: string): boolean {
  return isPenDebug(search) && /[?&]tv=1/.test(search);
}

/**
 * `?tv=demo`：用 canvas 动画的 captureStream 当共享源，走**真实**的
 * SFU 发布/订阅链路（无需人工点系统选择器，可全自动验证 E2E）。
 */
export function debugTvDemoFrom(search: string): boolean {
  return isPenDebug(search) && /[?&]tv=demo/.test(search);
}

/** 生成演示用的动态画面流（彩条 + 时钟），供 `?tv=demo` 全链路验证。 */
export function createDemoStream(): MediaStream | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const bars = ["#ffffff", "#f5e942", "#42d6f5", "#4ef542", "#f542b0", "#f54242", "#4249f5"];
  const draw = (now: number) => {
    const bw = canvas.width / bars.length;
    for (let i = 0; i < bars.length; i += 1) {
      ctx.fillStyle = bars[i]!;
      ctx.fillRect(i * bw, 0, bw, canvas.height * 0.72);
    }
    ctx.fillStyle = "#1d1f27";
    ctx.fillRect(0, canvas.height * 0.72, canvas.width, canvas.height * 0.28);
    ctx.fillStyle = "#f5e942";
    ctx.font = "bold 96px monospace";
    ctx.textAlign = "center";
    const t = new Date();
    ctx.fillText(
      `${t.toLocaleTimeString("zh-CN", { hour12: false })}.${String(t.getMilliseconds()).padStart(3, "0")}`,
      canvas.width / 2,
      canvas.height * 0.9,
    );
    // 滚动的小猪圈标，证明画面是活的
    const x = (now / 12) % (canvas.width + 200) - 100;
    ctx.fillStyle = "#f092a8";
    ctx.beginPath();
    ctx.ellipse(x, canvas.height * 0.35, 56, 46, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#4a2b34";
    ctx.beginPath();
    ctx.ellipse(x - 18, canvas.height * 0.33, 6, 8, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 18, canvas.height * 0.33, 6, 8, 0, 0, Math.PI * 2);
    ctx.fill();
  };

  draw(0);
  const timer = window.setInterval(() => draw(Date.now()), 66);
  const stream = canvas.captureStream(15);
  // 画布停更时轨道静默；组件卸载不了 canvas，就挂个终结钩子
  stream.getVideoTracks()[0]?.addEventListener("ended", () => window.clearInterval(timer));
  return stream;
}
