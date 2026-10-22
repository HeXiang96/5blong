/**
 * 客户端内置系统声音采集（Windows · WASAPI 回环）。
 *
 * 背景：浏览器的"共享系统音频"在多声道播放设备上（7.1 游戏声卡、虚拟声卡）
 * 拿不到回环流——Chromium 对回环端点的格式要求死板，格式对不上就把音频轨
 * 结束掉。而桌面客户端有 Rust 侧：像 Oopz 那样直接走 WASAPI 回环
 * （`AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` 让音频引擎自动把 8ch/44.1k 转成
 * 2ch/48k），经 Tauri Channel 流给页面，再用 AudioWorklet 播进
 * `MediaStreamAudioDestinationNode`——产出的音轨与 getDisplayMedia 的画面轨
 * 合并发布。网页版没有这条通路（浏览器安全边界），只能提示用户换设备。
 *
 * 链路：Rust（回环 8ch→2ch/48k，i16）→ Channel（base64 字符串）
 *       → 解码成 Float32 → AudioWorklet 队列 → 目的地节点 → MediaStreamTrack
 *
 * 可靠性约定（2026-10-14 实测教训）：
 * - **启动必须等到第一块 PCM 才算成功**（4 秒超时判失败）——否则"共享正常
 *   但没声音"这种哑故障没法暴露（wasapi crate 在无包时读取会 panic，
 *   采集线程无声死亡，Rust 侧已改为有包才读 + panic 上报）。
 * - AudioContext 若被 autoplay 策略挂起要显式 resume。
 */

/** Rust 侧固定 48000（见 src-tauri/src/loopback.rs），这里保持一致。 */
const CAPTURE_SAMPLE_RATE = 48_000;

/** 等第一块 PCM 的时限。超过即判定采集链路不通。 */
const FIRST_CHUNK_TIMEOUT_MS = 4_000;

/**
 * AudioWorklet 源码（Blob URL 注入，免得为 40 行代码加一个构建入口）。
 * 收主线程送来的交错立体声块，按采样节拍取出；队列积压时丢最旧的，
 * 把延迟限制在 ~8 块（约 340ms）以内。
 */
const WORKLET_SOURCE = `
class LoopbackPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data.type === "chunk") {
        this.queue.push(data.samples);
        if (this.queue.length > 8) this.queue.splice(0, this.queue.length - 8);
      } else if (data.type === "flush") {
        this.queue.length = 0;
      }
    };
  }
  process(_inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] ?? left;
    let filled = 0;
    while (filled < left.length && this.queue.length > 0) {
      const buf = this.queue[0];
      let i = 0;
      while (filled < left.length && i < buf.length) {
        left[filled] = buf[i++];
        right[filled] = buf[i++];
        filled++;
      }
      if (i >= buf.length) this.queue.shift();
      else this.queue[0] = buf.subarray(i);
    }
    for (; filled < left.length; filled++) {
      left[filled] = 0;
      right[filled] = 0;
    }
    return true;
  }
}
registerProcessor("loopback-player", LoopbackPlayer);
`;

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface LoopbackAudio {
  /** 可直接 addTrack 进共享流的系统声音轨。 */
  track: MediaStreamTrack;
  /** 停播时调用（停 Rust 采集、关音频图；重复调用安全）。 */
  stop: () => Promise<void>;
  /**
   * Rust 侧实际采用的采集模式：
   * - include：只采一个应用（最理想，房间语音进不来）
   * - webview：整机 − WebView2 进程树（我们自己的语音从这儿出）
   * - self：整机 − 本进程（拿不到 WebView2 进程时的兜底，可能仍含人声）
   */
  mode: string;
  /** 本次的目标进程（include=被采应用；webview/self=被排除的进程）。 */
  target: number;
}

