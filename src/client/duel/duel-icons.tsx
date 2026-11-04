/**
 * 对局图标（纯 SVG，不依赖 emoji 字体）。
 *
 * 为什么不用卡牌数据里的 emoji：`🐷` 这类字形在各系统上画法差异极大，
 * 小尺寸下还会糊成一坨，和木桌/纸牌的质感完全不搭（业主 2026-11-04 反馈）。
 * 这里按「系」给一个线稿图标，颜色由 CSS 的 currentColor 决定。
 */

import type { JSX } from "react";

/** 系别 → 图标 id。键与 duel-cards 里的 CardType 一致。 */
const TYPE_ICON: Record<string, string> = {
  aim: "i-aim",
  pig: "i-pig",
  power: "i-lock",
  drama: "i-mask",
  hot: "i-burst",
  show: "i-party",
  gun: "i-headset",
};

export function duelIconId(type?: string): string {
  return TYPE_ICON[type ?? ""] ?? "i-aim";
}

/** 一次渲染整套 symbol，挂在 .duel-root 里即可被 <use> 引用。 */
export function DuelIconDefs(): JSX.Element {
  return (
    <svg className="duel-icon-defs" aria-hidden="true" focusable="false">
      <defs>
        <symbol id="i-aim" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="7.2" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 1.6v4.2M12 18.2v4.2M1.6 12h4.2M18.2 12h4.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" />
        </symbol>

        <symbol id="i-burst" viewBox="0 0 24 24">
          <path d="M12 3.2 14 9l5.8-1.6L15.6 12l4.2 4.6L14 15l-2 5.8L10 15l-5.8 1.6L8.4 12 4.2 7.4 10 9z"
            fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
        </symbol>

        <symbol id="i-pig" viewBox="0 0 24 24">
          <ellipse cx="12" cy="12" rx="8.4" ry="6.4" fill="none" stroke="currentColor" strokeWidth="2" />
          <ellipse cx="9.3" cy="12" rx="1.3" ry="1.9" fill="currentColor" />
          <ellipse cx="14.7" cy="12" rx="1.3" ry="1.9" fill="currentColor" />
        </symbol>

        <symbol id="i-shield" viewBox="0 0 24 24">
          <path d="M12 2.8 20 6v6.2c0 4.3-3.2 7.6-8 9-4.8-1.4-8-4.7-8-9V6z"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M8.6 12.2l2.5 2.5 4.3-4.6" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" />
        </symbol>

        <symbol id="i-lock" viewBox="0 0 24 24">
          <rect x="4.4" y="10.2" width="15.2" height="11" rx="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M8 10.2V7.6a4 4 0 0 1 8 0v2.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="15.6" r="1.5" fill="currentColor" />
        </symbol>

        <symbol id="i-mask" viewBox="0 0 24 24">
          <path d="M3.6 6.4h16.8v6.2c0 4.6-3.6 8-8.4 8s-8.4-3.4-8.4-8z"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <circle cx="9" cy="11" r="1.3" fill="currentColor" />
          <circle cx="15" cy="11" r="1.3" fill="currentColor" />
          <path d="M9.6 15.4c1.5 1 3.3 1 4.8 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </symbol>

        <symbol id="i-party" viewBox="0 0 24 24">
          <path d="M12 2.6l2.5 6.2 6.7.5-5.1 4.4 1.6 6.6-5.7-3.6-5.7 3.6 1.6-6.6L2.8 9.3l6.7-.5z"
            fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
        </symbol>

        <symbol id="i-bottle" viewBox="0 0 24 24">
          <path d="M10 2.8h4v2.6h-4z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
          <path d="M9 5.4h6v2.4l1.6 2.2v9.2a2.2 2.2 0 0 1-2.2 2.2H9.6a2.2 2.2 0 0 1-2.2-2.2V10l1.6-2.2z"
            fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
          <path d="M8.2 13.4h7.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </symbol>

        <symbol id="i-headset" viewBox="0 0 24 24">
          <path d="M4.4 14.4v-2.2a7.6 7.6 0 0 1 15.2 0v2.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <rect x="2.6" y="13.6" width="4.6" height="7" rx="2.3" fill="none" stroke="currentColor" strokeWidth="1.9" />
          <rect x="16.8" y="13.6" width="4.6" height="7" rx="2.3" fill="none" stroke="currentColor" strokeWidth="1.9" />
        </symbol>
      </defs>
    </svg>
  );
}

export function DuelIcon({ type, className }: { type?: string; className?: string }): JSX.Element {
  return (
    <svg className={className ?? "duel-ico"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <use href={`#${duelIconId(type)}`} />
    </svg>
  );
}
