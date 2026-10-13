import { useEffect, useState } from "react";

import pigRunUrl from "../assets/pig-run.webp?url";
import pigIdleUrl from "../assets/pig-idle.webp?url";

/**
 * 桌面端更新流程的全部界面（主题化，替代原生白框弹窗）。
 *
 * 与 Rust 侧的事件协议：
 * - `update:phase`     { phase: "checking" | "installing" | "error" }
 * - `update:available` { version, current }   发现新版本 → 木牌确认框
 * - `update:notice`    { kind, text }         检查结果 / 错误说明
 * - `update:progress`  { downloaded, total }  下载进度（小猪往前跑）
 * 确认下载走 `start_update_download` 命令；重启只发生在安装完整结束之后。
 *
 * 网页版没有这些事件（isDesktop=false 时不注册监听，组件不渲染）。
 * 调试预览：URL 加 ?update-demo=bar（下载）/ ?update-demo=available（确认框）。
 */

interface ProgressPayload {
  downloaded: number;
  total: number | null;
}

interface PhasePayload {
  phase: "checking" | "installing" | "error";
  message?: string | null;
}

interface AvailablePayload {
  version: string;
  current: string;
}

interface NoticePayload {
  kind: "info" | "error";
  text: string;
}

type Phase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "notice";

function formatMb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function UpdateOverlay() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [available, setAvailable] = useState<AvailablePayload | null>(null);
  const [notice, setNotice] = useState<NoticePayload | null>(null);
  const [current, setCurrent] = useState("");

  useEffect(() => {
    const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    const demo = typeof location !== "undefined" && location.search.includes("update-demo");
    if (!isDesktop && !demo) return;

    if (demo && !isDesktop) {
      // 调试预览：?update-demo=available 看确认框，=bar 看小猪下载
      if (location.search.includes("update-demo=available")) {
        setPhase("available");
        setAvailable({ version: "1.0.8", current: "1.0.7" });
      } else {
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
      return;
    }

    let disposed = false;
    let unlisten: Array<() => void> = [];
    void (async () => {
      try {
        const [{ listen }, { getVersion: v }] = await Promise.all([
          import("@tauri-apps/api/event"),
          import("@tauri-apps/api/app"),
        ]);
        void v().then(setCurrent).catch(() => {});
        const offs = await Promise.all([
          listen<PhasePayload>("update:phase", (event) => {
            const { phase: p, message } = event.payload;
            if (p === "checking") setPhase("checking");
            else if (p === "installing") setPhase("installing");
            else if (p === "error") {
              setPhase("notice");
              setNotice({ kind: "error", text: message ?? "更新出错" });
            }
          }),
          listen<AvailablePayload>("update:available", (event) => {
            setAvailable(event.payload);
            setPhase("available");
          }),
          listen<NoticePayload>("update:notice", (event) => {
            setPhase("notice");
            setNotice(event.payload);
          }),
          listen<ProgressPayload>("update:progress", (event) => {
            setDownloaded(event.payload.downloaded);
            setTotal(event.payload.total);
            setPhase("downloading");
          }),
        ]);
        if (disposed) {
          for (const off of offs) off();
          return;
        }
        unlisten = offs;
      } catch {
        // 事件系统不可用就当没有这个覆盖层（更新本身不受影响）
      }
    })();
    return () => {
      disposed = true;
      for (const off of unlisten) off();
    };
  }, []);

  /** 木牌确认框里的「立即更新」：Rust 侧开始下载，进度由已有事件驱动。 */
  const startDownload = () => {
    const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isDesktop) return;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("start_update_download"))
      .catch(() => {});
  };

  if (phase === "idle") return null;

  const percent =
    total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  const pigLeft = percent === null ? null : `${Math.min(97, Math.max(3, percent))}%`;

  // —— 木牌确认框：发现新版本 ——
  if (phase === "available" && available) {
    return (
      <div className="vx-update-layer" role="alertdialog" aria-live="polite">
        <div className="vx-update-card">
          <b className="vx-update-title">发现新版本 v{available.version}</b>
          <p className="vx-update-note">
            当前 v{available.current || current}。这次更新带来新内容与修复，
            下载时可以看到进度。
          </p>
          <div className="vx-update-actions">
            <button type="button" className="vx-btn vx-btn-primary" onClick={startDownload}>
              立即更新
            </button>
            <button type="button" className="vx-btn" onClick={() => setPhase("idle")}>
              稍后再说
            </button>
          </div>
        </div>
      </div>
    );
  }

  // —— 检查中 / 结果提示（木牌风，替代原生消息框）——
  if (phase === "checking" || phase === "notice") {
    return (
      <div className="vx-update-layer" role="alert" aria-live="polite">
        <div className="vx-update-card">
          {phase === "checking" ? (
            <p className="vx-update-note">正在检查更新…</p>
          ) : (
            <>
              <b
                className={`vx-update-title${notice?.kind === "error" ? " vx-update-title-err" : ""}`}
              >
                {notice?.kind === "error" ? "更新遇到问题" : "检查更新"}
              </b>
              <p className="vx-update-note">{notice?.text}</p>
              <div className="vx-update-actions">
                <button type="button" className="vx-btn" onClick={() => setPhase("idle")}>
                  知道了
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // —— 下载（小猪往前跑）/ 安装 ——
  return (
    <div className="vx-update-layer" role="alert" aria-live="polite">
      <div className="vx-update-card">
        <b className="vx-update-title">
          {phase === "downloading" ? "正在下载新版本" : "正在安装新版本"}
        </b>

        {/* 跑道：底部进度填充，小猪按进度往前跑（跑到头 = 下载完成） */}
        <div className="vx-update-track" data-phase={phase}>
          <i
            className="vx-update-fill"
            style={{
              width:
                percent === null && phase === "downloading" ? "0%" : `${percent ?? 100}%`,
            }}
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
