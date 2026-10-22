/**
 * 语音设置。与旧版差异：
 * - 明确区分"设备选择"与"音质开关"，且每次进房重新读取，改完立刻生效。
 * - 语音处理开关只影响下一次采集，界面上如实说明（旧版没说明，用户以为即时生效）。
 */

import { readJson, writeJson } from "./storage";

export interface AudioProcessing {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/**
 * 音量上限（UI 滑块 / 持久化 / 引擎共用一份，避免三处各写一个数字）：
 * - MIC_VOLUME_MAX：自己麦克风的增强上限（3 = 300%）。有些设备采集电平天生低
 *   （USB 麦、Windows 麦克风级别被调小），200% 不够用；发送链尾部有软限幅兜底。
 * - PEER_VOLUME_MAX：别人声音的收听上限（2 = 200%）。>100% 不能再走
 *   `HTMLMediaElement.volume`（浏览器上限就是 1），由引擎的 Web Audio 增益链承担。
 */
export const MIC_VOLUME_MAX = 3;
export const PEER_VOLUME_MAX = 2;

export interface VoiceSettings {
  micDeviceId: string;
  speakerDeviceId: string;
  processing: AudioProcessing;
  /** 进入房间时默认静音。 */
  joinMuted: boolean;
  /**
   * 麦克风音量/增强（Web Audio 增益）：1 = 原始音量，0..1 调小，1..2 为增强。
   */
  micVolume: number;
  /** 对每个成员的本地收听音量（0..1），按 peerId 记录；只影响本机。 */
  peerVolumes: Record<string, number>;
  /** 对每个成员的本地静音（不接收其声音），按 peerId 记录；只影响本机。 */
  peerMuted: Record<string, boolean>;
  /**
   * 桌面端共享时是否带上系统声音（默认开）。
   *
   * 客户端用**进程级回环**采（整机混音 − 本应用），所以房间语音不会被采进去，
   * 观众不会听到"同一句话两遍"；网页版没有这条路，仍由选择器里的开关决定。
   */
  shareAudio: boolean;
  /**
   * 共享声音回退到"整机回环"时，是否自动压低房间语音（默认关）。
   *
   * 老系统（Win10 2004 以下）拿不到进程级采集，共享音频里会包含房间语音，
   * 观众就会听到回声。开了这个开关，回退发生时把本地播放压到 15%，
   * 回声几乎不可闻；代价是共享者自己听别人说话变小。
   */
  shareFallbackDuck: boolean;
  /**
   * 只采集这个进程声音（Windows 进程回环 INCLUDE）；null/undefined = 整机混音减去本应用。
   * 仅桌面客户端有效；网页版忽略。
   */
  shareAppPid?: number | null;
  /** 屏幕共享画质档位（720p60 / 1080p60）。 */
  shareQuality: ShareQuality;
  /**
   * 屏幕共享传输方式：
   * - `"auto"`（默认）：1~2 位观众走 P2P 直连（画质最好），3 人及以上自动切
   *   SFU 转发——P2P 的上行是"码率 × 观众数"，人多必炸家宽上行；
   * - `"p2p"` / `"sfu"`：显式指定，永远优先于自动判断。
   */
  shareTransport: "p2p" | "sfu" | "auto";
  /**
   * 观众端画质偏好（**看别人共享时**生效）：
   * - `"auto"`（默认）：跟随共享者的自动调节；
   * - `"detail"` 清晰优先：宁可掉帧也要文字清楚（看文档/代码/PPT）；
   * - `"motion"` 流畅优先：宁可变糊也要跟得上（看游戏/视频）。
   *
   * P2P 下经房主转达给共享者、只影响本机这一路发送链；SFU 下映射成订阅层
   * （清晰 = f 满档、流畅 = h 半档），切换时会重新订阅。
   */
  shareViewMode: "auto" | "detail" | "motion";
  /**
   * 观众端"延迟换稳定"的档位（**看别人共享时**生效）：
   * - `"low"` 低延迟：≤0.5 秒，适合看操作/游戏，抖动大时会卡；
   * - `"balanced"`（默认）：自适应 150~1200ms，抖动大自动加大；
   * - `"smooth"` 流畅优先：固定 1.5 秒以上（画面与共享声音一起延迟），
   *   换来基本不卡的观感，适合看视频/直播。
   */
  shareLatency: "low" | "balanced" | "smooth";
  /**
   * 设置结构版本（用于迁移）。
   * v2 起把"传输方式"的缺省从 p2p 改成 auto——旧配置里的 p2p 是当年的**默认值**
   * 而不是用户主动选择，所以无版本号时按 auto 迁移；用户之后手动选过就保留。
   */
  settingsVersion?: number;
}

/** 屏幕共享画质档位（定义在 screen-share.ts，这里只引用字面量类型）。 */
export type ShareQuality = "hd720" | "hd720p30" | "fhd1080" | "fhd1080p30";

export type ThemeChoice = "system" | "dark" | "light";

const KEY = "settings";
const THEME_KEY = "theme";

/** 主题：system 时跟随系统，否则锁定。写入后立刻反映到 <html data-theme>。 */
export function loadTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(`5blong:v1:${THEME_KEY}`);
    return raw === "dark" || raw === "light" ? raw : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: ThemeChoice): void {
  const prefersDark =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = theme === "system" ? (prefersDark ? "dark" : "light") : theme;
  document.documentElement.dataset["theme"] = resolved;
  try {
    localStorage.setItem(`5blong:v1:${THEME_KEY}`, theme);
  } catch {
    /* 存不下也不影响本次生效 */
  }
}

