import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Volume2, VolumeX, X } from "lucide-react";

import { FIRE_POS, PROJ_POS, SCREEN_POS, feetViewportPx } from "../pen";
import type { ScreenShareState, ScreenViewPreference } from "../protocol";
import {
  SHARE_QUALITY_PRESETS,
  simulcastLayerLabel,
  summarizeScreenReport,
  type RateSample,
} from "../screen-share";

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
  /** 本机就是共享者时为 true（不显示观众的画质开关）。 */
  isSharer?: boolean;
  onClose: () => void;
}

/** 点击幕布弹出的放大层：16:9 大画面 + 来源标签 + 音量（共享带声音时）。 */
export function PenTvLightbox({ state, stream, sharerName, pc, viewMode, onViewMode, isSharer, onClose }: PenTvLightboxProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // 打开灯箱是用户点击手势，可以直接出声（默认开音量；场景里的小幕布保持静音防双声）
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
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

  useEffect(() => {
    if (!pc) {
      setStats("");
      setStatsRole(null);
      return;
    }
    let prev: RateSample | null = null;
    const timer = window.setInterval(async () => {
      try {
        const summary = summarizeScreenReport(await pc.getStats(), prev);
        prev = summary.sample;
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
      void video.play().catch(() => {});
    } else {
      video.srcObject = null;
    }
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
    video.volume = volume;
  }, [muted, volume]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
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

  return createPortal(
    <div className="vx-tv-lightbox" onClick={onClose} role="dialog" aria-label="共享屏幕（放大）">
      <div className="vx-tv-stagebig" onClick={(event) => event.stopPropagation()}>
        <header className="vx-tv-bighead">
          <span className="vx-tv-bigdot" />
          <strong>{sharerName} 的屏幕</strong>
          <span className="vx-tv-biglabel">{state.label || "屏幕共享"}</span>
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
          {stats ? (
            <span className="vx-tv-stats" title="实时链路数据（每 2 秒刷新）">
              {statsRole === "send" ? "[发送端] " : statsRole === "recv" ? "[接收端] " : ""}
              {stats}
            </span>
          ) : null}
          {stream ? (
            <>
              {/* 观众的画质开关：换来的是"发送端按你的偏好降档"（P2P）
                  或"订阅到哪一层"（SFU）。共享者不显示。 */}
              {!isSharer && onViewMode ? (
                <div className="vx-tv-viewmode" role="group" aria-label="画质偏好">
                  {(
                    [
                      { key: "auto", name: "自动" },
                      { key: "detail", name: "清晰优先" },
                      { key: "motion", name: "流畅优先" },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`vx-menu-btn${(viewMode ?? "auto") === item.key ? " vx-menu-btn-active" : ""}`}
                      onClick={() => onViewMode(item.key)}
                      aria-pressed={(viewMode ?? "auto") === item.key}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                className={`vx-menu-btn${muted ? "" : " vx-menu-btn-active"}`}
                onClick={() => setMuted((m) => !m)}
              >
                {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                {muted ? "开启声音" : "声音已开"}
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
              />
            </>
          ) : null}
          <span className="vx-tv-bighint">ESC 或点击空白处关闭</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
