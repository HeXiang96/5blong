/**
 * 音频设备。与旧版差异：
 * - bindSpeaker 支持切回系统默认（旧版对空 deviceId 直接 return，等于切不回去）。
 * - setSinkId 失败不再静默：真实原因回传给 UI。
 * - 枚举设备不靠"先开一次麦再关掉"取标签，避免每次打开设置都闪一次麦克风指示灯。
 */

import type { VoiceSettings } from "./settings";

export interface DeviceOption {
  id: string;
  label: string;
}

export interface DeviceGroups {
  mics: DeviceOption[];
  speakers: DeviceOption[];
}

export function mediaSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

/** 枚举输入/输出设备。未授权时 label 为空，用序号占位而不是谎称"默认麦克风"。 */
export async function listDevices(): Promise<DeviceGroups> {
  if (!mediaSupported()) return { mics: [], speakers: [] };
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return { mics: [], speakers: [] };
  }
  let micIndex = 0;
  let speakerIndex = 0;
  const mics: DeviceOption[] = [];
  const speakers: DeviceOption[] = [];
  for (const device of devices) {
    if (device.kind === "audioinput") {
      micIndex += 1;
      mics.push({ id: device.deviceId, label: device.label || `麦克风 ${micIndex}` });
    } else if (device.kind === "audiooutput") {
      speakerIndex += 1;
      speakers.push({
        id: device.deviceId,
        label: device.label || `扬声器 ${speakerIndex}`,
      });
    }
  }
  return { mics, speakers };
}

/** 设备热插拔订阅。返回取消订阅函数。 */
export function onDeviceChange(callback: () => void): () => void {
  if (!mediaSupported() || !navigator.mediaDevices.addEventListener) return () => {};
  navigator.mediaDevices.addEventListener("devicechange", callback);
  return () => navigator.mediaDevices.removeEventListener("devicechange", callback);
}

export function micErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "麦克风权限被拒绝，你将以纯收听方式加入";
    case "NotFoundError":
    case "OverconstrainedError":
      return "没有找到可用的麦克风，你将以纯收听方式加入";
    case "NotReadableError":
      return "麦克风被其他程序占用，你将以纯收听方式加入";
    default:
      return "无法打开麦克风，你将以纯收听方式加入";
  }
}

/**
 * 打开麦克风。指定设备失效时回退默认设备，而不是让用户卡在进不去。
 * 回退发生过则通过 onFallback 告知。
 */
export async function openMic(
  settings: VoiceSettings,
  onFallback?: (message: string) => void,
): Promise<MediaStream> {
  if (!mediaSupported()) throw new Error("media-unsupported");
  const processing = settings.processing;
  const base: MediaTrackConstraints = {
    echoCancellation: processing.echoCancellation,
    // 降噪统一交给 RNNoise AudioWorklet（见 engine.ts 的 buildOutgoing），
    // 这里关掉浏览器原生 noiseSuppression，避免双重降噪把人声也压没。
    noiseSuppression: false,
    autoGainControl: processing.autoGainControl,
    channelCount: 1,
  };
  if (!settings.micDeviceId) {
    return navigator.mediaDevices.getUserMedia({ audio: base, video: false });
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { ...base, deviceId: { exact: settings.micDeviceId } },
      video: false,
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name ?? "";
    /*
     * 只有"这个设备打不开"才回退默认设备。
     * 权限被拒（NotAllowedError / SecurityError）回退也是白搭：会再弹一次授权、
     * 还会先给出"已改用系统默认设备"这种假消息，把用户引到错误的方向
     * （真实原因是权限，不是设备选错了）。
     */
    if (name === "NotAllowedError" || name === "SecurityError") throw error;
    onFallback?.("所选麦克风不可用，已改用系统默认设备");
    return navigator.mediaDevices.getUserMedia({ audio: base, video: false });
  }
}

export async function resumeAudio(ctx: AudioContext | null): Promise<void> {
  if (!ctx || ctx.state !== "suspended") return;
  try {
    await ctx.resume();
  } catch {
    /* 需要用户手势，UI 会提示 */
  }
}

type SinkCapable = HTMLAudioElement & {
  setSinkId?: (id: string) => Promise<void>;
};

export function canSelectSpeaker(): boolean {
  return typeof HTMLMediaElement !== "undefined" &&
    typeof (HTMLMediaElement.prototype as SinkCapable).setSinkId === "function";
}

/**
 * 绑定播放设备。deviceId 为空表示系统默认（显式传空串才能真正切回去）。
 * 失败时把原因交给调用方展示。
 */
export function bindSpeaker(
  element: HTMLAudioElement,
  deviceId: string,
  onError?: (message: string) => void,
): void {
  const sink = (element as SinkCapable).setSinkId;
  if (typeof sink !== "function") return;
  sink.call(element, deviceId || "").catch((error: unknown) => {
    const name = (error as { name?: string } | null)?.name ?? "";
    onError?.(
      name === "NotFoundError"
        ? "所选扬声器已不可用，已保持当前输出设备"
        : "切换扬声器失败，已保持当前输出设备",
    );
  });
}

export interface MicTest {
  stop: () => void;
}

/** 麦克风测试：实时电平回调（0..1）。 */
export async function startMicTest(
  settings: VoiceSettings,
  onLevel: (value: number) => void,
): Promise<MicTest> {
  const stream = await openMic(settings);
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("audio-context-unavailable");
  }
  const ctx = new Ctor();
  await resumeAudio(ctx);
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let timer = 0;
  let peak = 0;

  const tick = () => {
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (const value of data) sum += value;
    const level = Math.min(1, sum / data.length / 48);
    // 轻微平滑，避免指针抖动到看不出趋势。
    peak = level > peak ? level : peak * 0.72 + level * 0.28;
    onLevel(peak);
  };
  timer = window.setInterval(tick, 80);
  tick();

  return {
    stop: () => {
      window.clearInterval(timer);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        /* noop */
      }
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close().catch(() => {});
    },
  };
}
