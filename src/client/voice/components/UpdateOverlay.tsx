import { useEffect, useState } from "react";

import pigRunUrl from "../assets/pig-run.webp?url";
import pigIdleUrl from "../assets/pig-idle.webp?url";

/**
 * 桌面端更新进度覆盖层（进度条 = 小猪往前跑）。
 *
 * 背景：点「立即更新」后，之前下载/安装全程没有任何反馈（Rust 侧回调是空的），
 * 用户盯着界面不知道在干嘛。现在 Rust 在下载中发 `update:progress`
 * （限流 ~8 次/秒）、下载完发 `update:phase: installing`。这里：
 * - 全屏覆盖层钉在客户端界面最上层（窗口本身也会被置顶）；
 * - 进度条做成跑道：小猪按进度从左跑到右，跑到头＝下载完成；
 * - 装完切"马上自动重启"，重启只发生在更新完整结束之后。
 *
 * 网页版没有这些事件（isDesktop=false 时不注册监听，组件不渲染任何东西）。
 * 调试预览：URL 加 ?update-demo 会模拟一次 7MB 下载，方便目检这套动画。
 */

interface ProgressPayload {
  downloaded: number;
  total: number | null;
}

interface PhasePayload {
  phase: "installing" | "error";
  message?: string | null;
}

type Phase = "idle" | "downloading" | "installing";

function formatMb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function UpdateOverlay() {
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    const demo = typeof location !== "undefined" && location.search.includes("update-demo");
    if (!isDesktop && !demo) return;

    // 调试预览：模拟 7MB 下载（6 秒跑完），用来目检跑道动画
    if (demo && !isDesktop) {
      const totalBytes = 7_359_891;
      let done = 0;
      const timer = window.setInterval(() => {
        done = Math.min(totalBytes, done + totalBytes / 60);
        setTotal(totalBytes);
        setDownloaded(done);
        setPhase("downloading");
        if (done >= totalBytes) {
          window.clearInterval(timer);
          setPhase("installing");
        }
      }, 100);
      return () => window.clearInterval(timer);
    }

    let disposed = false;
    let unlisten: Array<() => void> = [];
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const offProgress = await listen<ProgressPayload>("update:progress", (event) => {
          setDownloaded(event.payload.downloaded);
          setTotal(event.payload.total);
          setPhase("downloading");
        });
        const offPhase = await listen<PhasePayload>("update:phase", (event) => {
          if (event.payload.phase === "installing") setPhase("installing");
          // 出错时原生弹窗会说明原因，这里只把进度层收起来
          else if (event.payload.phase === "error") setPhase("idle");
        });
        if (disposed) {
          offProgress();
          offPhase();
          return;
        }
        unlisten = [offProgress, offPhase];
      } catch {
        // 事件系统不可用就当没有这个覆盖层（更新本身不受影响）
      }
    })();
    return () => {
      disposed = true;
      for (const off of unlisten) off();
    };
  }, []);

  if (phase === "idle") return null;

  const percent =
    total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  const pigLeft = percent === null ? null : `${Math.min(97, Math.max(3, percent))}%`;

  return (
    <div className="vx-update-layer" role="alert" aria-live="polite">
      <div className="vx-update-card">
        <b className="vx-update-title">
          {phase === "downloading" ? "正在下载新版本" : "正在安装新版本"}
        </b>

        {/* 跑道：小猪按进度往前跑，跑到头 = 下载完成 */}
        <div className="vx-update-track" data-phase={phase}>
          <span className="vx-update-runway" />
          <i
            className="vx-update-fill"
            style={{ width: percent === null && phase === "downloading" ? "0%" : `${percent ?? 100}%` }}
          />
          <img
            className="vx-update-pig"
            src={phase === "downloading" ? pigRunUrl : pigIdleUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            style={pigLeft === null ? undefined : { left: pigLeft }}
            data-indeterminate={percent === null && phase === "downloading" ? "1" : "0"}
          />
        </div>

        {phase === "downloading" ? (
          <>
            <p className="vx-update-note">
              {percent === null
                ? `已下载 ${formatMb(downloaded)}`
                : `已下载 ${formatMb(downloaded)} / ${formatMb(total!)}（${percent}%）`}
            </p>
            <p className="vx-update-sub">下载完成后自动安装，安装完成才会重启</p>
          </>
        ) : (
          <>
            <p className="vx-update-note">小猪正在搬运新版本…</p>
            <p className="vx-update-sub">安装完成后会自动重启，房间与设置都会保留</p>
          </>
        )}
      </div>
    </div>
  );
}
