import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CHANGELOG, currentVersion, latestChangelog } from "../src/client/voice/changelog";

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

  it("CHANGELOG 首条版本号必须等于 package.json 版本号（发版一致性闸门）", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "../package.json"), "utf-8"),
    ) as { version: string };
    expect(CHANGELOG[0].version).toBe(pkg.version);
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

describe("真实程序版本（2026-11-03 后台「房主版本」全错）", () => {
  /*
   * 故障：后台显示 1.9.17 的房主为 1.9.16。
   * 原因：上报用的是 latestChangelog()（最新**有公告**的版本），
   * 而纯修 bug 的版本 lines 为空、被跳过。currentVersion() 取数组首条。
   */
  it("currentVersion = CHANGELOG 首条，不受首条无公告影响", () => {
    expect(currentVersion()).toBe(CHANGELOG[0]!.version);
  });

  it("首条没有公告内容时，两者必须不同（正是这次报错版本的形态）", () => {
    if (CHANGELOG[0]!.lines.length === 0) {
      expect(latestChangelog()!.version).not.toBe(currentVersion());
    }
  });
});
