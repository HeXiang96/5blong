import { MicOff } from "lucide-react";
import type { ReactNode } from "react";

import { initials } from "../identity";

export function Avatar({
  avatar,
  color,
  name,
  size,
  muted,
}: {
  avatar: string;
  color: string;
  name: string;
  size: number;
  muted?: boolean;
}) {
  return (
    <span
      className={`vx-avatar${muted ? " vx-avatar-muted" : ""}`}
      style={{ width: size, height: size, background: color }}
    >
      {avatar ? (
        <img src={avatar} alt="" draggable={false} />
      ) : (
        <span className="vx-avatar-initial" style={{ fontSize: size * 0.4 }}>
          {initials(name)}
        </span>
      )}
      {muted ? (
        <span className="vx-avatar-mic" style={{ width: size * 0.36, height: size * 0.36 }}>
          <MicOff size={size * 0.2} strokeWidth={2.6} />
        </span>
      ) : null}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`vx-switch${checked ? " vx-switch-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="vx-switch-knob" />
    </button>
  );
}

export function Banner({
  kind,
  children,
  onClose,
}: {
  kind: "info" | "error";
  children: ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className={`vx-banner vx-banner-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span className="vx-banner-text">{children}</span>
      {onClose ? (
        <button type="button" className="vx-banner-close" onClick={onClose} aria-label="关闭提示">
          ×
        </button>
      ) : null}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="vx-spinner" style={{ width: size, height: size }} aria-hidden />;
}
