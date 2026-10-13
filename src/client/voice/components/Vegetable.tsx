/**
 * 蔬菜图标：内联 SVG，不依赖 emoji（emoji 在不同系统上长相差别很大，
 * 而这里是整套手绘风格的一部分）。
 */

import type { VegetableKind } from "../pen";

interface VegetableProps {
  kind: VegetableKind;
  /** 用于 aria-label 的中文名。 */
  label: string;
}

export function Vegetable({ kind, label }: VegetableProps) {
  const common = {
    className: "vx-veg-svg",
    role: "img" as const,
    "aria-label": label,
  };

  if (kind === "carrot") {
    return (
      <svg viewBox="0 0 32 32" {...common}>
        {/* 缨子 */}
        <path d="M16 9 L9 3 L13 11 Z" fill="#5faa4a" />
        <path d="M16 9 L23 3 L19 11 Z" fill="#74bd5c" />
        <path d="M16 8 L16 2 L18 9 Z" fill="#4d9140" />
        {/* 萝卜 */}
        <path
          d="M16 10 C20 10 22 13 22 16 C22 22 18 28 16 30 C14 28 10 22 10 16 C10 13 12 10 16 10 Z"
          fill="#ef8933"
        />
        <path d="M13 15 L15 17 M19 19 L21 21 M15 22 L17 24" stroke="#c96f22" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M13 12 L14 16" stroke="#f9b271" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  if (kind === "corn") {
    return (
      <svg viewBox="0 0 32 32" {...common}>
        <ellipse cx="16" cy="17" rx="7" ry="12" fill="#f2c53d" />
        <path d="M11 12 H21 M10.4 16 H21.6 M10.6 20 H21.4 M11.6 24 H20.4" stroke="#d9a72a" strokeWidth="1.1" />
        <path d="M12 8 L6 22 C8 25 11 25 12 23 Z" fill="#5faa4a" />
        <path d="M20 8 L26 22 C24 25 21 25 20 23 Z" fill="#74bd5c" />
      </svg>
    );
  }

  if (kind === "cabbage") {
    return (
      <svg viewBox="0 0 32 32" {...common}>
        <ellipse cx="16" cy="18" rx="11" ry="10" fill="#8fd06a" />
        <ellipse cx="16" cy="18" rx="11" ry="10" fill="none" stroke="#6bb04c" strokeWidth="1.2" />
        <path d="M16 8 C13 14 13 22 16 28 C19 22 19 14 16 8 Z" fill="#e8f6d6" />
        <path d="M8 14 C11 18 13 22 13 27" fill="none" stroke="#6bb04c" strokeWidth="1.1" />
        <path d="M24 14 C21 18 19 22 19 27" fill="none" stroke="#6bb04c" strokeWidth="1.1" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 32 32" {...common}>
      <path d="M16 11 C20 6 27 9 27 15 C27 22 21 27 16 27 C11 27 5 22 5 15 C5 9 12 6 16 11 Z" fill="#e05445" />
      <path d="M16 11 C18 8 22 8 24 10 C21 10 18 11 16 13 Z" fill="#f28275" opacity="0.75" />
      <path d="M16 11 L13 5" stroke="#8a5a2b" strokeWidth="2" strokeLinecap="round" />
      <path d="M17 9 C20 5 25 6 24 9 C22 8 19 8 17 11 Z" fill="#5faa4a" />
    </svg>
  );
}