export function defaultSettings(): VoiceSettings {
  return {
    micDeviceId: "",
    speakerDeviceId: "",
    processing: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    joinMuted: true,
    micVolume: 1,
    peerVolumes: {},
    peerMuted: {},
    shareAudio: true,
    shareFallbackDuck: false,
    shareAppPid: null,
    shareQuality: "fhd1080",
    shareTransport: "auto",
    shareViewMode: "auto",
    shareLatency: "balanced",
    settingsVersion: 2,
  };
}

export function loadSettings(): VoiceSettings {
  const fallback = defaultSettings();
  const stored = readJson<Partial<VoiceSettings>>(KEY, {});
  const processing = (stored.processing ?? {}) as Partial<AudioProcessing>;
  const micVolume =
    typeof stored.micVolume === "number" &&
    Number.isFinite(stored.micVolume) &&
    stored.micVolume >= 0 &&
    stored.micVolume <= MIC_VOLUME_MAX
      ? stored.micVolume
      : fallback.micVolume;
  return {
    micDeviceId: typeof stored.micDeviceId === "string" ? stored.micDeviceId : fallback.micDeviceId,
    speakerDeviceId:
      typeof stored.speakerDeviceId === "string" ? stored.speakerDeviceId : fallback.speakerDeviceId,
    // 进房默认静音（2026-10-13 业主决定）；此字段暂无 UI，留作后续开关
    joinMuted: stored.joinMuted === true,
    micVolume,
    peerVolumes:
      stored.peerVolumes && typeof stored.peerVolumes === "object" ? stored.peerVolumes : {},
    peerMuted: stored.peerMuted && typeof stored.peerMuted === "object" ? stored.peerMuted : {},
    // 屏幕共享画质：默认超清 1080p；存量配置里没有该字段时也走默认
    shareAudio: stored.shareAudio !== false,
    shareFallbackDuck: stored.shareFallbackDuck === true,
    shareAppPid: typeof stored.shareAppPid === "number" ? stored.shareAppPid : null,
    shareQuality:
      stored.shareQuality === "hd720" ||
      stored.shareQuality === "hd720p30" ||
      stored.shareQuality === "fhd1080p30"
        ? stored.shareQuality
        : "fhd1080",
    // 屏幕共享传输：v2 起默认"自动"。无版本号的旧配置一律迁移到 auto
    // （那时的 p2p 是默认值而非用户选择）；显式选过 p2p/sfu 的照旧保留。
    shareTransport:
      stored.settingsVersion === 2
        ? stored.shareTransport === "p2p" || stored.shareTransport === "sfu"
          ? stored.shareTransport
          : "auto"
        : stored.shareTransport === "sfu"
          ? "sfu"
          : "auto",
    settingsVersion: 2,
    // 观众端画质偏好：存量配置没有该字段时走默认"自动"
    shareViewMode:
      stored.shareViewMode === "detail" || stored.shareViewMode === "motion"
        ? stored.shareViewMode
        : "auto",
    // 延迟档位：存量配置没有该字段时走默认"平衡"
    shareLatency:
      stored.shareLatency === "low" || stored.shareLatency === "smooth"
        ? stored.shareLatency
        : "balanced",
    processing: {
      echoCancellation: processing.echoCancellation !== false,
      noiseSuppression: processing.noiseSuppression !== false,
      autoGainControl: processing.autoGainControl !== false,
    },
  };
}

export function saveSettings(settings: VoiceSettings): boolean {
  return writeJson(KEY, settings);
}
