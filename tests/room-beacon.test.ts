/**
 * 在线房间心跳的单测（房主侧）。
 * 重点：① 开房立刻报一次，之后按间隔心跳；② 人数/共享变化走防抖补报，
 * 不会每变一次发一条（额度保护）；③ 关房报 bye 并彻底停表（不能留定时器）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRoomBeacon, newRoomId } from "../src/client/voice/presence";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("房间心跳", () => {
  it("newRoomId 是 32 位十六进制（与服务端校验一致，且与房间码无关）", () => {
    const id = newRoomId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(newRoomId()).not.toBe(id);
  });

  it("start 立刻报一次，之后按间隔心跳", async () => {
    const sent: { path: string; body: Record<string, unknown> }[] = [];
    const beacon = createRoomBeacon({
      roomId: "a".repeat(32),
      version: "1.4.9",
      getState: () => ({ members: 3, sharing: true }),
      send: (path, body) => void sent.push({ path, body }),
      intervalMs: 1000,
    });
    beacon.start();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe("beat");
    expect(sent[0]!.body).toMatchObject({ id: "a".repeat(32), members: 3, sharing: true, version: "1.4.9" });

    await vi.advanceTimersByTimeAsync(3000);
    expect(sent.filter((item) => item.path === "beat").length).toBe(4); // 1 + 3
    beacon.stop();
  });

  it("状态变化走防抖：连续变化只补报一次", async () => {
    const beats: number[] = [];
    let members = 1;
    const beacon = createRoomBeacon({
      roomId: "b".repeat(32),
      getState: () => ({ members, sharing: false }),
      send: (path, body) => {
        if (path === "beat") beats.push(Number(body.members));
      },
      intervalMs: 60_000,
      debounceMs: 500,
    });
    beacon.start();
    expect(beats).toEqual([1]);

    members = 2;
    beacon.notifyChange();
    members = 3;
    beacon.notifyChange();
    members = 4;
    beacon.notifyChange();
    await vi.advanceTimersByTimeAsync(600);
    // 三次变化只补报一次，且带的是最新人数
    expect(beats).toEqual([1, 4]);
    beacon.stop();
  });

  it("stop 报 bye 并停掉所有定时器（不再有任何 beat）", async () => {
    const sent: string[] = [];
    const beacon = createRoomBeacon({
      roomId: "c".repeat(32),
      getState: () => ({ members: 1, sharing: false }),
      send: (path) => void sent.push(path),
      intervalMs: 1000,
      debounceMs: 100,
    });
    beacon.start();
    beacon.notifyChange();
    beacon.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent[sent.length - 1]).toBe("bye");
    expect(sent.filter((path) => path === "bye")).toHaveLength(1);
    // stop 之后不该再有 heartbeat
    const beatsAfterStop = sent.filter((path) => path === "beat").length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.filter((path) => path === "beat").length).toBe(beatsAfterStop);
  });
});
