/**
 * 单向链路判定的阈值测试（2026-10-27）。
 *
 * 这条线很窄：判早了会把好链路反复拆断（说话断断续续），判晚了用户就是
 * "一直没声音、点重连也没用"。用单测把两个阈值钉死。
 */
import { describe, expect, it } from "vitest";

import { ONE_WAY_NEVER_LIMIT, ONE_WAY_STALLED_LIMIT, oneWayStep } from "../src/client/voice/one-way";

describe("单向链路判定", () => {
  it("从没收到过包：第 3 次才判单向（≈15 秒），前两次不拆", () => {
    let state = undefined as ReturnType<typeof oneWayStep>["next"] | undefined;
    const triggers: boolean[] = [];
    for (let i = 0; i < ONE_WAY_NEVER_LIMIT + 1; i += 1) {
      const step = oneWayStep(state, 0);
      state = step.next;
      triggers.push(step.trigger);
    }
    expect(triggers).toEqual([false, false, true, true]);
  });

  it("收到过又停了：要连停 5 次（≈25 秒）才算，比从没收到过更宽容", () => {
    // 先收到 100 个包（链路本来是通的）
    const first = oneWayStep(undefined, 100);
    expect(first.grew).toBe(true);
    let state = first.next;
    const triggers: boolean[] = [];
    for (let i = 0; i < ONE_WAY_STALLED_LIMIT; i += 1) {
      const step = oneWayStep(state, 100);
      state = step.next;
      triggers.push(step.trigger);
      if (step.trigger) break;
    }
    // 前 4 次都不该拆，第 5 次才拆
    expect(triggers.slice(0, ONE_WAY_STALLED_LIMIT - 1)).toEqual(
      Array.from({ length: ONE_WAY_STALLED_LIMIT - 1 }, () => false),
    );
    expect(triggers.at(-1)).toBe(true);
  });

  it("包数一涨就清零：中途恢复过，计时重新开始", () => {
    let state = oneWayStep(undefined, 0).next; // hits = 1
    state = oneWayStep(state, 0).next; // hits = 2
    const recovered = oneWayStep(state, 50); // 通了
    expect(recovered.grew).toBe(true);
    expect(recovered.next.hits).toBe(0);
    expect(recovered.trigger).toBe(false);
    // 再停一次：要重新数满
    expect(oneWayStep(recovered.next, 50).trigger).toBe(false);
  });

  it("包数没变不算涨（getStats 同一拍读到两次相同值）", () => {
    const state = oneWayStep(undefined, 20).next;
    const same = oneWayStep(state, 20);
    expect(same.grew).toBe(false);
    expect(same.next.hits).toBe(1);
  });
});
