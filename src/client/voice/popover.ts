/** 固定浮层使用的可见视口；移动端缩放/软键盘时可能带有偏移。 */
export interface PopoverViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 给浮层四周留出空隙，极小视口也不产生负的可用尺寸。 */
export function popoverBounds(viewport: PopoverViewport) {
  const margin = Math.min(12, Math.max(0, viewport.width / 2), Math.max(0, viewport.height / 2));
  return {
    left: viewport.left + margin,
    top: viewport.top + margin,
    width: Math.max(0, viewport.width - margin * 2),
    height: Math.max(0, viewport.height - margin * 2),
  };
}

/** 按实际浮层尺寸定位：优先向下，放不下则向上，最后钳制到视口内。 */
export function placePopover(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: PopoverViewport,
) {
  const bounds = popoverBounds(viewport);
  const width = Math.min(Math.max(0, size.width), bounds.width);
  const height = Math.min(Math.max(0, size.height), bounds.height);
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const x = clamp(anchor.x, bounds.left, bounds.left + bounds.width);
  const y = clamp(anchor.y, bounds.top, bounds.top + bounds.height);
  const below = y + 12;
  const above = y - 12 - height;
  const preferredTop = below + height <= bounds.top + bounds.height ? below : above;
  return {
    left: clamp(x - width / 2, bounds.left, bounds.left + bounds.width - width),
    top: clamp(preferredTop, bounds.top, bounds.top + bounds.height - height),
    maxWidth: bounds.width,
    maxHeight: bounds.height,
  };
}
