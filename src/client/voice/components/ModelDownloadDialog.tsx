import { useState } from "react";
import { createPortal } from "react-dom";
import { downloadModel } from "../ns-deepfilter";

/**
 * DeepFilterNet3 模型下载对话框（2026-11-04）。
 *
 * 硬性要求（业主定的）：
 * - 挂在 <body> 最外层（React Portal），z-index 顶格——**绝不允许被房间 UI /
 *   游戏画布吞掉**；
 * - 文案明确"史上最强的降噪模型，推荐下载"；
 * - 进度条 + 重试；点"暂不"本次不再弹（下次打开 5blong 仍会提醒，模型没下就一直提醒）。
 */

const Z_TOP = 2147483647;

interface Props {
  /** 关闭 = 用户点了"暂不"（下次打开还会提醒）或下载完成。 */
  onClose: (downloaded: boolean) => void;
}

export function ModelDownloadDialog({ onClose }: Props) {
  const [state, setState] = useState<"idle" | "downloading" | "done" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  const start = () => {
    setState("downloading");
    setError("");
    downloadModel((value) => setProgress(value))
      .then(() => {
        setState("done");
        // 让用户看到"完成"再收掉
        setTimeout(() => onClose(true), 1200);
      })
      .catch((err: unknown) => {
        setState("error");
        setError(String((err as Error)?.message ?? err).slice(0, 120));
      });
  };

  const pct = Math.round(progress * 100);
  const mb = ((progress * 17.4) || 0).toFixed(1);

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z_TOP,
        background: "rgba(15, 18, 25, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        style={{
          width: "min(420px, calc(100vw - 48px))",
          background: "var(--vx-panel, #fff)",
          color: "var(--vx-text, #26221c)",
          borderRadius: 16,
          padding: "22px 24px 18px",
          boxShadow: "0 18px 60px rgba(0,0,0,.35)",
          border: "1px solid rgba(0,0,0,.08)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 17, fontWeight: 700 }}>
          ✨ AI 智能降噪升级
        </div>
        <p style={{ margin: "12px 0 4px", lineHeight: 1.7, fontSize: 14 }}>
          这是<b>有史以来最强的开源降噪模型</b>（DeepFilterNet3）：键盘敲击、零食袋、
          打字声这类杂音都能明显压住。<b>推荐下载！</b>
        </p>
        <p style={{ margin: "4px 0 14px", lineHeight: 1.6, fontSize: 13, opacity: 0.75 }}>
          约 17MB，只需下载这一次，以后打开 5blong 不再重复下载。下载后自动生效，无需任何设置。
        </p>

        {state === "idle" && (
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={start}
              style={{
                flex: 1,
                padding: "10px 0",
                borderRadius: 10,
                border: "none",
                background: "var(--vx-accent, #c47b3d)",
                color: "#fff",
                fontWeight: 700,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              立即下载（推荐）
            </button>
            <button
              onClick={() => onClose(false)}
              style={{
                padding: "10px 16px",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,.15)",
                background: "transparent",
                color: "inherit",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              暂不
            </button>
          </div>
        )}

        {(state === "downloading" || state === "done") && (
          <div>
            <div
              style={{
                height: 10,
                borderRadius: 999,
                background: "rgba(0,0,0,.1)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${state === "done" ? 100 : pct}%`,
                  height: "100%",
                  borderRadius: 999,
                  background: "var(--vx-accent, #c47b3d)",
                  transition: "width .2s ease",
                }}
              />
            </div>
            <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
              {state === "done"
                ? "✅ 下载完成，进房自动生效"
                : `下载中… ${pct}%（${mb} / 17.4 MB），下载一次，永久有效`}
            </div>
          </div>
        )}

        {state === "error" && (
          <div>
            <div style={{ fontSize: 13, color: "#b3402e", marginBottom: 10 }}>
              下载失败：{error}。不下载也能用（自动换回老降噪），下次打开会再提醒。
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={start}
                style={{
                  flex: 1,
                  padding: "10px 0",
                  borderRadius: 10,
                  border: "none",
                  background: "var(--vx-accent, #c47b3d)",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                重试
              </button>
              <button
                onClick={() => onClose(false)}
                style={{
                  padding: "10px 16px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,.15)",
                  background: "transparent",
                  color: "inherit",
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                暂不
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
