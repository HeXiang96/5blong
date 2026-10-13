import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Check, Copy, Sparkles, Trash2, Upload, Volume2 } from "lucide-react";

import { AVATAR_COLORS, initials, randomDisplayName, type Identity } from "../identity";
import {
  applyTheme,
  loadTheme,
  type ThemeChoice,
  type VoiceSettings,
} from "../settings";
import { saveIdentity } from "../identity";
import {
  canSelectSpeaker,
  listDevices,
  micErrorMessage,
  onDeviceChange,
  startMicTest,
  type DeviceOption,
} from "../devices";
import { toAvatarDataUrl } from "../storage";
import { Avatar, Toggle } from "./ui";

type Tab = "profile" | "audio";

/** 滑条填充比例（Webkit 不支持原生 progress，用 CSS 变量画渐变）。 */
const rangeStyle = (pct: number): CSSProperties =>
  ({ "--vx-range-pct": `${pct}%` }) as CSSProperties;

export function SettingsView({
  identity,
  settings,
  onSave,
  onClose,
  onNotice,
}: {
  identity: Identity;
  settings: VoiceSettings;
  onSave: (identity: Identity, settings: VoiceSettings) => void;
  onClose: () => void;
  onNotice: (kind: "info" | "error", text: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("profile");
  const [draft, setDraft] = useState<Identity>(identity);
  const [voice, setVoice] = useState<VoiceSettings>(settings);
  const [mics, setMics] = useState<DeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<DeviceOption[]>([]);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [testError, setTestError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(() => loadTheme());
  const stopTest = useRef<(() => void) | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const refreshDevices = async () => {
    const groups = await listDevices();
    setMics(groups.mics);
    setSpeakers(groups.speakers);
  };

  useEffect(() => {
    void refreshDevices();
    const off = onDeviceChange(() => void refreshDevices());
    return () => {
      off();
      stopTest.current?.();
    };
  }, []);

  const stopMicTest = () => {
    stopTest.current?.();
    stopTest.current = null;
    setTesting(false);
    setLevel(0);
  };

  const toggleTest = async () => {
    if (testing) {
      stopMicTest();
      return;
    }
    setTestError(null);
    try {
      const test = await startMicTest(voice, setLevel);
      stopTest.current = test.stop;
      setTesting(true);
    } catch (error) {
      setTesting(false);
      setTestError(micErrorMessage(error));
    }
  };

  const pickAvatar = async (file: File | undefined) => {
    if (!file) return;
    try {
      const dataUrl = await toAvatarDataUrl(file);
      setDraft((prev) => ({ ...prev, avatar: dataUrl }));
    } catch {
      onNotice("error", "这张图片无法读取，请换一张（支持 JPG / PNG / WebP）");
    }
  };

  const save = () => {
    stopMicTest();
    const name = draft.name.trim().slice(0, 24) || identity.name;
    const next = { ...draft, name };
    // 先落盘再交给上层，写失败要如实告知（localStorage 可能满）。
    if (!saveIdentity(next)) onNotice("error", "本地存储写入失败，头像可能过大");
    onSave(next, voice);
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(draft.personId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      onNotice("error", "复制失败，请手动选中复制");
    }
  };

  const speakerSelectable = canSelectSpeaker();

  return (
    <div className="vx-page vx-settings">
      <header className="vx-settings-top">
        <button type="button" className="vx-icon-btn" onClick={onClose} aria-label="返回">
          <ArrowLeft size={18} />
        </button>
        <div className="vx-tabs">
          <button
            type="button"
            className={`vx-tab${tab === "profile" ? " vx-tab-on" : ""}`}
            onClick={() => setTab("profile")}
          >
            个人资料
          </button>
          <button
            type="button"
            className={`vx-tab${tab === "audio" ? " vx-tab-on" : ""}`}
            onClick={() => setTab("audio")}
          >
            语音设备
          </button>
        </div>
        <button type="button" className="vx-icon-btn vx-icon-btn-primary" onClick={save} aria-label="保存">
          <Check size={18} />
        </button>
      </header>

      <div className="vx-settings-body">
        {tab === "profile" ? (
          <>
            <section className="vx-card">
              <div className="vx-profile">
                <Avatar avatar={draft.avatar} color={draft.color} name={draft.name} size={72} />
                <div className="vx-profile-side">
                  <button type="button" className="vx-btn vx-btn-small" onClick={() => fileInput.current?.click()}>
                    <Upload size={14} /> 上传头像
                  </button>
                  {draft.avatar ? (
                    <button
                      type="button"
                      className="vx-btn vx-btn-small vx-btn-danger"
                      onClick={() => setDraft((prev) => ({ ...prev, avatar: "" }))}
                    >
                      <Trash2 size={14} /> 移除
                    </button>
                  ) : null}
                  <small>上传的图片会压到 {192}px 再存本机</small>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => {
                    void pickAvatar(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </div>
            </section>

            <section className="vx-card">
              <label className="vx-field">
                <span className="vx-field-label">昵称</span>
                <input
                  className="vx-input"
                  value={draft.name}
                  maxLength={24}
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                />
              </label>
              <button
                type="button"
                className="vx-link-btn"
                onClick={() => setDraft((prev) => ({ ...prev, name: randomDisplayName() }))}
              >
                随机换一个昵称
              </button>

              <div className="vx-field">
                <span className="vx-field-label">头像颜色</span>
                <div className="vx-swatches">
                  {AVATAR_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`选择颜色 ${color}`}
                      className={`vx-swatch${draft.color === color ? " vx-swatch-on" : ""}`}
                      style={{ background: color }}
                      onClick={() => setDraft((prev) => ({ ...prev, color }))}
                    />
                  ))}
                </div>
              </div>

              <div className="vx-field">
                <span className="vx-field-label">个人 ID</span>
                <div className="vx-id-row">
                  <code className="vx-id">{draft.personId}</code>
                  <span className="vx-id-preview">{initials(draft.name)}</span>
                  <button type="button" className="vx-btn vx-btn-small" onClick={() => void copyId()}>
                    <Copy size={14} /> {copied ? "已复制" : "复制"}
                  </button>
                </div>
                <small>保存在本机，用于区分重名的人，不参与房间鉴权。</small>
              </div>
            </section>
          </>
        ) : (
          <>
            <section className="vx-card">
              <label className="vx-field">
                <span className="vx-field-label">
                  <Volume2 size={15} /> 麦克风
                </span>
                <select
                  className="vx-input"
                  value={voice.micDeviceId}
                  onChange={(event) =>
                    setVoice((prev) => ({ ...prev, micDeviceId: event.target.value }))
                  }
                >
                  <option value="">系统默认</option>
                  {mics.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="vx-field">
                <span className="vx-field-label">
                  <Volume2 size={15} /> 扬声器
                </span>
                <select
                  className="vx-input"
                  disabled={!speakerSelectable}
                  value={voice.speakerDeviceId}
                  onChange={(event) =>
                    setVoice((prev) => ({ ...prev, speakerDeviceId: event.target.value }))
                  }
                >
                  <option value="">系统默认</option>
                  {speakers.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.label}
                    </option>
                  ))}
                </select>
                {speakerSelectable ? null : (
                  <small>当前浏览器不支持在页面内切换扬声器，请用系统声音设置。</small>
                )}
              </label>

              <div className="vx-mic-test">
                <button
                  type="button"
                  className={`vx-btn vx-btn-small${testing ? " vx-btn-primary" : ""}`}
                  onClick={() => void toggleTest()}
                >
                  {testing ? "停止测试" : "测试麦克风"}
                </button>
                <div className="vx-level" role="meter" aria-label="麦克风电平">
                  <div className="vx-level-fill" style={{ width: `${Math.round(level * 100)}%` }} />
                </div>
              </div>
              {testError ? <p className="vx-field-error">{testError}</p> : null}
              <small>测试会用当前选择的麦克风，退出设置时自动停止。</small>
            </section>

            <section className="vx-card">
              <div className="vx-field">
                <span className="vx-field-label">
                  <Volume2 size={15} /> 麦克风音量 / 增强
                </span>
                <div className="vx-inline-range">
                  <input
                    type="range"
                    className="vx-range"
                    style={rangeStyle((voice.micVolume / 2) * 100)}
                    min={0}
                    max={2}
                    step={0.01}
                    value={voice.micVolume}
                    onChange={(event) =>
                      setVoice((prev) => ({
                        ...prev,
                        micVolume: Number(event.target.value),
                      }))
                    }
                  />
                  <span className="vx-inline-range-value">
                    {voice.micVolume > 1
                      ? `增强 ${Math.round(voice.micVolume * 100)}%`
                      : `${Math.round(voice.micVolume * 100)}%`}
                  </span>
                </div>
                <small>100% 为原始音量，再往上是麦克风增强；通话中拖动立即生效。</small>
              </div>
            </section>

            <section className="vx-card">
              <label className="vx-field">
                <span className="vx-field-label">进房默认静音</span>
                <Toggle
                  checked={voice.joinMuted}
                  label="进房默认静音"
                  onChange={(next) => setVoice((prev) => ({ ...prev, joinMuted: next }))}
                />
              </label>
            </section>

            <section className="vx-card">
              <h3>外观</h3>
              <div className="vx-field">
                <span className="vx-field-label">主题</span>
                <div className="vx-segments">
                  {(
                    [
                      ["system", "跟随系统"],
                      ["dark", "深色"],
                      ["light", "浅色"],
                    ] as [ThemeChoice, string][]
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`vx-segment${theme === value ? " vx-segment-on" : ""}`}
                      onClick={() => {
                        setTheme(value);
                        applyTheme(value);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="vx-card">
              <h3>语音处理</h3>
              <label className="vx-field">
                <span className="vx-field-label">
                  <Sparkles size={14} /> AI 智能降噪
                  <span className="vx-field-sub">RNNoise · 实时生效</span>
                </span>
                <Toggle
                  checked={voice.processing.noiseSuppression}
                  label="AI 智能降噪"
                  onChange={(next) =>
                    setVoice((prev) => ({
                      ...prev,
                      processing: { ...prev.processing, noiseSuppression: next },
                    }))
                  }
                />
              </label>
              <label className="vx-field">
                <span className="vx-field-label">回声消除</span>
                <Toggle
                  checked={voice.processing.echoCancellation}
                  label="回声消除"
                  onChange={(next) =>
                    setVoice((prev) => ({
                      ...prev,
                      processing: { ...prev.processing, echoCancellation: next },
                    }))
                  }
                />
              </label>
              <label className="vx-field">
                <span className="vx-field-label">自动增益</span>
                <Toggle
                  checked={voice.processing.autoGainControl}
                  label="自动增益"
                  onChange={(next) =>
                    setVoice((prev) => ({
                      ...prev,
                      processing: { ...prev.processing, autoGainControl: next },
                    }))
                  }
                />
              </label>
              <small>麦克风音量与 AI 智能降噪在通话中实时生效；回声消除、自动增益在下次进房时生效。</small>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
