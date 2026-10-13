import { describe, expect, it } from "vitest";

import { daypartForHour, daypartOverride } from "../src/client/voice/daypart";

describe("daypartForHour", () => {
  it("凌晨与深夜是夜晚", () => {
    expect(daypartForHour(0)).toBe("night");
    expect(daypartForHour(3.5)).toBe("night");
    expect(daypartForHour(23)).toBe("night");
  });

  it("清晨 5:00–9:00", () => {
    expect(daypartForHour(5)).toBe("morning");
    expect(daypartForHour(6.5)).toBe("morning");
    expect(daypartForHour(8.99)).toBe("morning");
  });

  it("白天 9:00–16:30", () => {
    expect(daypartForHour(9)).toBe("day");
    expect(daypartForHour(12)).toBe("day");
    expect(daypartForHour(16.4)).toBe("day");
  });

  it("傍晚 16:30–19:30", () => {
    expect(daypartForHour(16.5)).toBe("dusk");
    expect(daypartForHour(18)).toBe("dusk");
    expect(daypartForHour(19.4)).toBe("dusk");
  });

  it("夜晚从 19:30 开始", () => {
    expect(daypartForHour(19.5)).toBe("night");
    expect(daypartForHour(21)).toBe("night");
  });

  it("越界的小时数按 24 小时回卷", () => {
    expect(daypartForHour(-2)).toBe("night");
    expect(daypartForHour(26)).toBe("night"); // 26 点 = 凌晨 2 点
    expect(daypartForHour(29)).toBe("morning"); // 29 点 = 清晨 5 点
  });
});

describe("daypartOverride", () => {
  it("合法参数返回对应时段", () => {
    expect(daypartOverride("?daypart=dusk")).toBe("dusk");
    expect(daypartOverride("?theme=dark&daypart=morning")).toBe("morning");
  });

  it("缺失或非法返回 null", () => {
    expect(daypartOverride("")).toBeNull();
    expect(daypartOverride("?daypart=noon")).toBeNull();
    expect(daypartOverride("?theme=dark")).toBeNull();
  });
});
