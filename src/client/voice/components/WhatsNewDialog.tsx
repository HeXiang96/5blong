import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { Film, Home, Headphones, Stethoscope, Target, VolumeX } from "lucide-react";

import { WHATS_NEW, markWhatsNewSeen, type WhatsNewIcon } from "../whats-new";

/** 图标名 → 组件（不用 emoji：部分环境缺 emoji 字体，会渲染成方块）。 */
const ICONS: Record<WhatsNewIcon, typeof Target> = {
  headphones: Headphones,
  mute: VolumeX,
  target: Target,
  film: Film,
  pulse: Stethoscope,
  home: Home,
};

/**
 * 「大更新」公告弹窗：首次打开（或内容版本 +1 之后）弹一次。
 *
 * 外壳复用导览/反馈弹窗那套（`.vx-feedback` + `.vx-onboard`），
 * 只用 --vx-* 主题变量，浅色/深色/四时段配色都自动跟随。
 * 展示时机由 App 决定，本组件只管渲染与关闭。
 */
export function WhatsNewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const dismiss = () => {
    markWhatsNewSeen();
    onClose();
  };

  return createPortal(
    <div
      className="vx-feedback-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        className="vx-feedback vx-onboard vx-whatsnew"
        role="dialog"
        aria-modal="true"
        aria-label="5blong 更新说明"
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="vx-feedback-body">
          <h2 className="vx-whatsnew-title">{WHATS_NEW.title}</h2>
          <p className="vx-whatsnew-lead">{WHATS_NEW.lead}</p>
          <ul className="vx-whatsnew-list">
            {WHATS_NEW.items.map((item) => {
              const Icon = ICONS[item.icon];
              return (
                <li key={item.title} className="vx-whatsnew-item">
                  <span className="vx-whatsnew-emoji" aria-hidden="true">
                    <Icon size={15} />
                  </span>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.body}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="vx-whatsnew-actions">
            <button type="button" className="vx-btn vx-btn-primary" onClick={dismiss}>
              知道了
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
