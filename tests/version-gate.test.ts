import { describe, expect, it } from "vitest";

import { versionLt } from "../src/client/voice/version";

/**
 * 更新闸门的版本比较。
 *
 * 这段逻辑判错的后果很直接：
 * - 判成"更低"太多 → 用户明明是新版却被锁住不能跳过更新；
 * - 判成"更低"太少 → 该强制的旧版被放过。
 * 所以边界都要钉住。
 */
describe("versionLt", () => {
  it("常规升级：1.9.3 < 1.9.4", () => {
    expect(versionLt("1.9.3", "1.9.4")).toBe(true);
    expect(versionLt("1.9.4", "1.9.3")).toBe(false);
  });

  it("相同版本不算更低", () => {
    expect(versionLt("1.9.4", "1.9.4")).toBe(false);
  });

  it("跨段比较：1.9.9 < 1.10.0，且 1.10.0 不小于 1.9.9", () => {
    expect(versionLt("1.9.9", "1.10.0")).toBe(true);
    expect(versionLt("1.10.0", "1.9.9")).toBe(false);
  });

  it("两位数补位：1.9.10 比 1.9.9 新（字典序会判反）", () => {
    expect(versionLt("1.9.9", "1.9.10")).toBe(true);
    expect(versionLt("1.9.10", "1.9.9")).toBe(false);
    expect("1.9.10" < "1.9.9").toBe(true); // 证明这里必须按数字段比
  });

  it("主版本优先：1.10.0 比 2.0.0 旧，即便次版本更大", () => {
    expect(versionLt("1.10.0", "2.0.0")).toBe(true);
    expect(versionLt("2.0.0", "1.10.0")).toBe(false);
  });

  it("段数不同按缺省 0 补齐：1.9 == 1.9.0", () => {
    expect(versionLt("1.9", "1.9.0")).toBe(false);
    expect(versionLt("1.9.0", "1.9")).toBe(false);
    expect(versionLt("1.9", "1.9.1")).toBe(true);
  });

  it("脏数据不崩：空串/非数字按 0 处理", () => {
    expect(versionLt("", "0.0.1")).toBe(true);
    expect(versionLt("x.y.z", "0.0.0")).toBe(false);
    expect(versionLt("1.9.4", "abc")).toBe(false);
  });
});
