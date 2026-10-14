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
   * 设置结构版本（用于迁移）。
   * v2 起把"传输方式"的缺省从 p2p 改成 auto——旧配置里的 p2p 是当年的**默认值**
   * 而不是用户主动选择，所以无版本号时按 auto 迁移；用户之后手动选过就保留。
   */
  settingsVersion?: number;
}

/** 屏幕共享画质档位（定义在 screen-share.ts，这里只引用字面量类型）。 */
export type ShareQuality = "hd720" | "fhd1080";

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
    shareQuality: "fhd1080",
    shareTransport: "auto",
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
    stored.micVolume <= 2
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
    shareQuality: stored.shareQuality === "hd720" ? "hd720" : "fhd1080",
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
