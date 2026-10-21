/**
 * 大更新公告的展示逻辑单测。
 * 约定：① 默认弹；② 点"知道了"后不再弹；③ 存储不可用时退化为"本次会话只弹一次"。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  WHATS_NEW,
  WHATS_NEW_VERSION,
  markWhatsNewSeen,
  resetWhatsNewSessionFlag,
  shouldShowWhatsNew,
} from "../src/client/voice/whats-new";

const KEY = "5blong:v1:whatsNew";

function stubStorage(
  get: (key: string) => string | null,
  set: (key: string, value: string) => void = () => {},
) {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => get(key),
    setItem: (key: string, value: string) => set(key, value),
    removeItem: () => {},
  });
}

describe("大更新公告", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // markWhatsNewSeen 会置"本次会话已弹过"，每个用例前清掉
    resetWhatsNewSessionFlag();
  });

  it("没看过时要弹，看过之后不再弹", () => {
    const store = new Map<string, string>();
    stubStorage(
      (key) => store.get(key) ?? null,
      (key, value) => store.set(key, value),
    );
    expect(shouldShowWhatsNew()).toBe(true);
    markWhatsNewSeen();
    expect(store.get(KEY)).toBe(String(WHATS_NEW_VERSION));
  });

  it("已读版本等于当前版本时不再弹", () => {
    stubStorage((key) => (key === KEY ? String(WHATS_NEW_VERSION) : null));
    expect(shouldShowWhatsNew()).toBe(false);
  });

  it("旧版本已读记录仍会弹（内容更新过）", () => {
    stubStorage((key) => (key === KEY ? String(WHATS_NEW_VERSION - 1) : null));
    expect(shouldShowWhatsNew()).toBe(true);
  });

  it("存储不可用时不抛错", () => {
    stubStorage(
      () => {
        throw new Error("blocked");
      },
      () => {
        throw new Error("blocked");
      },
    );
    expect(() => shouldShowWhatsNew()).not.toThrow();
    expect(() => markWhatsNewSeen()).not.toThrow();
  });

  it("文案本身要完整（不缺标题/正文/图标）", () => {
    expect(WHATS_NEW.items.length).toBeGreaterThanOrEqual(4);
    for (const item of WHATS_NEW.items) {
      expect(item.title.length).toBeGreaterThan(2);
      expect(item.body.length).toBeGreaterThan(8);
      expect(item.icon.length).toBeGreaterThan(2);
    }
  });
});
