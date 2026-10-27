import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { forgetAutoplayElement, onAutoplayBlocked } from "../media-unlock";
import { Maximize2, Minimize2, Volume2, VolumeX, X } from "lucide-react";

import { FIRE_POS, PROJ_POS, SCREEN_POS, feetViewportPx } from "../pen";
import type { ScreenShareState, ScreenViewPreference } from "../protocol";
import { readJson, writeJson } from "../storage";
import {
  canProbeShareAudio,
  probeHardwareEncoders,
  SHARE_QUALITY_PRESETS,
  formatScreenLayers,
  simulcastLayerLabel,
  summarizeScreenReport,
  type RateSample,
} from "../screen-share";
import { isTauriRuntime } from "../loopback";
import { watchBlackFrames } from "../video-health";
import { collectDeviceProfile } from "../device-profile";

// ---------------------------------------------------------------- 灯箱音量记忆

const TV_AUDIO_KEY = "5blong:v1:tvAudio";

interface TvAudio {
  volume: number;
  muted: boolean;
  /** 灯箱最大化偏好（有人喜欢铺满整窗看）。 */
  big?: boolean;
}

/** 读取上次的灯箱音量/最大化偏好（没有记录 / 数据坏掉 → 默认开声、100%、窗口化）。 */
function loadTvAudio(): TvAudio {
  const stored = readJson<Partial<TvAudio>>(TV_AUDIO_KEY, {});
  return {
    volume:
      typeof stored.volume === "number" && stored.volume >= 0 && stored.volume <= 1
        ? stored.volume
        : 1,
    muted: stored.muted === true,
    big: stored.big === true,
  };
}

/**
 * 围炉看投影：坡上内嵌幕布（常驻）+ 投影仪（共享时从天而降）+ 光束 + 放大灯箱。
 *
 * 构图（业主标注版）：
 * - 幕布内嵌在坡上居中偏上，宽屏 16:9，没共享时是暗玻璃；
 * - 点共享：投影仪从天上掉下来落在居中靠下的草地（掉落/回弹/尘土/闷响），
 *   亮机后一道光束打到幕布上，幕布亮出共享画面；
 * - 停播：画面雪花 2s → 幕布熄灭，投影仪腾空飞走；
 * - 猪群在幕布下方两翼围坐（左翼面右、右翼面左），篝火在两翼中间靠后。
 *
 * 位置用视口脚部带（与猪/蔬菜同一套映射），任何窗口尺寸都落在同一相对高度。
 */

/** 掉落动画时长（与 CSS --vx-tv-drop 对齐）。 */
const DROP_MS = 900;
/** 飞走动画时长（比掉落略慢，回味感）。 */
const LEAVE_MS = 1050;
/** 停播后雪花多久才熄幕。 */
const SNOW_BEFORE_OFF_MS = 1600;
/** 幕布宽度（占舞台宽比例）与上下留边。 */
const SCREEN_WIDTH_RATIO = 0.44;

type TvPhase = "absent" | "dropping" | "live" | "leaving";

/** 计算舞台内锚点的纵向 px（相对舞台底）：视口脚部带 → 舞台内 bottom。 */
function anchorBottomPx(lane: number, stageBottomGap: number) {
  return Math.max(0, feetViewportPx(lane, window.innerHeight) - stageBottomGap);
}// ---------------------------------------------------------------------------
// 篝火（常驻布景）
// ---------------------------------------------------------------------------

