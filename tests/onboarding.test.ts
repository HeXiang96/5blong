/**
 * 首次打开导览的展示逻辑单测。
 * 关键约定：① 默认要弹；② 标记后不再弹；③ 存储不可用时退化为"本次会话只弹一次"
 * （否则隐私模式下每次刷新都弹，比不弹还烦）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ONBOARDING_VERSION,
  markOnboardingSeen,
  resetOnboardingSessionFlag,
  shouldShowOnboarding,
} from "../src/client/voice/onboarding";

const KEY = "5blong:v1:onboarding";

function stubStorage(
  get: (key: string) => string | null,
  set: (key: string, value: string) => void = () => {},
) {
  vi.stubGlobal("localStorage", { getItem: get, setItem: set, removeItem: () => {} });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetOnboardingSessionFlag();
});

describe("首次打开导览", () => {
  it("没记录过 → 要弹", () => {
    stubStorage(() => null);
    expect(shouldShowOnboarding()).toBe(true);
  });

  it("标记过当前版本 → 不再弹", () => {
    const store = new Map<string, string>();
    stubStorage((key) => store.get(key) ?? null, (key, value) => void store.set(key, String(value)));
    markOnboardingSeen();
    expect(store.get(KEY)).toBe(String(ONBOARDING_VERSION));
    expect(shouldShowOnboarding()).toBe(false);
  });

  it("记录过更旧的版本 → 再看一次新导览", () => {
    stubStorage(() => String(ONBOARDING_VERSION - 1));
    expect(shouldShowOnboarding()).toBe(true);
  });

  it("存储不可用（隐私模式）→ 本次会话只弹一次，刷新前不再骚扰", () => {
    stubStorage(
      () => {
        throw new Error("denied");
      },
      () => {
        throw new Error("denied");
      },
    );
    expect(shouldShowOnboarding()).toBe(true);
    markOnboardingSeen();
    expect(shouldShowOnboarding()).toBe(false);
  });
});
