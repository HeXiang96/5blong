import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { placePopover, popoverBounds } from "../popover";

/** 挂在 body 上，避免场景的 overflow/transform 裁切；按真实尺寸避让可见视口。 */
export function ViewportPopover({
  x,
  y,
  label,
  children,
}: {
  x: number;
  y: number;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: 0, top: 0, visibility: "hidden" });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const viewport = window.visualViewport;
    const update = () => {
      const visible = {
        left: viewport?.offsetLeft ?? 0,
        top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
      };
      const bounds = popoverBounds(visible);
      // 先限制尺寸再测量：长菜单会滚动，窄窗口里的换行也计入真实高度。
      element.style.maxWidth = `${bounds.width}px`;
      element.style.maxHeight = `${bounds.height}px`;
      const next = placePopover({ x, y }, { width: element.offsetWidth, height: element.offsetHeight }, visible);
      setStyle((current) =>
        current.left === next.left && current.top === next.top &&
        current.maxWidth === next.maxWidth && current.maxHeight === next.maxHeight &&
        current.visibility === "visible"
          ? current
          : { ...next, visibility: "visible" },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [x, y]);

  useLayoutEffect(() => {
    const previous = document.activeElement;
    const element = ref.current;
    element?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      // 用户已 Tab 到其他控件时不抢焦点；正常关闭则还原到原来的猪按钮。
      if ((active === document.body || element?.contains(active)) &&
          previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      className="vx-member-menu"
      style={style}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
