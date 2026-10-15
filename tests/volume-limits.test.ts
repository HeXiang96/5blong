/**
 * 音量上限的单测（2026-10-15 修复回归）。
 *
 * 事故：别人的收听音量滑块上限只有 100%，而 `HTMLMediaElement.volume` 也不接受 >1——
 * 于是"把对方音量拉到 200%"这条一直是假的；更糟的是持久化时 `<= 1` 的过滤会
 * 把 200% 静默丢掉，重启后又变回 100%。现在上限集中在 settings.ts，UI / 持久化 /
 * 引擎共用一份，这里钉住"读回来的值不会被悄悄夹小"。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MIC_VOLUME_MAX, PEER_VOLUME_MAX, loadSettings } from "../src/client/voice/settings";

const KEY = "5blong:v1:settings";

function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("音量上限", () => {
  it("上限常量与 UI 约定一致（自己 300% / 别人 200%）", () => {
    expect(MIC_VOLUME_MAX).toBe(3);
    expect(PEER_VOLUME_MAX).toBe(2);
  });

  it("micVolume 到 300% 仍被接受（不会被夹回 100%）", () => {
    stubStorage({ [KEY]: JSON.stringify({ micVolume: 3 }) });
    expect(loadSettings().micVolume).toBe(3);
  });

  it("超过上限的脏值回落默认（1）", () => {
    stubStorage({ [KEY]: JSON.stringify({ micVolume: 9 }) });
    expect(loadSettings().micVolume).toBe(1);
  });
});
