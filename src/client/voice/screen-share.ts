/**
 * 屏幕共享 · SFU 客户端（Cloudflare Realtime SFU）。
 *
 * 设计铁律（SCREENSHARE-PLAN.md §H）：这里的所有 RTCPeerConnection **只连 SFU**，
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

// ---------------------------------------------------------------------------
// 画质档位（业主指定：高清 HD 720p60 / 超清 1080p60，均 10000 kbps）
// ---------------------------------------------------------------------------

export type ShareQuality = "hd720" | "fhd1080";

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

export const SHARE_QUALITY_PRESETS: Record<ShareQuality, ShareQualityPreset> = {
  // 业主定位：共享 = 直播流，画质拉满。1080p60 给 20 Mbps（直播推流级），
  // 720p60 给 8 Mbps；高码率兜住分辨率，网络挤爆前不会降清。
  hd720: { label: "高清 HD 720p", width: 1280, height: 720, fps: 60, maxBitrate: 8_000_000 },
  fhd1080: { label: "超清 1080p", width: 1920, height: 1080, fps: 60, maxBitrate: 20_000_000 },
};

/** getDisplayMedia 选择器提示项（Chromium 支持；TS 类型未收录，运行时透传）。
 *  注意：preferCurrentTab 与 selfBrowserSurface:"exclude" 互斥
 *  （Chromium 抛 TypeError: Self-contradictory configuration），
 *  不能同时开——这里保留"剔除自己页面"（防把房间网页共享进房间）。 */
export function pickerHints(): Record<string, unknown> {
  return {
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    monitorTypeSurfaces: "include",
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

/** 把档位应用到发送端（码率 + 帧率上限；分辨率由采集约束决定）。 */
function applySenderQuality(pc: RTCPeerConnection, quality: ShareQuality): void {
  const preset = SHARE_QUALITY_PRESETS[quality];
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    // degradationPreference 是较新的规范属性，TS 的 DOM 类型还没收录（Chrome 已实现）
    type Encoding = RTCRtpEncodingParameters & { degradationPreference?: string };
    params.encodings[0] = {
      ...params.encodings[0],
      // 直播流定位：优先保帧率（流畅），高码率上限兜住清晰度
      degradationPreference: "maintain-framerate",
      maxBitrate: preset.maxBitrate,
      maxFramerate: preset.fps,
      scaleResolutionDownBy: 1,
    } as Encoding;
    // setParameters 可能被浏览器拒绝（协商时序），失败不致命：采集约束已限了分辨率
    sender.setParameters(params).catch(() => {});
  }
}

const ICE_SERVERS: RTCIceServer[] = [
  // Cloudflare 自家 STUN 足够（SFU 本身就是公网可达的，无需打洞）
  { urls: "stun:stun.cloudflare.com:3478" },
];

/** 等待 ICE 候选收集完成（带超时：SFU 不需要完整候选表，1.2s 内有多少用多少）。 */
async function gatherIce(pc: RTCPeerConnection, timeoutMs = 1200): Promise<void> {
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

// ---------------------------------------------------------------------------
// 发布
// ---------------------------------------------------------------------------

export interface ScreenPublication {
  /** SFU 会话 id：交给房主广播，订阅方据此拉流。 */
  sessionId: string;
  /** 是否带了音频轨。 */
  hasAudio: boolean;
  /** 停止发布（关 PC + 通知 SFU 关轨，尽力而为）。 */
  stop: () => void;
  /** 连接中断回调（watchdog 用，界面上表现为雪花）。 */
  onLost?: () => void;
}

/**
 * 把采集好的屏幕流发布到 SFU。
 *
 * `stream` 来自 getDisplayMedia（或调试用的 canvas.captureStream）。
 * 返回的 stop() 只管 SFU 侧的清理；停止采集（track.stop()）由调用方负责。
 */
export async function publishScreen(
  stream: MediaStream,
  quality: ShareQuality = "fhd1080",
  onLost?: () => void,
): Promise<ScreenPublication> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  // 业主定位：共享 = 直播流。"motion" = 编码器优先保帧率（画面流畅）；
  // 高码率（20 Mbps）由发送端参数兜住，网络不挤爆就不会降分辨率——
  // 流畅与清晰两者都要，不做"保一头"的取舍。
  for (const track of stream.getVideoTracks()) track.contentHint = "motion";

  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  if (!videoTrack && !audioTrack) throw new Error("没有可发布的媒体轨");
  if (videoTrack) pc.addTransceiver(videoTrack, { direction: "sendonly" });
  if (audioTrack) pc.addTransceiver(audioTrack, { direction: "sendonly" });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await gatherIce(pc);

  const session = await postJson("/sessions/new", null);
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
  // 协商完成后应用画质档位（码率/帧率上限）
  applySenderQuality(pc, quality);

  /*
   * 官方要求：**连接真正建立后**才让 publication 可被订阅
   * （"Wait for the connection to become connected. Share..."）。
   * 这里等 connected 再返回，调用方拿到手就能直接广播 sessionId；
   * 连不上（15s 超时/失败）在这里抛错，调用方停采集并降级。
   */
  await waitConnected(pc);

  if (onLost) {
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") onLost();
    });
  }

  const closed = { value: false };
  const teardown = async () => {
    if (closed.value) return;
    closed.value = true;
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

  return { sessionId, hasAudio: Boolean(audioTrack), stop: () => void teardown() };
}

// ---------------------------------------------------------------------------
// 订阅
// ---------------------------------------------------------------------------

export interface ScreenSubscription {
  /** 收到的媒体流（视频轨 + 可选音频轨），直接喂给 <video>。 */
  stream: MediaStream;
  /** 停止订阅（关 PC，尽力通知 SFU）。 */
  stop: () => void;
}

/**
 * 订阅某个发布者的屏幕轨。
 * 流程是"SFU 出 offer、浏览器回 answer"，与发布方向相反。
 */
export async function subscribeScreen(
  publisherSessionId: string,
  trackNames: string[],
): Promise<ScreenSubscription> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  // 任一步失败都要关掉半开的 PC，别让连接和 ICE 状态泄漏
  try {
    return await subscribeScreenInner(pc, publisherSessionId, trackNames);
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
): Promise<ScreenSubscription> {
  // 所有收到的轨并进同一个 MediaStream：<video> 一个 srcObject 全搞定
  // （视频轨渲染画面、音频轨经元素出声——用户在放大层里控制音量）。
  const stream = new MediaStream();
  pc.ontrack = (event) => {
    stream.addTrack(event.track);
  };

  const session = await postJson("/sessions/new", null);
  const sessionId = str(session["sessionId"]);
  if (!sessionId) throw new Error("SFU 未返回 sessionId");

  const result = await postJson(`/sessions/${sessionId}/tracks/new`, {
    tracks: trackNames.map((trackName) => ({
      location: "remote",
      sessionId: publisherSessionId,
      trackName,
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
