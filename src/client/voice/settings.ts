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
}

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
    joinMuted: false,
    micVolume: 1,
    peerVolumes: {},
    peerMuted: {},
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
    joinMuted: stored.joinMuted === true,
    micVolume,
    peerVolumes:
      stored.peerVolumes && typeof stored.peerVolumes === "object" ? stored.peerVolumes : {},
    peerMuted: stored.peerMuted && typeof stored.peerMuted === "object" ? stored.peerMuted : {},
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
