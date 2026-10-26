/**
 * 「我的房间」相关纯逻辑测试。
 *
 * 口径（2026-10-26 业主）：**固定房号绑定账号**，未登录没有固定房。
 * - 房号归账号（AccountProfile.roomCode），本文件不存；
 * - 钥匙归设备、按账号分开存（本文件负责）；
 * - 房号唯一：另一个账号占了同一个号就写不进去。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  ensureRoomKey,
  loadRoomKey,
  normalizeFixedRoomCode,
  renewRoomKey,
} from "../src/client/voice/my-room";
import { LocalAccountAdapter } from "../src/client/voice/account/local-adapter";

// vitest 跑在 node 环境：localStorage / sessionStorage / BroadcastChannel 都要补。
beforeAll(() => {
  const store = new Map<string, string>();
  const fake = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
  vi.stubGlobal("localStorage", fake);
  vi.stubGlobal("sessionStorage", { ...fake });
  // LocalAccountAdapter 构造时挂心跳定时器，需要一个 window
  vi.stubGlobal("window", { setInterval: () => 0, clearInterval: () => {} });
});

describe("房间钥匙（按账号分开，存本机）", () => {
  it("同一账号永远拿到同一把钥匙（邀请链接长期有效）", () => {
    const first = ensureRoomKey("48231907");
    expect(first.length).toBeGreaterThanOrEqual(16);
    expect(ensureRoomKey("48231907")).toBe(first);
    expect(loadRoomKey("48231907")).toBe(first);
  });

  it("不同账号互不串钥匙（换号后旧链接不该能进别人的房）", () => {
    const a = ensureRoomKey("11111111");
    const b = ensureRoomKey("22222222");
    expect(a).not.toBe(b);
    expect(loadRoomKey("11111111")).toBe(a);
  });

  it("换房号时钥匙一起换（旧链接指向的房已经不存在了）", () => {
    const before = ensureRoomKey("33333333");
    const after = renewRoomKey("33333333");
    expect(after).not.toBe(before);
    expect(loadRoomKey("33333333")).toBe(after);
  });

  it("没存过的账号返回 null，不凭空造钥匙", () => {
    expect(loadRoomKey("99999999")).toBeNull();
  });
});

describe("自定义房号格式", () => {
  it("只收 6 位数字（4 位老码不能当固定房号）", () => {
    expect(normalizeFixedRoomCode("520131")).toBe("520131");
    expect(normalizeFixedRoomCode(" 520 131 ")).toBe("520131");
    expect(normalizeFixedRoomCode("8294")).toBeNull();
    expect(normalizeFixedRoomCode("12345")).toBeNull();
    expect(normalizeFixedRoomCode("abcdef")).toBeNull();
  });
});

describe("固定房号绑定在账号上", () => {
  it("写进账号档案，重新登录还在；别的账号占了同一个号就写不进去", async () => {
    const adapter = new LocalAccountAdapter();
    const first = await adapter.register({ username: "pigone", password: "12345678a" });
    const firstId = first.account!.id;
    expect(first.account!.roomCode).toBeUndefined();

    const saved = await adapter.updateProfile({ roomCode: "235417" });
    expect(saved.account?.roomCode).toBe("235417");
    // 重新读取（等价于换一次会话/换设备登录同一个账号）
    expect(adapter.current()?.roomCode).toBe("235417");

    const second = await adapter.register({ username: "pigtwo", password: "12345678b" });
    expect(second.account?.id).not.toBe(firstId);
    const stolen = await adapter.updateProfile({ roomCode: "235417" });
    expect(stolen.error).toBe("room-taken");

    // 非法格式同样拒绝，且不会把已有房号冲掉
    expect((await adapter.updateProfile({ roomCode: "1234" })).error).toBe("room-taken");
    expect(adapter.current()?.roomCode).toBeUndefined();
  });
});
