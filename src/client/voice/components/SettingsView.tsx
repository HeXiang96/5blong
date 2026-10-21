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
import { listLoopbackTargets } from "../loopback";
import { Avatar, Toggle } from "./ui";
import { HealthCheck } from "./HealthCheck";

type Tab = "profile" | "audio" | "shortcuts" | "help";

/** 滑条填充比例（Webkit 不支持原生 progress，用 CSS 变量画渐变）。 */
const rangeStyle = (pct: number): CSSProperties =>
  ({ "--vx-range-pct": `${pct}%` }) as CSSProperties;

export function SettingsView({
  identity,
  settings,
  onSave,
  onClose,
  onNotice,
  onOpenFeedback,
  onOpenOnboarding,
  onExportDiagnostics,
}: {
  identity: Identity;
  settings: VoiceSettings;
  onSave: (identity: Identity, settings: VoiceSettings) => void;
  onClose: () => void;
  onNotice: (kind: "info" | "error", text: string) => void;
  /** 打开意见反馈弹窗（App 层的 FeedbackDialog） */
  onOpenFeedback: (errorText?: string) => void;
  /** 回看首次打开的功能导览 */
  onOpenOnboarding: () => void;
  /** 导出诊断包（引擎状态 + 每条链路 stats + 最近事件），用于排查问题 */
  onExportDiagnostics: () => void;
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
  /** "只采集某个应用"的候选列表（仅桌面客户端能枚举）。 */
  const [loopTargets, setLoopTargets] = useState<{ pid: number; name: string }[]>([]);
  const stopTest = useRef<(() => void) | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  /** 桌面客户端（Tauri）：托盘等相关说明只在客户端里展示。 */
  const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const refreshLoopTargets = async () => {
    if (!isDesktop) return;
    const list = await listLoopbackTargets();
    setLoopTargets(list);
  };

  const refreshDevices = async () => {
    const groups = await listDevices();
    setMics(groups.mics);
    setSpeakers(groups.speakers);
  };

  useEffect(() => {
    void refreshLoopTargets();
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
          <button
            type="button"
            className={`vx-tab${tab === "shortcuts" ? " vx-tab-on" : ""}`}
            onClick={() => setTab("shortcuts")}
          >
            快捷方式
          </button>
          <button
            type="button"
            className={`vx-tab${tab === "help" ? " vx-tab-on" : ""}`}
            onClick={() => setTab("help")}
          >
            帮助
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
        ) : tab === "audio" ? (
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
              <label className="vx-field">
                <span className="vx-field-label">共享时带上系统声音</span>
                <Toggle
                  checked={voice.shareAudio}
                  label="共享时带上系统声音"
                  onChange={(next) => setVoice((prev) => ({ ...prev, shareAudio: next }))}
                />
              </label>
              <small>
                客户端共享时会自动排除本应用的语音（不会把你听到的人声再采一遍），所以不会再出现回声；
                网页版拿不到这个能力，共享声音仍可能有回声。
              </small>
              <label className="vx-field">
                <span className="vx-field-label">老系统回退时压低房间声音</span>
                <Toggle
                  checked={voice.shareFallbackDuck}
                  label="老系统回退时压低房间声音"
                  onChange={(next) => setVoice((prev) => ({ ...prev, shareFallbackDuck: next }))}
                />
              </label>
              <small>
                个别老系统不支持"按应用取声音"，只能整机采集——那种情况共享音频里会带上房间人声。
                打开后会在共享期间把别人说话压到 15%，几乎听不出回声（你自己也会觉得声音变小）。
              </small>

              {isDesktop ? (
                <div className="vx-field">
                  <span className="vx-field-label">只共享这个应用的声音</span>
                  <select
                    className="vx-input"
                    value={String(voice.shareAppPid ?? "")}
                    onChange={(event) => {
                      const raw = event.target.value;
                      setVoice((prev) => ({ ...prev, shareAppPid: raw ? Number(raw) : null }));
                    }}
                  >
                    <option value="">整机（自动排除本应用人声）</option>
                    {loopTargets.map((target) => (
                      <option key={target.pid} value={String(target.pid)}>
                        {target.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="vx-menu-btn" onClick={() => void refreshLoopTargets()}>
                    刷新正在出声的应用
                  </button>
                  <small>
                    选一个应用就只采它的声音，通知音、音乐、别的软件都不会混进共享音频。
                    列表只显示"此刻正在出声"的程序——先让游戏/视频出点声再刷新。
                  </small>
                </div>
              ) : null}
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
        ) : (
          <>
            <section className="vx-card">
              <h3 className="vx-card-title">房间内快捷键</h3>
              <ul className="vx-shortcuts">
                <li>
                  <span className="vx-keys">
                    <kbd>Ctrl</kbd>
                    <kbd>Shift</kbd>
                    <kbd>M</kbd>
                  </span>
                  <span>静音 / 取消静音（被房主禁言时不可用）</span>
                </li>
                <li>
                  <span className="vx-keys">
                    <kbd>Ctrl</kbd>
                    <kbd>Shift</kbd>
                    <kbd>C</kbd>
                  </span>
                  <span>打开 / 收起聊天</span>
                </li>
                <li>
                  <span className="vx-keys">
                    <kbd>Ctrl</kbd>
                    <kbd>Shift</kbd>
                    <kbd>D</kbd>
                  </span>
                  <span>闭听 / 取消闭听</span>
                </li>
                <li>
                  <span className="vx-keys">
                    <kbd>Esc</kbd>
                  </span>
                  <span>关闭弹出的面板</span>
                </li>
              </ul>
              <small>在聊天输入框里打字时快捷键自动让位，不会误触；人在游戏里也能直接按。</small>
            </section>

            <section className="vx-card">
              <h3 className="vx-card-title">桌面客户端怎么用更省心</h3>
              {isDesktop ? (
                <ul className="vx-shortcuts vx-shortcuts-plain">
                  <li>
                    <b>托盘常驻</b>
                    <span>点窗口右上角 × 只是收进托盘，语音继续、不断线；想真退出走托盘右键的「退出」。</span>
                  </li>
                  <li>
                    <b>托盘菜单</b>
                    <span>左键点托盘图标立即显示窗口；右键菜单有「显示 5blong / 检查更新 / 退出」。</span>
                  </li>
                  <li>
                    <b>重复启动</b>
                    <span>再点一次图标不会开第二个进程，只会把已有窗口带到前台。</span>
                  </li>
                  <li>
                    <b>自动更新</b>
                    <span>启动时自动检查新版本；更新时显示下载进度（小猪跑给你看），安装完成后自动重启。</span>
                  </li>
                  <li>
                    <b>麦克风免授权</b>
                    <span>客户端自动放行麦克风权限，不用每次弹系统确认框。</span>
                  </li>
                </ul>
              ) : (
                <small>
                  当前是网页版。安装 Windows 客户端后：托盘常驻（关窗口不掉线）、全局快捷键、
                  自动更新、麦克风免授权，长时间挂机也更省资源更流畅。
                </small>
              )}
            </section>

          </>
        )}

        {tab === "help" ? (
          <>
            <section className="vx-card">
              <h3 className="vx-card-title">一键体检</h3>
              <small>
                进房前先自查：麦克风有没有声、扬声器响不响、中转线路通不通。
                哪一环亮 ✕ 一眼看清，不用再猜"到底是谁的问题"。
              </small>
              <HealthCheck settings={settings} triggerLabel="开始体检" triggerClass="vx-btn vx-btn-small" />
            </section>

            <section className="vx-card">
              <h3 className="vx-card-title">功能介绍</h3>
              <small>
                第一次用？看一眼四个要点就上手了：开房邀请、开麦说话、一起看屏幕、客户端的好处。
              </small>
              <button type="button" className="vx-btn vx-btn-small" onClick={() => onOpenOnboarding()}>
                看功能介绍
              </button>
            </section>

            <section className="vx-card">
              <h3 className="vx-card-title">意见反馈</h3>
              <small>
                遇到问题、或者想提个建议，直接说就行——会<b>自动附带版本号、系统与网络类型</b>，
                你不用自己找。能复现的都会进修复清单。出错的提示条上也有「反馈此问题」可以一键带上现场。
              </small>
              <button type="button" className="vx-btn vx-btn-small" onClick={() => onOpenFeedback()}>
                写一条反馈
              </button>
            </section>

            <section className="vx-card">
              <div className="vx-field">
                <span className="vx-field-label">遇到问题？导出一份诊断信息</span>
                <button type="button" className="vx-menu-btn" onClick={onExportDiagnostics}>
                  <Sparkles size={14} /> 导出诊断信息
                </button>
                <small>
                  包含当前连接状态、每条语音链路的直连/中继与丢包延迟、最近的自动重连记录。
                  不含 IP、账号与聊天内容，只保存在你本机，可自行发给我们排查。
                </small>
              </div>

              <h3 className="vx-card-title">几个常见问题</h3>
              <ul className="vx-shortcuts vx-shortcuts-plain">
                <li>
                  <b>听不到别人说话 / 别人听不到我</b>
                  <span>先确认双方都是最新版本；进房默认静音，点麦克风图标才是开麦。</span>
                </li>
                <li>
                  <b>共享屏幕时没有声音</b>
                  <span>需要 1.4.7 及以上的客户端；观众要点幕布打开音量。网页版在部分声卡上拿不到系统声音，建议用客户端。</span>
                </li>
                <li>
                  <b>说话有回声</b>
                  <span>共享声音时用外放，声音会被麦克风二次拾取——戴耳机即可。</span>
                </li>
                <li>
                  <b>觉得对方声音小</b>
                  <span>点对方的猪头 → 音量拉到 200%；自己麦克风小可以在音量菜单里增强到 300%。</span>
                </li>
                <li>
                  <b>跨网络进不了房间</b>
                  <span>双方更新到最新版再试；仍不行就在反馈里写明双方网络环境。</span>
                </li>
                <li>
                  <b>提示「浏览器没有 WebRTC / 不支持」</b>
                  <span>先在<b>无痕窗口</b>打开同一个链接：能进 → 是<b>扩展插件</b>在拦 WebRTC
                  （防泄漏类最常见，去扩展里关掉它的 WebRTC 拦截即可）；还不行 → 多半是在
                  QQ / 微信里直接点开的<b>内置浏览器</b>，请复制链接到 Chrome / Edge，或用桌面客户端。</span>
                </li>
              </ul>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
