/**
 * 远端画面健康检测（黑屏探针）。
 *
 * 为什么需要
 * ----------
 * 观端出现过「解码器每秒都在出帧、码率也正常，但画面就是全黑」的故障
 * （实测读数：`1920×1088 · 32fps · 5226 kbps · H264 D3D11VideoDecoder 硬解 · 直连`）。
 * 这种故障最恶心的地方是**所有统计指标都正常**，只有人眼能看出来，于是：
 * 观众只会说"我这边黑的"，共享者以为画面发出去了，双方都在猜。
 *
 * 这里做两件事：
 *   1. 每 500ms 把 `<video>` 缩到 64×36 采一次平均亮度（便宜到可以常开）；
 *   2. 只有「**持续**全黑」+「**帧在增长**」两个条件同时满足才算故障。
 *
 * 为什么必须带"帧在增长"
 * ----------------------
 * 暂停、卡住、`readyState` 不足时画面也是黑的，但那不是解码器的问题。
 * 帧计数在涨说明解码器确实在持续产出，黑只能来自解码输出之后（坏掉的
 * D3D11 纹理路径）。没有这条，正常卡顿会被误判成硬件故障。
 *
 * 为什么不在这一层自动降级
 * ------------------------
 * 浏览器/WebRTC **没有**运行时关闭硬件解码的 API（WebCodecs 的开关不影响
 * WebRTC 内部解码路径），唯一可靠手段是给 WebView2 加启动参数
 * `--disable-accelerated-video-decode`，只能重启生效。
 * 所以这里只负责"确诊 + 上报"，落盘与提示交给调用方（PenTV / Tauri 命令）。
 */

/** 采样用的缩略画布尺寸：够判断"亮/黑"，又便宜到可以每 500ms 跑一次 */
const SAMPLE_W = 64;
const SAMPLE_H = 36;

/** 平均亮度低于这个值（0–255）算黑。留一点余量，纯黑是 0 */
export const DEFAULT_LUMA_MAX = 8;

/** 连续黑多久才判定。短于这个的多数是切场景/视频黑场 */
export const DEFAULT_MIN_SECONDS = 8;

/** 采样间隔 */
const SAMPLE_INTERVAL_MS = 500;

export interface BlackWatchState {
  /** 本轮"从什么时候开始黑"的时间戳（ms）；null = 当前不是黑 */
  since: number | null;
  /** 本轮开始时的帧计数基线 */
  framesAtStart: number;
  /** 已经判定并回调过，不再重复触发 */
  reported: boolean;
}

export interface BlackSample {
  now: number;
  /** 平均亮度 0–255 */
  luma: number;
  /** 累计解出的帧数（`presentedFrames` 或 `totalVideoFrames`） */
  frames: number;
  /** 这次采样是否有效（流在播、尺寸就绪、页面可见）；false 时整轮作废 */
  usable: boolean;
}

export interface BlackDiagnosis {
  /** 持续全黑的秒数 */
  seconds: number;
  /** 这期间解码器新解出的帧数 */
  frames: number;
}

export function initialBlackWatchState(): BlackWatchState {
  return { since: null, framesAtStart: 0, reported: false };
}

/**
 * 纯状态机：喂一次采样，返回新状态 +（可选）诊断结论。
 *
 * 拆成纯函数是为了能单测——这段逻辑一旦判错，要么用户看不到提示（漏报），
 * 要么把正常的暗色画面当成硬件故障（误报）。
 */
