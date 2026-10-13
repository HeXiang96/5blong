import { describe, expect, it } from "vitest";

import { CHANGELOG, latestChangelog } from "../src/client/voice/changelog";

describe("首页公告栏更新数据（changelog.ts）", () => {
  it("至少有一条，且每条满足简洁版规范", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    for (const entry of CHANGELOG) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // lines 可以为空：纯 bug 修复版本不发公告栏（跳过展示）
      expect(entry.lines.length).toBeLessThanOrEqual(4);
      for (const line of entry.lines) expect(line.trim().length).toBeGreaterThan(0);
    }
  });

  it("latestChangelog 返回第一条有内容的记录", () => {
    const latest = latestChangelog();
    expect(latest).toBeDefined();
    expect(latest!.lines.length).toBeGreaterThan(0);
    // 它必须是数组里第一条"有内容"的
    const firstWithLines = CHANGELOG.findIndex((entry) => entry.lines.length > 0);
    expect(CHANGELOG.indexOf(latest!)).toBe(firstWithLines);
  });
});
