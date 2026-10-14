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

/**
 * 档位码率：**匹配链路**而不是"堆高"（SCREENSHARE-PERF-PLAN §P0-1）。
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
  hd720: { label: "高清 HD 720p", width: 1280, height: 720, fps: 60, maxBitrate: 5_000_000 },
  fhd1080: { label: "超清 1080p", width: 1920, height: 1080, fps: 60, maxBitrate: 8_000_000 },
};

/**
 * 抖动缓冲目标（ms），按链路分级（SCREENSHARE-PERF-PLAN §P0-5）。
 *
 * 原先 P2P 与 SFU 一律 4000ms（规范上限），等于给"同城直连"也强加 4 秒排队，
 * 围炉看屏会对不上嘴。直连 RTT 通常 <50ms，600ms 足够吸收抖动；SFU 多为跨境
 * 转发，保留大缓冲换平滑（这类场景延迟不敏感）。
 */
export const JITTER_BUFFER_MS = {
  p2p: 600,
  sfu: 3000,
} as const;

/**
 * P2P 模式下"每路画面"的码率上限。
 *
 * 共享者要同时向 N 个观众各推一份（上行 ×N），不做分摊就是把家用上行打爆。
 * 下限 1.2 Mbps 兜住可看性——观众再多应该切 SFU，而不是继续摊薄。
 * （下限不随档位同步上浮：它是"分摊后别低于可看线"的保底，抬高了反而会让
 *  多人场景每路都超过档位本身，等于绕过分摊、把上行重新打爆。）
 */
