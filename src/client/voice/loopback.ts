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
 */

/** Rust 侧固定 48000（见 src-tauri/src/loopback.rs），这里保持一致。 */
const CAPTURE_SAMPLE_RATE = 48_000;

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
}

/** 启动内置系统声音采集。失败抛错（调用方自行提示并降级为无声音）。 */
export async function startLoopbackAudio(
  onLost?: (message: string) => void,
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
  const node = new AudioWorkletNode(ctx, "loopback-player", {
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const destination = ctx.createMediaStreamDestination();
  node.connect(destination);

  let nodeReady = true;
  const channel = new Channel<string>();
  channel.onmessage = (payload) => {
    if (!nodeReady) return;
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

  const info = await invoke<{ sampleRate: number; channels: number }>("start_loopback_capture", {
    onChunk: channel,
  });
  if (info.sampleRate !== ctx.sampleRate) {
    // Rust 侧固定 48k，正常不会走到；防御性处理：格式对不上直接判失败
    await invoke("stop_loopback_capture");
    ctx.close().catch(() => {});
    throw new Error(`采样率不匹配（采集 ${info.sampleRate}，图 ${ctx.sampleRate}）`);
  }

  const [track] = destination.stream.getAudioTracks();
  if (!track) {
    await invoke("stop_loopback_capture");
    void ctx.close().catch(() => {});
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
    unlistenLost?.();
    try {
      await invoke("stop_loopback_capture");
    } catch {
      /* 停止失败不阻塞停播 */
    }
    try {
      track.stop();
    } catch {
      /* noop */
    }
    void ctx.close().catch(() => {});
  };

  return { track, stop };
}
