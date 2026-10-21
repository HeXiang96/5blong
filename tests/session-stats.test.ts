import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  SessionStatsRecorder,
  STATS_SAMPLE_SEC,
  loadLastRoom,
  saveLastRoom,
} from "../src/client/voice/session-stats";

// vitest 跑在 node 环境，没有 localStorage：按 onboarding.test.ts 的同款方式补一个。
beforeAll(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

describe("SessionStatsRecorder（今晚小结）", () => {
  it("没 begin 过 finish 返回 null", () => {
    const rec = new SessionStatsRecorder();
    rec.observe([{ id: "a", name: "甲" }], new Set());
    expect(rec.finish()).toBeNull();
  });

  it("累计说话秒数并给出排行", () => {
    const rec = new SessionStatsRecorder();
    rec.begin();
    const members = [
      { id: "a", name: "甲" },
      { id: "b", name: "乙" },
      { id: "c", name: "丙" },
    ];
    // 甲说 3 拍、乙说 1 拍、丙没说（每拍 = STATS_SAMPLE_SEC 秒）
    rec.observe(members, new Set(["a"]));
    rec.observe(members, new Set(["a", "b"]));
    rec.observe(members, new Set(["a"]));
    const s = rec.finish()!;
    expect(s.speakers[0]).toMatchObject({ id: "a", name: "甲", seconds: STATS_SAMPLE_SEC * 3 });
    expect(s.speakers[1]).toMatchObject({ id: "b", name: "乙", seconds: STATS_SAMPLE_SEC });
    expect(s.speakers[2]).toMatchObject({ id: "c", name: "丙", seconds: 0 });
  });

  it("峰值人数、进出人次按见过的成员计", () => {
    const rec = new SessionStatsRecorder();
    rec.begin();
    rec.observe([{ id: "a", name: "甲" }], new Set());
    rec.observe(
      [
        { id: "a", name: "甲" },
        { id: "b", name: "乙" },
      ],
      new Set(),
    );
    // 乙走了，丙来了（同拍 2 人）
    rec.observe(
      [
        { id: "a", name: "甲" },
        { id: "c", name: "丙" },
      ],
      new Set(),
    );
    const s = rec.finish()!;
    expect(s.peakMembers).toBe(2);
    expect(s.totalJoins).toBe(3); // 甲乙丙各记 1 人次
  });

  it("昵称改动取最新；finish 幂等", () => {
    const rec = new SessionStatsRecorder();
    rec.begin();
    rec.observe([{ id: "a", name: "旧名" }], new Set(["a"]));
    rec.observe([{ id: "a", name: "新名" }], new Set());
    const first = rec.finish()!;
    expect(first.speakers[0]?.name).toBe("新名");
    expect(rec.finish()).toEqual(first);
  });

  it("finish 之后 observe 被忽略", () => {
    const rec = new SessionStatsRecorder();
    rec.begin();
    rec.observe([{ id: "a", name: "甲" }], new Set());
    rec.finish();
    rec.observe([{ id: "a", name: "甲" }], new Set(["a"]));
    expect(rec.finish()!.speakers[0]?.seconds).toBe(0);
  });
});

describe("上次房间记忆", () => {
  it("只认 4 位数字的房间码", () => {
    saveLastRoom("abcd", "guest");
    expect(loadLastRoom()).toBeNull();
    saveLastRoom("8294", "guest");
    expect(loadLastRoom()?.code).toBe("8294");
    saveLastRoom("123", "guest");
    expect(loadLastRoom()?.code).toBe("8294");
  });

  it("房主记录带上钥匙，能用于恢复同一房间", () => {
    localStorage.removeItem("5blong:v1:lastRoom");
    saveLastRoom("7003", "host", "key-abc");
    const last = loadLastRoom();
    expect(last?.role).toBe("host");
    expect(last?.roomKey).toBe("key-abc");
  });

  it("超过 12 小时的记录不再展示", () => {
    localStorage.removeItem("5blong:v1:lastRoom");
    const old = Date.now() - 13 * 60 * 60 * 1000;
    localStorage.setItem(
      "5blong:v1:lastRoom",
      JSON.stringify({ code: "7004", savedAt: old, role: "guest" }),
    );
    expect(loadLastRoom()).toBeNull();
  });

  it("房主身份也会被记录（用于重新开房）", () => {
    localStorage.removeItem("5blong:v1:lastRoom");
    // 模拟旧版记录：没带 role（可能是房主自己开的房）
    localStorage.setItem("5blong:v1:lastRoom", JSON.stringify({ code: "7001", savedAt: 1 }));
    expect(loadLastRoom()).toBeNull();
    saveLastRoom("7002", "guest");
    expect(loadLastRoom()?.role).toBe("guest");
  });
});
