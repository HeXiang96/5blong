import { describe, expect, it } from "vitest";
import { placePopover, popoverBounds } from "../src/client/voice/popover";

const viewport = { left: 0, top: 0, width: 1080, height: 760 };

describe("成员面板视口避让", () => {
  it("空间足够时在点击处下方展开，使用实际宽度居中", () => {
    expect(placePopover({ x: 500, y: 100 }, { width: 240, height: 420 }, viewport))
      .toEqual({ left: 380, top: 112, maxWidth: 1056, maxHeight: 736 });
  });

  it("底边的长菜单向上展开，而不是只预留固定200px", () => {
    const result = placePopover({ x: 70, y: 700 }, { width: 240, height: 480 }, viewport);
    expect(result.left).toBe(12);
    expect(result.top).toBe(208);
    expect(result.top + 480).toBeLessThanOrEqual(748);
  });

  it("左右边缘都留出安全边距", () => {
    expect(placePopover({ x: 0, y: 100 }, { width: 240, height: 160 }, viewport).left).toBe(12);
    expect(placePopover({ x: 1080, y: 100 }, { width: 240, height: 160 }, viewport).left).toBe(828);
  });

  it("小窗口限制尺寸，内容由浮层内部滚动", () => {
    expect(placePopover({ x: 300, y: 230 }, { width: 240, height: 480 },
      { left: 0, top: 0, width: 200, height: 240 }))
      .toEqual({ left: 12, top: 12, maxWidth: 176, maxHeight: 216 });
  });

  it("resize后过期的点击坐标也不会把菜单挤出视口", () => {
    const result = placePopover({ x: 1000, y: 700 }, { width: 240, height: 420 },
      { left: 0, top: 0, width: 820, height: 600 });
    expect(result.left).toBe(568);
    expect(result.top).toBe(156);
  });

  it("支持软键盘/缩放的可见视口偏移", () => {
    const visible = { left: 80, top: 120, width: 320, height: 260 };
    expect(placePopover({ x: 0, y: 600 }, { width: 240, height: 500 }, visible))
      .toEqual({ left: 92, top: 132, maxWidth: 296, maxHeight: 236 });
  });

  it("极小视口不会出现负尺寸或负坐标", () => {
    expect(popoverBounds({ left: 0, top: 0, width: 10, height: 8 }))
      .toEqual({ left: 4, top: 4, width: 2, height: 0 });
  });

  it("不同成员菜单高度、边缘坐标和窗口尺寸都保持在边界内", () => {
    for (const width of [180, 390, 820, 1080]) {
      for (const height of [160, 360, 600, 760]) {
        const visible = { left: 0, top: 0, width, height };
        const bounds = popoverBounds(visible);
        for (const menuHeight of [120, 360, 480, 620]) {
          for (const anchor of [{ x: 0, y: 0 }, { x: width, y: height }, { x: width / 2, y: height / 2 }]) {
            const result = placePopover(anchor, { width: 240, height: menuHeight }, visible);
            expect(result.left).toBeGreaterThanOrEqual(bounds.left);
            expect(result.top).toBeGreaterThanOrEqual(bounds.top);
            expect(result.left + Math.min(240, result.maxWidth)).toBeLessThanOrEqual(width - bounds.left);
            expect(result.top + Math.min(menuHeight, result.maxHeight)).toBeLessThanOrEqual(height - bounds.top);
          }
        }
      }
    }
  });
});
