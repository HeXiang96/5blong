import { describe, expect, it } from "vitest";

import { CHANGELOG, latestChangelog } from "../src/client/voice/changelog";

describe("首页公告栏更新数据（changelog.ts）", () => {
  it("至少有一条，且每条满足简洁版规范", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    for (const entry of CHANGELOG) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.lines.length).toBeGreaterThan(0);
      expect(entry.lines.length).toBeLessThanOrEqual(4);
      for (const line of entry.lines) expect(line.trim().length).toBeGreaterThan(0);
    }
  });

  it("latestChangelog 返回数组第一条（公告栏显示的就是它）", () => {
    expect(latestChangelog()).toBe(CHANGELOG[0]);
  });
});
