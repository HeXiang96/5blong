import { beforeAll, describe, expect, it, vi } from "vitest";

import { SessionStatsRecorder, loadLastRoom, saveLastRoom } from "../src/client/voice/session-stats";

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
    // 甲说 3 拍、乙说 1 拍、丙没说
    rec.observe(members, new Set(["a"]));
    rec.observe(members, new Set(["a", "b"]));
    rec.observe(members, new Set(["a"]));
    const s = rec.finish()!;
    expect(s.speakers[0]).toMatchObject({ id: "a", name: "甲", seconds: 30 });
    expect(s.speakers[1]).toMatchObject({ id: "b", name: "乙", seconds: 10 });
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
    saveLastRoom("abcd");
    expect(loadLastRoom()).toBeNull();
    saveLastRoom("8294");
    expect(loadLastRoom()?.code).toBe("8294");
    saveLastRoom("123");
    expect(loadLastRoom()?.code).toBe("8294");
  });
});