export function perViewerBitrate(quality: ShareQuality, viewers: number): number {
  const cap = SHARE_QUALITY_PRESETS[quality].maxBitrate;
  const n = Math.max(1, Math.floor(viewers));
  return Math.max(1_200_000, Math.round(cap / n));
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

/**
 * P2P / SFU 传输方式的自动选择（SCREENSHARE-PERF-PLAN §P1-11）。
 *
 * P2P 的上行是"档位码率 × 观众数"：1~2 位观众时直连最省事、画质最好；
 * 3 人及以上时家用上行会被打爆（1080p@8M × 3 ≈ 24 Mbps），必须切 SFU 转发。
 * 用户的显式选择永远优先，"auto" 才按人数决定。
 */
export function autoTransportFor(
  preference: "p2p" | "sfu" | "auto",
  memberCount: number,
): { transport: "p2p" | "sfu"; reason: string } {
  if (preference === "p2p") return { transport: "p2p", reason: "你选了直连" };
  if (preference === "sfu") return { transport: "sfu", reason: "你选了 SFU 转发" };
  const viewers = Math.max(0, memberCount - 1);
  if (viewers <= 2) return { transport: "p2p", reason: `观众 ${viewers} 人，直连画质最好` };
  return { transport: "sfu", reason: `观众 ${viewers} 人，直连上行会打爆，自动走 SFU` };
}

/** getDisplayMedia 选择器提示项（Chromium 支持；TS 类型未收录，运行时透传）。
 *  注意：preferCurrentTab 与 selfBrowserSurface:"exclude" 互斥
 *  （Chromium 抛 TypeError: Self-contradictory configuration），
 *  不能同时开——这里保留"剔除自己页面"（防把房间网页共享进房间）。 */
export function pickerHints(): Record<string, unknown> {
  return {
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    monitorTypeSurfaces: "include",
    // 共享屏幕时带上系统声音（Windows 10 2004+ / 标签页声音）
    systemAudio: "include",
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
 * 两个已核实的事实（SCREENSHARE-PERF-PLAN §P0-3）：
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
          // simulcast 发布：逐层分配码率（层按 rid 顺序 f > h > q，逐层减半）；
          // 保留各层原有的 scaleResolutionDownBy / rid——那是发布时按 rid 定好的
          // 层结构，在这里改掉会把"多档"变成"三档一样大"。
          params.encodings = params.encodings.map((encoding, index) => ({
            ...encoding,
            maxBitrate: Math.round(baseBitrate / 2 ** index),
            maxFramerate: framerate,
          }));
        } else {
          params.encodings[0] = {
            ...params.encodings[0],
            maxBitrate: baseBitrate,
            maxFramerate: framerate,
            scaleResolutionDownBy: scale,
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

  let outbound: StatsEntry | null = null;
  let inbound: StatsEntry | null = null;
  for (const entry of entries) {
    if (entry.kind !== "video") continue;
    if (!outbound && entry.type === "outbound-rtp") outbound = entry;
    else if (!inbound && entry.type === "inbound-rtp") inbound = entry;
  }
  const target = outbound ?? inbound;
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

  const send = target === outbound;
  const codecEntry = target.codecId ? byId.get(String(target.codecId)) : undefined;
  const codec = (codecEntry?.mimeType ? String(codecEntry.mimeType) : "").replace(/^video\//i, "") || fallbackCodec;

  const bytes = send ? num(target["bytesSent"]) : num(target["bytesReceived"]);
  const ts = num(target["timestamp"]) || Date.now();
  const kbps = prev && ts > prev.ts ? Math.round(((bytes - prev.bytes) * 8) / (ts - prev.ts)) : 0;
  const sample: RateSample = { bytes, ts };

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
  parts.push(`${send ? "发出" : "收到"} ${width && height ? `${width}×${height}` : "?"}`);
  parts.push(`${fps || "?"} fps`);
  parts.push(`${kbps || "?"} kbps`);
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
    text: parts.join(" · "),
    sample,
  };
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
  /** 起始阶梯档（0 = 原始分辨率）。 */
  startStep?: number;
  /** 是否 simulcast 发布（多档编码时不做"总码率偏低"的推断）。 */
  simulcast?: boolean;
  /** 档位变化回调（界面可提示"已自动降到 720p"）。 */
  onStep?: (step: number, reason: string) => void;
}

export interface ScreenSenderTuner {
  stop: () => void;
  /** 码率上限变化（观众数增减）时重新下发，**保持当前阶梯档**。 */
  retune: (maxBitrate?: number) => void;
  step: () => number;
  applied: () => number;
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
 * 给一条画面发送链路挂上"自适应降档"（SCREENSHARE-PERF-PLAN §P0-4 / §P2-14）。
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
  let step = Math.min(Math.max(0, options.startStep ?? 0), RESOLUTION_LADDER.length - 1);
  let baseBitrate = options.maxBitrate;
  let strikes = 0;
  let healthy = 0;
  let stopped = false;
  let applications = 0;
  let prev: RateSample | null = null;

  const apply = () => {
    if (stopped || pc.connectionState === "closed") return;
    const scale = RESOLUTION_LADDER[step]!;
    void applyScreenSenderParams(pc, quality, {
      maxBitrate: baseBitrate,
      scaleResolutionDownBy: scale,
      // 降到 540p 及以下还带不动 60 帧，多半是 CPU/带宽双重吃紧：帧率也让一步
      maxFramerate: step >= 2 ? Math.min(30, preset.fps) : preset.fps,
    }).then((ok) => {
      if (ok) applications += 1;
    });
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
      if (strikes >= LIMIT_STRIKES && step < RESOLUTION_LADDER.length - 1) {
        step += 1;
        strikes = 0;
        apply();
        options.onStep?.(step, summary.limitation === "cpu" ? "cpu" : "bandwidth");
      }
      return;
    }
    strikes = 0;
    healthy += 1;
    if (healthy >= RECOVER_SAMPLES && step > 0) {
      step -= 1;
      healthy = 0;
      apply();
      options.onStep?.(step, "recover");
    }
  };

  apply();
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
    step: () => step,
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
 * 给画面连接挂"抖动自愈"（SCREENSHARE-PERF-PLAN §P2-13）。
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
  /** 预检是否真的跑过（浏览器没有 WebCodecs 时为 false，一律按"未探到"处理）。 */
  checked: boolean;
}

const NO_PROBE: HardwareCodecProbe = { h264: false, av1: false, checked: false };

/** 预检结果按会话缓存（同一台机器同一个浏览器，结果不会变）。 */
let probeCache: Promise<HardwareCodecProbe> | null = null;

interface VideoEncoderSupportResult {
  supported?: boolean;
  config?: { hardwareAcceleration?: string };
}

/**
 * 用 WebCodecs 问系统"有没有硬件编码单元"（SCREENSHARE-PERF-PLAN §O-3）。
 *
 * 比"建一条假连接跑 getStats"干净得多：不建连接、不造假流，一次调用出结果。
 * `hardwareAcceleration: "require-hardware"` 是关键——它要求系统必须用硬件编码，
 * 没有硬件单元时返回 supported:false（而不是悄悄给你一个软编）。
 *
 * 注意：这只是一道**预检**。Chromium 在真实协商里仍可能因配置不支持而静默回落
 * 软编，所以发布后必须以 `getStats` 的 `encoderImplementation` /
 * `powerEfficientEncoder` 复核（灯箱数据条就是干这个的）。
 */
export function probeHardwareEncoders(quality: ShareQuality): Promise<HardwareCodecProbe> {
  if (probeCache) return probeCache;
  const preset = SHARE_QUALITY_PRESETS[quality];
  probeCache = (async (): Promise<HardwareCodecProbe> => {
    const Encoder = (globalThis as { VideoEncoder?: { isConfigSupported?: unknown } }).VideoEncoder;
    const isConfigSupported = (Encoder as { isConfigSupported?: (config: unknown) => Promise<VideoEncoderSupportResult> })
      ?.isConfigSupported;
    if (typeof isConfigSupported !== "function") return NO_PROBE;
    const ask = async (codec: string): Promise<boolean> => {
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
    const [h264, av1] = await Promise.all([ask("avc1.640028"), ask("av01.0.08M.08")]);
    return { h264, av1, checked: true };
  })();
  return probeCache;
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
  const score = (mimeType: string): number => {
    switch (mimeType.toLowerCase()) {
      case "video/h264":
        return preferAv1 ? 1 : 0;
      case "video/av1":
        return preferAv1 ? 0 : 1;
      case "video/vp9":
        return 2;
      case "video/vp8":
        return 3;
      default:
        return 9; // rtx/red/flexfec 等辅助载荷保持原序靠后
    }
  };
  try {
    transceiver.setCodecPreferences([...caps.codecs].sort((a, b) => score(a.mimeType) - score(b.mimeType)));
  } catch {
    /* 忽略：回落浏览器默认编解码器 */
  }
}

/**
 * P2P 画面链路的 SDP 改写：把 `m=video` 里的 **H.264 载荷类型提到最前**。
 *
 * 为什么必须这么做（这是"P2P 也糊"的直接原因之一）：
 * PeerJS 自己创建 RTCPeerConnection、自己出 offer，我们**没有机会**在协商前调用
 * `setCodecPreferences`（那条路只有 SFU 的 `publishScreen` 走得到）。而浏览器默认的
 * `m=video` 顺序是 **VP8 在前** → P2P 画面协商到 VP8，**软件编码**；
 * 1080p60 下 VP8 软编 CPU 吃紧，编码器只能疯狂降质量 → 观众看到的就是"糊"。
 * 把 H264 提到首位后，对端（Chrome / Edge / Safari 都支持 H264）会协商到
 * **硬件编码**，同样的码率下画面干净得多。
 *
 * PeerJS 恰好留了一个口子：`peer.call(id, stream, { sdpTransform })` 会被
 * `Negotiator._makeOffer` 在 `createOffer` 之后、`setLocalDescription` 之前调用
 * （已读 peerjs 1.5.5 的 bundler.mjs:837 核对）。这里只重排顺序，不改任何语义。
 */
export function preferH264Sdp(sdp: string): string {
  if (!sdp) return sdp;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(eol);
  const codecOf = new Map<string, string>(); // 载荷类型 → 编码名（小写）
  for (const line of lines) {
    const match = /^a=rtpmap:(\d+)\s+([^/\s]+)/.exec(line);
    if (match) codecOf.set(match[1]!, match[2]!.toLowerCase());
  }
  const isH264 = (pt: string): boolean => codecOf.get(pt) === "h264";
  let changed = false;
  const out = lines.map((line) => {
    if (!line.startsWith("m=video")) return line;
    const fields = line.split(" ");
    if (fields.length <= 3) return line;
    const payloads = fields.slice(3);
    // Array.prototype.sort 是稳定排序：H264 整体前移，其余保持浏览器给的原序
    const ordered = [...payloads].sort((a, b) => Number(isH264(b)) - Number(isH264(a)));
    if (ordered.join(" ") === payloads.join(" ")) return line;
    changed = true;
    return [...fields.slice(0, 3), ...ordered].join(" ");
  });
  return changed ? out.join(eol) : sdp;
}

/** 画质档位与发送参数（P2P / SFU 两条链路共用同一套档位定义）。 */
export interface PublishScreenOptions {
  /** 画质档位（默认超清 1080p）。 */
  quality?: ShareQuality;
  /**
   * 带宽不足时的降级方向（SCREENSHARE-PERF-PLAN §P0-3）：
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
  /** 档位变化提示（自适应降分辨率时回调，界面可显示"已自动降到 720p"）。 */
  onStep?: (step: number, reason: string) => void;
}

/**
 * 把采集好的屏幕流发布到 SFU。
 *
 * `stream` 来自 getDisplayMedia（或调试用的 canvas.captureStream）。
 * 返回的 stop() 只管 SFU 侧的清理；停止采集（track.stop()）由调用方负责。
 *
 * simulcast 是"锦上添花"：失败就退回单档发布，绝不让开播因它失败。
 */
export async function publishScreen(
  stream: MediaStream,
  options: PublishScreenOptions = {},
): Promise<ScreenPublication> {
  if (!options.simulcast) return publishScreenOnce(stream, options);
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
    // 有硬件编码才允许把 AV1 提到 H.264 之前（P1-10）；预检结果进程内缓存
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
    setPreferredVideoCodecs(transceiver, probe.av1);
  }
  if (audioTrack) pc.addTransceiver(audioTrack, { direction: "sendonly" });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

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

  return { sessionId, hasAudio: Boolean(audioTrack), stop: () => void teardown(), pc };
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
  pc.ontrack = (event) => {
    stream.addTrack(event.track);
    if (event.receiver) {
      try {
        event.receiver.jitterBufferTarget = JITTER_BUFFER_MS.sfu;
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
  const simulcast = options.simulcast
    ? { preferredRid: options.preferredRid ?? "f", priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" }
    : undefined;
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