/** 火堆：石圈 + 架着的木柴 + 三簇跳动火苗 + 火星 + 夜间暖光。 */
export function Campfire({ stageWidth, stageBottomGap }: { stageWidth: number; stageBottomGap: number }) {
  if (stageWidth <= 0) return null;
  const left = FIRE_POS.x * stageWidth;
  const bottom = anchorBottomPx(FIRE_POS.lane, stageBottomGap);
  return (
    <div className="vx-fire" style={{ left: `${left.toFixed(1)}px`, bottom: `${bottom.toFixed(1)}px` }} aria-hidden="true">
      <span className="vx-fire-glow" />
      <span className="vx-fire-ember vx-fire-ember-1" />
      <span className="vx-fire-ember vx-fire-ember-2" />
      <span className="vx-fire-ember vx-fire-ember-3" />
      <svg viewBox="0 0 96 60" className="vx-fire-svg">
        <g className="vx-fire-flames">
          <path className="vx-flame vx-flame-c" d="M48 4 C58 16 66 24 66 36 C66 47 58 53 48 53 C38 53 30 47 30 36 C30 24 38 16 48 4 Z" fill="#f59e42" opacity="0.92" />
          <path className="vx-flame vx-flame-b" d="M48 16 C55 24 60 30 60 38 C60 46 55 50 48 50 C41 50 36 46 36 38 C36 30 41 24 48 16 Z" fill="#f97316" />
          <path className="vx-flame vx-flame-a" d="M48 28 C52 33 55 37 55 42 C55 47 52 49 48 49 C44 49 41 47 41 42 C41 37 44 33 48 28 Z" fill="#fde047" />
        </g>
        <rect x="20" y="46" width="56" height="9" rx="4.5" fill="#8d6534" transform="rotate(7 48 50)" />
        <rect x="22" y="47" width="52" height="8" rx="4" fill="#a87c44" transform="rotate(-9 48 51)" />
        <ellipse cx="14" cy="55" rx="8" ry="4.4" fill="#9d988c" />
        <ellipse cx="82" cy="55" rx="8" ry="4.4" fill="#a49f94" />
        <ellipse cx="30" cy="58" rx="7" ry="3.8" fill="#8f8a7e" />
        <ellipse cx="66" cy="58" rx="7" ry="3.8" fill="#b3aea2" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 投影幕布 + 投影仪（一个组件管两个锚点，共享同一套阶段机）
// ---------------------------------------------------------------------------

interface PenTVProps {
  /** 房主广播的共享状态；null = 没人在共享（投影仪不在场，幕布暗着）。 */
  state: ScreenShareState | null;
  /** 订阅/本机采集到的画面流；null = 幕布暗屏。 */
  stream: MediaStream | null;
  stageWidth: number;
  stageHeight: number;
  stageBottomGap: number;
  /** 放大灯箱打开时为 true：暂停小幕布的视频（省一路 1080p 解码，观众端不卡）。 */
  paused?: boolean;
  /** 点击幕布（放大）。 */
  onExpand: () => void;
}

export function PenTV({ state, stream, stageWidth, stageHeight: stageH, stageBottomGap, paused, onExpand }: PenTVProps) {
  const [phase, setPhase] = useState<TvPhase>("absent");
  /** 停播后先雪花一会儿再熄幕：用 leaving 前的缓冲表达"节目结束"。 */
  const [snowing, setSnowing] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 状态 → 阶段机
  useEffect(() => {
    if (state) {
      setSnowing(false);
      setPhase((prev) => (prev === "absent" ? "dropping" : prev === "leaving" ? "dropping" : prev));
      return;
    }
    if (phase === "absent") return;
    if (phase === "dropping") {
      // 掉到一半就停播：照样落地（live）再走散场，不播"半空折返"的怪动画
      const timer = window.setTimeout(() => {
        setPhase("live");
        setSnowing(true);
        window.setTimeout(() => setPhase("leaving"), SNOW_BEFORE_OFF_MS);
      }, Math.max(0, DROP_MS));
      return () => window.clearTimeout(timer);
    }
    if (phase === "live") {
      setSnowing(true);
      const timer = window.setTimeout(() => setPhase("leaving"), SNOW_BEFORE_OFF_MS);
      return () => window.clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // 阶段定时器
  useEffect(() => {
    if (phase === "dropping") {
      const timer = window.setTimeout(() => setPhase("live"), DROP_MS);
      return () => window.clearTimeout(timer);
    }
    if (phase === "leaving") {
      const timer = window.setTimeout(() => setPhase("absent"), LEAVE_MS);
      return () => window.clearTimeout(timer);
    }
  }, [phase]);

  // 画面流进 <video>（paused：灯箱打开时暂停小幕布解码，省一路 1080p 解码）
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (stream && !paused) {
      video.srcObject = stream;
      void video.play().catch(() => {/* 自动播放被拦时静音重试一次 */ video.muted = true; void video.play().catch(() => {}); });
    } else if (paused) {
      video.pause();
    } else {
      video.srcObject = null;
    }
  }, [stream, phase, paused]);

  if (stageWidth <= 0) return null;

  // 幕布：居中偏上，宽 44%（上限 560px），16:9；共享时才从上方放绳降下。
  // 分辨率适配：幕布高度不超过舞台的 52%，矮窗口自动缩，绝不压进猪群活动区。
  const maxByHeight = stageH * 0.52 * (16 / 9);
  const screenW = Math.min(stageWidth * SCREEN_WIDTH_RATIO, 560, maxByHeight);
  const screenLeft = SCREEN_POS.x * stageWidth;
  const screenTop = Math.max(8, stageH * 0.03);
  // 绳索要一直连到页面顶边（顶部木牌的吊钩位置），而不是只到舞台顶
  const stageAbsTop = Math.max(0, window.innerHeight - stageBottomGap - stageH);
  const ropeH = screenTop + stageAbsTop;

  // 投影仪：居中靠下的草地
  const projLeft = PROJ_POS.x * stageWidth;
  const projBottom = anchorBottomPx(PROJ_POS.lane, stageBottomGap);

  // 光束：从投影仪顶部到幕布下沿（挂在幕布下面，负向生长）
  const projDeviceH = 46;
  const screenFrameH = screenW * (9 / 16) + 16; // 16:9 面 + 木框
  const beamH = Math.max(
    0,
    stageH - projBottom - projDeviceH - (screenTop + screenFrameH),
  );

  const showVideo = phase === "live" && stream && !snowing;

  return (
    <>
      {/*
        吊装幕布：只在共享时出现——两根绳索从坡顶吊下来，开播时整块幕布
        沿绳"放"下来（translateY 进场），停播时收回去。没共享时是暗玻璃。
      */}
      {phase !== "absent" ? (
        <div
          className={`vx-screen-wall vx-screen-${phase}${snowing ? " vx-screen-snowing" : ""}${phase === "live" ? " vx-screen-on" : ""}`}
          style={{ left: `${screenLeft.toFixed(1)}px`, top: `${screenTop.toFixed(1)}px`, width: `${screenW.toFixed(1)}px` }}
        >
          {/* 双绳：一直连到页面顶边（顶部木牌吊钩那一排），不是断在半空 */}
          <span className="vx-screen-rope vx-screen-rope-l" style={{ height: `${ropeH.toFixed(1)}px` }} aria-hidden="true" />
          <span className="vx-screen-rope vx-screen-rope-r" style={{ height: `${ropeH.toFixed(1)}px` }} aria-hidden="true" />
          <button
            type="button"
            className="vx-screen-frame"
            onClick={phase === "live" && !snowing ? onExpand : undefined}
            title={phase === "live" && !snowing ? "点击放大画面" : undefined}
            tabIndex={phase === "live" && !snowing ? 0 : -1}
            aria-hidden={phase !== "live"}
          >
            <span className="vx-screen-surface">
              {showVideo ? (
                <video ref={videoRef} className="vx-tv-video" autoPlay playsInline muted />
              ) : (
                <span className="vx-screen-dark" />
              )}
              <span className="vx-tv-scan" />
            </span>
          </button>
          {/* 投影光束：幕布下沿 → 投影仪（画在猪后面，z 更低） */}
          {phase === "live" && !snowing && beamH > 40 ? (
            <span className="vx-proj-beam" style={{ height: `${beamH.toFixed(1)}px` }} aria-hidden="true" />
          ) : null}
          {/* 幕布亮起时的环境光 */}
          <span className="vx-screen-glow" aria-hidden="true" />
        </div>
      ) : null}

      {/* 投影仪：只在共享期间在场——点共享才从天而降，停播时腾空飞走 */}
      {phase !== "absent" ? (
        <div
          className={`vx-tv vx-tv-${phase}${snowing ? " vx-tv-snowing" : ""}`}
          style={{ left: `${projLeft.toFixed(1)}px`, bottom: `${projBottom.toFixed(1)}px` }}
          aria-hidden={phase !== "live"}
        >
          {phase === "dropping" ? (
            <span className="vx-tv-dust" aria-hidden="true">
              <i className="vx-tv-puff vx-tv-puff-1" />
              <i className="vx-tv-puff vx-tv-puff-2" />
              <i className="vx-tv-puff vx-tv-puff-3" />
            </span>
          ) : null}
          <button type="button" className="vx-proj-body" tabIndex={-1} aria-hidden="true">
            <span className="vx-proj-shadow" aria-hidden="true" />
            <span className="vx-proj-lens">
              <i className="vx-proj-lens-glass" />
            </span>
            <span className="vx-proj-vents" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="vx-proj-foot vx-proj-foot-l" />
            <span className="vx-proj-foot vx-proj-foot-r" />
          </button>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 放大灯箱
// ---------------------------------------------------------------------------

interface PenTvLightboxProps {
  state: ScreenShareState;
  stream: MediaStream | null;
  sharerName: string;
  /**
   * 画面连接：共享者拿到的是**发送端**连接（看编码分辨率/实际码率/限流原因/
   * 编码器），观众拿到的是**订阅端**连接（看解码器/丢包/卡顿）。
   * 两端共用同一条数据条，方向由报告里实际存在的流自动判定。
   */
  pc?: RTCPeerConnection | null;
  /**
   * 观众端的画质偏好（只有观众才显示这三个按钮）。
   * 共享者看不到自己画面的"观感"，这个开关归观众。
   */
  viewMode?: ScreenViewPreference;
  onViewMode?: (mode: ScreenViewPreference) => void;
  /** 观众端"延迟换稳定"档位（画面与共享声音成对排队）。 */
  latency?: "low" | "balanced" | "smooth";
  onLatency?: (mode: "low" | "balanced" | "smooth") => void;
  /** 本机就是共享者时为 true（不显示观众的画质开关）。 */
  isSharer?: boolean;
  onClose: () => void;
}

/** 点击幕布弹出的放大层：16:9 大画面 + 来源标签 + 音量（共享带声音时）。 */
export function PenTvLightbox({
  state,
  stream,
  sharerName,
  pc,
  viewMode,
  onViewMode,
  latency,
  onLatency,
  isSharer,
  onClose,
}: PenTvLightboxProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /*
   * 音量/静音**持久化**：以前是组件内 state，关一次灯箱就丢——用户调好的音量
   * 再打开又回到 100%（2026-10-16 业主反馈）。现在读写 localStorage（本机记忆）。
   * 打开灯箱是用户点击手势，可以直接出声；首次使用默认开音量。
   * 场景里的小幕布依旧保持静音防双声（与本记忆无关）。
   */
  const [muted, setMuted] = useState(() => loadTvAudio().muted);
  /** 自动播放被拦：声音还没解锁，界面上给一个"点一下开启"的提示。 */
  const [needsTap, setNeedsTap] = useState(false);
  /**
   * 共享声音的客观读数（2026-10-26 加）：
   * 「没有声音」到底卡在哪一段，靠这个一次分清——
   *   音轨 0        → 共享者根本没把音轨发过来；
   *   音轨 1 · 电平 0% → 音轨在，但内容是静音（采集端没抓到，如游戏走了非默认设备）；
   *   音轨 1 · 电平 >0 → 数据是好的，问题在本机播放（静音/音量/路由）。
   */
  const [audioInfo, setAudioInfo] = useState<{ tracks: number; level: number } | null>(null);
  const [volume, setVolume] = useState(() => loadTvAudio().volume);
  /** 最大化：铺满整窗 + 尽量申请系统全屏（有人喜欢放最大看，偏好记住）。 */
  const [big, setBig] = useState(() => loadTvAudio().big === true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    writeJson(TV_AUDIO_KEY, { volume, muted, big } satisfies TvAudio);
  }, [volume, muted, big]);
  /*
   * 挂载时**不再**申请系统全屏：桌面端（WebView2）在 portal 元素刚挂载时 requestFullscreen，
   * 偶发整窗空白（业主 2026-10-26 报"点开灯箱白屏、什么都没有"）。
   * `big` 记忆只决定 CSS 铺满；真正进系统全屏要用户点右上角「最大化」。
   */
  /**
   * 实时链路数据（每 2s 刷新）：一眼看清卡在编码、传输还是解码。
   *
   * 这份读数就是"档位到底生效没有"的答案：
   * - `发出 1920×1080` —— 编码器实际输出（被降分辨率时会变）；
   * - `h264 MediaFoundation 硬编` —— 有没有吃到 NVENC；
   * - `带宽受限` / `CPU 受限` —— 链路不够，还是编码器没吃到硬件；
   * - 观众端则看 `解码器 / 卡顿 / 丢包`（软解会显示"软解"）。
   */
  const [stats, setStats] = useState("");
  const [statsRole, setStatsRole] = useState<"send" | "recv" | null>(null);
  /**
   * simulcast 多档时的**逐层**读数（主层 + 半档 + 省流各多少码率）。
   * 没有它就会闹出"发出 353×254 · 480 kbps"这种误导——那只是三层里最小的 q 层。
   */
  const [layers, setLayers] = useState("");

  useEffect(() => {
    if (!pc) {
      setStats("");
      setStatsRole(null);
      setLayers("");
      return;
    }
    let prev: RateSample | null = null;
    const timer = window.setInterval(async () => {
      try {
        const summary = summarizeScreenReport(await pc.getStats(), prev);
        prev = summary.sample;
        setLayers(formatScreenLayers(summary.layers));
        if (!summary.text) return;
        let text = summary.text;
        /*
         * 观众端额外显示"当前订阅到哪一层"：simulcast 发布时 SFU 会按观众网络
         * 挑层（f/h/q），实收分辨率 ÷ 发布档位高度就能推出来。
         * 有了这行，观众第一次能看见"我其实只拿到了 1/4 的层"（而不是只看到"糊"）。
         */
        if (state.simulcast && summary.role === "recv" && state.quality) {
          const layer = simulcastLayerLabel(
            SHARE_QUALITY_PRESETS[state.quality].height,
            summary.height,
          );
          if (layer) text += ` · 订阅层 ${layer}`;
        }
        setStats(text);
        setStatsRole(summary.role);
      } catch {
        /* 连接关闭后的取数失败，忽略 */
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pc, state.simulcast, state.quality]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (stream) {
      video.srcObject = stream;
      void video.play().catch(() => {
        /*
         * 被自动播放策略拦了。先静音播（保证有画面），再等用户任意一次点击开声
         * ——见 media-unlock.ts 的说明（WebView2 也拦）。
         */
        video.muted = true;
        void video.play().catch(() => {});
        onAutoplayBlocked(video, () => setNeedsTap(false));
        setNeedsTap(true);
      });
    } else {
      video.srcObject = null;
      setNeedsTap(false);
    }
    return () => forgetAutoplayElement(video);
  }, [stream]);

  /*
   * 画面健康探针：识别「解码器在出帧、画面却全黑」的硬件解码故障。
   *
   * 为什么必须自动识别：这种故障下码率/帧率/编码器读数**全部正常**
   * （实测 `1920×1088 · 32fps · 5226 kbps · H264 D3D11VideoDecoder 硬解 · 直连`），
   * 只有人眼能看出黑，于是观众只会说"我这边黑的"，共享者以为发出去了。
   *
   * 确诊后能做的事按平台不同（浏览器没有运行时关硬解的 API）：
   * - 桌面客户端：写兼容模式标记 → 下次启动给 WebView2 加
   *   `--disable-accelerated-video-decode`，**真正走软解**（画质不变，只是多占点 CPU）；
   * - 网页版：自动修不了，只能如实告诉用户换客户端 / 关浏览器硬件加速。
   */
  const [blackWarn, setBlackWarn] = useState<string | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) {
      setBlackWarn(null);
      return;
    }
    return watchBlackFrames(video, {
      onDiagnosed: (info) => {
        void (async () => {
          if (!isTauriRuntime()) {
            setBlackWarn(
              `画面全黑 ${info.seconds} 秒（期间解出 ${info.frames} 帧）——本机硬件解码异常。网页版无法自动修复：请改用桌面客户端，或在浏览器设置里关掉"使用硬件加速"后重试`,
            );
            return;
          }
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("set_playback_compat", { softDecode: true });
            setBlackWarn(
              `画面全黑 ${info.seconds} 秒（期间解出 ${info.frames} 帧）——本机硬件解码异常。已切到兼容模式（软件解码），**重启客户端后生效**`,
            );
          } catch {
            setBlackWarn(
              `画面全黑 ${info.seconds} 秒（期间解出 ${info.frames} 帧）——本机硬件解码异常，建议在设置里开启"关闭硬件解码"`,
            );
          }
        })();
      },
    });
  }, [stream]);

  /*
   * 本机设备画像（只读展示）。
   *
   * 为什么放在灯箱里：观众报"我这边黑的"时，最缺的信息是**人家是什么机器**——
   * 光看码率和帧率全是正常的。把 GPU 型号和"能硬解哪些格式"摆在数据行上，
   * 一眼就能对上"某某显卡 + D3D11 硬解"这类已知故障，不用再反复问。
   */
  const [devLine, setDevLine] = useState("");
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const probe = await probeHardwareEncoders(state.quality ?? "fhd1080");
        const dev = await collectDeviceProfile(probe);
        if (!alive) return;
        const dec = dev.dec?.length ? `硬解 ${dev.dec.join("/")}` : "无硬解";
        setDevLine([dev.gpu, dev.os, dec].filter(Boolean).join(" · "));
      } catch {
        if (alive) setDevLine("");
      }
    })();
    return () => {
      alive = false;
    };
  }, [state.quality]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
    video.volume = volume;
  }, [muted, volume]);

  /*
   * 共享声音的电平探针（只读，不影响播放）。
   *
   * ⚠️ 两个坑，都会让**整个应用白屏**（effect 里抛错 = React 卸载整棵树）：
   *   1. 流里**没有音轨**时 `createMediaStreamSource` 直接抛 InvalidStateError——
   *      后进房间的人刚好就是这种流（画面先到、声音后到或根本没开声音）；
   *   2. 音频上下文数量超限 / 浏览器不支持时 `new AudioContext()` 也会抛。
   * 所以：先看有没有音轨，整段再包一层 try/catch，最坏情况只是不显示电平。
   */
  useEffect(() => {
    // 先保证流在（TS 收窄），再保证里面有音轨（没有音轨时 createMediaStreamSource 会抛）
    if (!stream || !canProbeShareAudio(stream)) {
      setAudioInfo(null);
      return;
    }
    let ctx: AudioContext;
    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
      ctx = new AudioContext();
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
    } catch {
      setAudioInfo(null);
      return;
    }
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let peak = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const magnitude = Math.abs(buffer[i]!);
        if (magnitude > peak) peak = magnitude;
      }
      setAudioInfo({
        tracks: stream.getAudioTracks().length,
        level: Math.round(peak * 100),
      });
    }, 500);
    return () => {
      window.clearInterval(timer);
      void ctx.close().catch(() => {});
    };
  }, [stream]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 全屏中按 ESC：先让浏览器退全屏，这一次不关灯箱。
      if (document.fullscreenElement) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    // 放大时暂停场景里的全部无限动画（火苗/雪花/光束…）：
    // 它们在灯箱背后持续抢合成器时间，会让视频解码渲染发抖
    document.documentElement.classList.add("vx-lightbox-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("vx-lightbox-open");
    };
  }, [onClose]);

  /** 最大化 / 还原：CSS 铺满整窗，并尝试同步系统全屏（失败只影响全屏不影响铺满）。 */
  const toggleBig = () => {
    setBig((prev) => {
      const next = !prev;
      if (next) {
        void rootRef.current?.requestFullscreen?.().catch(() => {});
      } else if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
      return next;
    });
  };

  return createPortal(
    /*
     * 背景**不再**点击关闭（2026-10-16 业主反馈：看共享时误点空白处，画面直接被关掉）。
     * 关闭只走两个明确入口：ESC / 右上角 ×。
     */
    <div
      ref={rootRef}
      className={`vx-tv-lightbox${big ? " vx-tv-max" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="共享屏幕（放大）"
    >
      <div className="vx-tv-stagebig" onClick={(event) => event.stopPropagation()}>
        <header className="vx-tv-bighead">
          <span className="vx-tv-bigdot" />
          <strong>{sharerName} 的屏幕</strong>
          <span className="vx-tv-biglabel">{state.label || "屏幕共享"}</span>
          {/*
           * 明确标出画面走的哪条路（P2P 直连 / SFU 转发）。
           * 数据条上只有"直连 / 经中继"——那是 ICE 层的候选类型，SFU 模式下
           * 客户端到边缘节点本来就是直连，所以**看不出到底走没走转发**；
           * 排查时（"这次测的到底是哪条路"）来回猜过一轮，这里直接写出来。
           */}
          <span className={`vx-tv-mode${state.transport === "sfu" ? " vx-tv-mode-sfu" : ""}`}>
            {state.transport === "sfu" ? "SFU 转发" : "P2P 直连"}
          </span>
          <button
            type="button"
            className="vx-icon-btn"
            onClick={toggleBig}
            aria-label={big ? "退出最大化" : "最大化"}
            title={big ? "还原窗口大小" : "铺满整窗（偏好会记住）"}
          >
            {big ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <button type="button" className="vx-icon-btn" onClick={onClose} aria-label="关闭放大画面">
            <X size={18} />
          </button>
        </header>
        <div className="vx-tv-bigscreen">
          {stream ? (
            <video ref={videoRef} className="vx-tv-bigvideo" autoPlay playsInline muted={muted} />
          ) : (
            <div className="vx-tv-bigsnow">
              <span className="vx-tv-snow" />
              <p>画面传输中断，幕布在放雪花…</p>
            </div>
          )}
        </div>
        <footer className="vx-tv-bigfoot">
          {/*
            底部拆两行：数据行（每 2 秒变长）独占一行且定高省略号，
            控件行位置恒定——以前挤在同一排，数据一变按钮就来回跳（业主实拍"UI 来回变"）。
          */}
          <div className="vx-tv-statsline">
            {stats ? (
              /*
               * 设备信息放 **tooltip**，不进可视行。
               * 2026-10-27：一开始把它当第四个 chip 塞进这一行，直接把行撑高、
               * 下面的画质/音量按钮被挤出可视区（业主截图："都挡住了我看都不到按钮"）。
               * 数据行本来就已有 链路/声音/三层 三个 chip，屏幕共享自己也是文字密集
               * 画面，任何额外可见文字都会抢空间——需要排障时鼠标悬停即可。
               */
              <span
                className="vx-tv-stats"
                title={
                  devLine
                    ? `实时链路数据（每 2 秒刷新）｜本机 ${devLine}`
                    : "实时链路数据（每 2 秒刷新）"
                }
              >
                {statsRole === "send" ? "[发送端] " : statsRole === "recv" ? "[接收端] " : ""}
                {stats}
              </span>
            ) : null}
            {/*
              硬件解码故障提示。复用 `.vx-tv-audio-bad` 的"坏读数"配色，
              不新增样式——数据行是定高省略的一排，多一个自定义类只会多一处要维护。
            */}
            {blackWarn ? (
              <span className="vx-tv-audio vx-tv-audio-bad" title={blackWarn}>
                ⚠ {blackWarn}
              </span>
            ) : null}
            {audioInfo ? (
              <span
                className={`vx-tv-audio${audioInfo.tracks === 0 || audioInfo.level === 0 ? " vx-tv-audio-bad" : ""}`}
                title="共享声音的原始读数：音轨数 / 电平。0 音轨=没发过来；电平 0%=发过来是静音"
              >
                {audioInfo.tracks === 0
                  ? "声音：无音轨"
                  : `声音：${audioInfo.tracks} 轨 · 电平 ${audioInfo.level}%`}
              </span>
            ) : null}
            {/* 多档发布时把三层各自的码率摊开——"码率低在哪一层"一眼可见 */}
            {layers ? (
              <span className="vx-tv-layers" title="simulcast 各层读数（f 主层 / h 半档 / q 省流）">
                三层：{layers}
              </span>
            ) : null}
            {/* 本机 GPU / OS / 硬解能力只放进上面那条的 tooltip——数据行已经塞不下了 */}
          </div>
          <div className="vx-tv-controls">
          {stream ? (
            <>
              {/* 观众的画质开关：换来的是"发送端按你的偏好降档"（P2P）
                  或"订阅到哪一层"（SFU 多档）。共享者不显示；
                  **单档转发时它什么也改不了**（SFU 不能转码），所以这时不显示，
                  免得给人一个按了没反应的按钮。
                  按钮用 `.vx-tv-ctrl`（灯箱专用胶囊），**不要**复用 `.vx-menu-btn`
                  —— 那是弹层里的竖排全宽按钮（width:100%），塞进横排会被挤成
                  一个字一行，激活色还是"危险红"（业主实拍反馈）。 */}
              {!isSharer && onViewMode && (state.transport === "p2p" || state.simulcast === true) ? (
                <div
                  className="vx-tv-viewmode"
                  role="group"
                  aria-label="画质偏好"
                  title="按你的观感调：清晰优先保文字清楚，流畅优先保不卡"
                >
                  <span className="vx-tv-pref-label">画质</span>
                  {(
                    [
                      { key: "auto", name: "自动" },
                      { key: "detail", name: "清晰" },
                      { key: "motion", name: "流畅" },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className="vx-tv-ctrl"
                      onClick={() => onViewMode(item.key)}
                      aria-pressed={(viewMode ?? "auto") === item.key}
                      title={
                        item.key === "detail"
                          ? "清晰优先：宁可掉帧，文字更清楚（看文档/代码）"
                          : item.key === "motion"
                            ? "流畅优先：宁可糊一点，画面更跟手（看游戏/视频）"
                            : "自动：交给发送端按链路自己调"
                      }
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              ) : null}
              {!isSharer && onLatency ? (
                <div
                  className="vx-tv-viewmode"
                  role="group"
                  aria-label="延迟档位"
                  title="卡就把延迟调大：多等一会儿换画面不卡（画面与声音一起延迟）"
                >
                  <span className="vx-tv-pref-label">延迟</span>
                  {(
                    [
                      { key: "low", name: "跟手", tip: "最低延迟（≤0.5 秒）：看操作最跟手，网络抖一下会花屏" },
                      { key: "balanced", name: "平衡", tip: "自适应 0.2~1.2 秒：多数情况够用" },
                      { key: "smooth", name: "更稳", tip: "固定 1.5 秒以上：基本不卡，代价是明显滞后（看视频/直播）" },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className="vx-tv-ctrl"
                      onClick={() => onLatency(item.key)}
                      aria-pressed={(latency ?? "balanced") === item.key}
                      title={item.tip}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              ) : null}
              {/*
                自动播放被拦时给一条**显式**提示：以前这里静默失败，
                用户只看到"声音已开"却没声音（2026-10-26 房间统计里那几条
                "浏览器拦截了自动播放"就是它）。点一下即可开声。
              */}
              {needsTap && muted ? (
                <button
                  type="button"
                  className="vx-tv-ctrl vx-tv-tap-hint"
                  onClick={() => {
                    setMuted(false);
                    setNeedsTap(false);
                    const video = videoRef.current;
                    if (video) {
                      video.muted = false;
                      void video.play().catch(() => {});
                    }
                  }}
                  title="系统拦了自动播放，点这里或点画面任意处即可开启声音"
                >
                  🔇 点一下开声
                </button>
              ) : null}
              <div className="vx-tv-volume">
                <button
                  type="button"
                  className="vx-tv-ctrl"
                  onClick={() => setMuted((m) => !m)}
                  aria-pressed={!muted}
                  title={muted ? "点一下开启画面声音" : "画面声音已开"}
                >
                  {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                  {muted ? "开声音" : "声音已开"}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={(event) => {
                    setVolume(Number(event.target.value));
                    setMuted(Number(event.target.value) === 0);
                  }}
                  className="vx-range"
                  aria-label="音量"
                  /*
                   * 灯箱里以前**没设这个变量**：滑块按真实音量走，填充条却停在默认
                   * 50% —— 看着像"音量条坏了一半"（业主实拍反馈"太丑"的一部分）。
                   */
                  style={{ "--vx-range-pct": `${Math.round(volume * 100)}%` } as CSSProperties}
                />
              </div>
            </>
          ) : null}
          <span className="vx-tv-bighint">ESC 或右上角 × 关闭</span>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