/** 启动内置系统声音采集。失败抛错（调用方自行提示并降级为无声音）。 */
export async function startLoopbackAudio(
  onLost?: (message: string) => void,
  onFallback?: (message: string) => void,
  /** 只采集这个进程的声音（INCLUDE）；不传=整机混音减去本应用 */
  onlyPid?: number | null,
): Promise<LoopbackAudio> {
  const [{ invoke, Channel }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);

  // 采集中断（设备拔出/独占等）时通知页面：画面照常，声音没了
  let unlistenLost: (() => void) | null = null;
  if (onLost) {
    try {
      unlistenLost = await listen<string>("loopback:error", (event) => onLost(event.payload));
      /*
       * 进程级采集不可用（老系统/被策略禁用）时会回退整机回环：
       * 那个模式下共享音频里会含房间语音，观众可能听到回声——必须让共享者看到。
       */
      const unlistenFallback = await listen<string>("loopback:fallback", (event) =>
        (onFallback ?? onLost)?.(event.payload),
      );
      const prevLost = unlistenLost;
      unlistenLost = () => {
        prevLost?.();
        unlistenFallback();
      };
    } catch {
      /* 事件监听失败不阻塞采集 */
    }
  }

  // 音频图先建好（采样率固定 48k），Channel 一到数据就往里灌
  const ctx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
  const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
  const workletUrl = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }
  // autoplay 策略可能把上下文挂起：挂起状态下游节点永远静音
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* 恢复失败由下面的健康检查兜底 */
    }
  }
  const node = new AudioWorkletNode(ctx, "loopback-player", {
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const destination = ctx.createMediaStreamDestination();
  node.connect(destination);

  let nodeReady = true;
  let chunkCount = 0;
  let signalFirstChunk: (() => void) | null = null;
  const firstChunk = new Promise<void>((resolve) => {
    signalFirstChunk = resolve;
  });
  const channel = new Channel<string>();
  channel.onmessage = (payload) => {
    if (!nodeReady) return;
    chunkCount += 1;
    signalFirstChunk?.();
    signalFirstChunk = null;
    // base64 → 字节 → i16 交错立体声 → f32
    const raw = atob(payload);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const usable = bytes.byteLength - (bytes.byteLength % 2);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2);
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i] / 32768;
    node.port.postMessage({ type: "chunk", samples }, [samples.buffer]);
  };

  // 先声明再赋值：cleanup 里会引用它，而 cleanup 可能在赋值之前被调用
  // （采样率不匹配的防御分支）——用 const 会产生 TDZ 错误，把真正的失败原因吃掉。
  let track: MediaStreamTrack | undefined;

  const cleanup = async (): Promise<void> => {
    // 先关闸：停播后 Rust 侧最后一两块 PCM 还可能到，不能再向已关闭的 worklet 发消息
    nodeReady = false;
    unlistenLost?.();
    try {
      await invoke("stop_loopback_capture");
    } catch {
      /* 停止失败不阻塞调用方 */
    }
    try {
      track?.stop();
    } catch {
      /* noop */
    }
    void ctx.close().catch(() => {});
  };

  const info = await invoke<{
    sampleRate: number;
    channels: number;
    mode?: string;
    target?: number;
  }>("start_loopback_capture", {
    onChunk: channel,
    onlyPid: onlyPid ?? null,
  });
  if (info.sampleRate !== ctx.sampleRate) {
    // Rust 侧固定 48k，正常不会走到；防御性处理：格式对不上直接判失败
    await cleanup();
    throw new Error(`采样率不匹配（采集 ${info.sampleRate}，图 ${ctx.sampleRate}）`);
  }

  const [firstTrack] = destination.stream.getAudioTracks();
  track = firstTrack;
  if (!track) {
    await cleanup();
    throw new Error("音频图没有产出音轨");
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      node.port.postMessage({ type: "flush" });
    } catch {
      /* 音频图可能已关 */
    }
    await cleanup();
  };

  // **等到第一块 PCM 才算启动成功**：链路任何一环断了（Rust 线程死亡、
  // Channel 不通、worklet 静音）都会在这里现形，而不是变成哑故障
  const timeout = new Promise<never>((_, reject) => {
    window.setTimeout(() => {
      reject(
        new Error(
          `内置采集 4 秒内没有产出音频数据（收到 ${chunkCount} 块）——已按无声音处理`,
        ),
      );
    }, FIRST_CHUNK_TIMEOUT_MS);
  });
  try {
    await Promise.race([firstChunk, timeout]);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return { track, stop, mode: info.mode ?? "unknown", target: info.target ?? 0 };
}

/** 列出"有窗口的进程"（标题 + pid）：共享浮层与自检用（仅桌面客户端）。 */
export async function listShareWindows(): Promise<{ pid: number; title: string }[]> {
  if (!isTauriRuntime()) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<{ pid: number; title: string }[]>("list_share_windows");
  } catch {
    return [];
  }
}

/**
 * 从共享源 label（窗口标题）反查窗口所属进程。
 *
 * 命中就说明"用户共享的是某个具体窗口"——此时只采那个进程的声音，
 * 房间语音从原理上不可能混进共享音频。认不出来返回 null，调用方退回
 * "整机 − 本应用进程树"。
 */
export async function resolveSharePid(
  label: string,
): Promise<{ pid: number; title: string } | null> {
  if (!isTauriRuntime() || !label.trim()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const hit = await invoke<{ pid: number; title: string } | null>("resolve_share_pid", { label });
    return hit && hit.pid ? hit : null;
  } catch {
    return null;
  }
}

/** 列出正在出声的应用（仅桌面客户端；网页版返回空）。 */
export async function listLoopbackTargets(): Promise<{ pid: number; name: string }[]> {
  if (!isTauriRuntime()) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<{ pid: number; name: string }[]>("list_loopback_targets");
  } catch {
    return [];
  }
}