export function stepBlackWatch(
  state: BlackWatchState,
  sample: BlackSample,
  opts: { lumaMax?: number; minSeconds?: number } = {},
): { state: BlackWatchState; diagnosis: BlackDiagnosis | null } {
  const lumaMax = opts.lumaMax ?? DEFAULT_LUMA_MAX;
  const minSeconds = opts.minSeconds ?? DEFAULT_MIN_SECONDS;

  // 采样无效（暂停/不可见/尺寸没就绪）：整轮作废，但"已上报"保持，
  // 否则恢复播放后会再报一次，把用户烦死。
  if (!sample.usable) {
    return { state: { ...state, since: null }, diagnosis: null };
  }

  if (sample.luma > lumaMax) {
    // 画面亮了：本轮结束
    return { state: { ...state, since: null }, diagnosis: null };
  }

  if (state.since === null) {
    return {
      state: { ...state, since: sample.now, framesAtStart: sample.frames },
      diagnosis: null,
    };
  }

  const seconds = (sample.now - state.since) / 1000;
  const frames = sample.frames - state.framesAtStart;

  // 帧没涨 = 解码器没在产出（暂停/卡住），不是硬解故障
  if (frames <= 0) return { state, diagnosis: null };

  if (!state.reported && seconds >= minSeconds) {
    return {
      state: { ...state, reported: true },
      diagnosis: { seconds: Math.round(seconds), frames },
    };
  }

  return { state, diagnosis: null };
}

/** 读累计帧数：优先 rVFC 计数，其次 `getVideoPlaybackQuality`，都没有就返回 -1 */
function readFrameCount(video: HTMLVideoElement, fallback: { count: number }): number {
  const quality = (
    video as HTMLVideoElement & {
      getVideoPlaybackQuality?: () => { totalVideoFrames?: number };
    }
  ).getVideoPlaybackQuality?.();
  const total = quality?.totalVideoFrames;
  if (typeof total === "number" && total > 0) return total;
  return fallback.count > 0 ? fallback.count : -1;
}

/**
 * 开始监视一个 `<video>` 的画面健康。返回清理函数（组件卸载/换流时调用）。
 *
 * 整个过程包了 try/catch：canvas 取不到 2D 上下文（极少数驱动/策略）时
 * 直接静默放弃——探针挂了也绝不能影响正常播放。
 */
export function watchBlackFrames(
  video: HTMLVideoElement,
  options: {
    onDiagnosed: (info: BlackDiagnosis) => void;
    lumaMax?: number;
    minSeconds?: number;
  },
): () => void {
  let state = initialBlackWatchState();
  let disposed = false;
  const counter = { count: 0 };

  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    canvas = document.createElement("canvas");
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  } catch {
    ctx = null;
  }
  if (!ctx) return () => {};

  // rVFC：拿到"真正被呈现"的帧数（比 totalVideoFrames 更贴近肉眼）
  type RvfcVideo = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  const rvfc = video as RvfcVideo;
  let rvfcHandle: number | null = null;
  const onFrame = () => {
    if (disposed) return;
    counter.count += 1;
    rvfcHandle = rvfc.requestVideoFrameCallback?.(onFrame) ?? null;
  };
  if (typeof rvfc.requestVideoFrameCallback === "function") {
    rvfcHandle = rvfc.requestVideoFrameCallback(onFrame);
  }

  const timer = window.setInterval(() => {
    if (disposed || !ctx) return;
    let luma = 0;
    let usable = false;
    try {
      usable =
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0 &&
        !video.paused &&
        !video.ended &&
        !document.hidden;
      if (usable) {
        ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
        const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
        let sum = 0;
        // 只取亮度通道的近似（R/G/B 加权），比逐像素转 YUV 便宜
        for (let i = 0; i < data.length; i += 4) {
          sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
        }
        luma = sum / (data.length / 4);
      }
    } catch {
      usable = false;
    }

    const result = stepBlackWatch(
      state,
      {
        now: Date.now(),
        luma,
        frames: readFrameCount(video, counter),
        usable,
      },
      { lumaMax: options.lumaMax, minSeconds: options.minSeconds },
    );
    state = result.state;
    if (result.diagnosis) options.onDiagnosed(result.diagnosis);
  }, SAMPLE_INTERVAL_MS);

  return () => {
    disposed = true;
    window.clearInterval(timer);
    if (rvfcHandle !== null) rvfc.cancelVideoFrameCallback?.(rvfcHandle);
  };
}
