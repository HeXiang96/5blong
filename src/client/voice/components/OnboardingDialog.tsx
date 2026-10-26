import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { ONBOARDING_ITEMS, markOnboardingSeen } from "../onboarding";

/**
 * 首次打开的功能导览弹窗。
 *
 * 适配铁律（业主强调）：**只用 --vx-* 主题变量**，不写死任何颜色——
 * 这样浅色×四时段（白天/清晨/傍晚/夜晚自动入夜）与手动深色五种调色板
 * 全部自动跟随。布局复用反馈弹窗那套外壳（`.vx-feedback` 系列共享同一组样式），
 * 宽度 `min(560px,100%)`、限高 `min(88dvh,720px)`、≤560px 贴底铺满。
 *
 * 展示时机由 App 决定（首页首次渲染后）；本组件只管渲染与关闭。
 */
export function OnboardingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // ESC = 知道了（等同于关闭并标记已读）
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
    markOnboardingSeen();
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
        className="vx-feedback vx-onboard"
        role="dialog"
        aria-modal="true"
        aria-label="5blong 功能介绍"
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="vx-feedback-body">
          <p className="vx-onboard-hello">
            <span className="vx-onboard-pig">🐷</span>
            <span>
              欢迎来 <strong>5blong</strong>
            </span>
          </p>
          <p className="vx-onboard-sub">
            免注册就能开房：发个房号或链接，朋友点开就进。想有"自己的房间"再登录。
          </p>

          <ul className="vx-onboard-list">
            {ONBOARDING_ITEMS.map((item) => (
              <li className="vx-onboard-item" key={item.title}>
                <span className="vx-onboard-ico" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="vx-onboard-text">
                  <b>{item.title}</b>
                  <span>{item.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <footer className="vx-feedback-foot vx-onboard-foot">
          <span className="vx-onboard-hint">以后可在 设置 → 功能介绍 重看</span>
          <button type="button" className="vx-btn" onClick={dismiss}>
            开始使用
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
