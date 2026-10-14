/** 围炉看投影的纯逻辑单测：协议校验 + 围观位确定性。 */
import { describe, expect, it } from "vitest";

import { TV_APPROACH_MS, tvSlotFor } from "../src/client/voice/pen";
import {
  parseGuestMessage,
  parseHostMessage,
  parseScreenShareState,
  type ScreenShareState,
} from "../src/client/voice/protocol";

describe("parseScreenShareState", () => {
  const valid: ScreenShareState = {
    active: true,
    sharerId: "5b-g-abc",
    sessionId: "sess-123",
    trackName: "screen",
    trackNameAudio: "",
    label: "Visual Studio Code",
    startedAt: 1_700_000_000_000,
    transport: "p2p",
  };

  it("接受完整合法状态", () => {
    expect(parseScreenShareState({ ...valid })).toEqual(valid);
  });

  it("拒绝缺关键字段", () => {
    expect(parseScreenShareState({ ...valid, sessionId: "" })).toBeNull();
    expect(parseScreenShareState({ ...valid, trackName: "" })).toBeNull();
    expect(parseScreenShareState({ ...valid, sharerId: "" })).toBeNull();
    expect(parseScreenShareState({ ...valid, active: false })).toBeNull();
    expect(parseScreenShareState(null)).toBeNull();
    expect(parseScreenShareState("nope")).toBeNull();
  });

  it("超长字段被截断而不是拒绝", () => {
    const parsed = parseScreenShareState({ ...valid, label: "x".repeat(500) });
    expect(parsed?.label.length).toBeLessThanOrEqual(120);
  });
});

describe("屏幕共享线上消息", () => {
  it("host screen-share 消息（开播）", () => {
    const parsed = parseHostMessage({
      t: "screen-share",
      state: { active: true, sharerId: "a", sessionId: "s", trackName: "screen", startedAt: 1 },
    });
    expect(parsed?.t).toBe("screen-share");
    expect(parsed && parsed.t === "screen-share" && parsed.state !== null).toBe(true);
  });

  it("host screen-share 消息（state=null 停播）", () => {
    const parsed = parseHostMessage({ t: "screen-share", state: null });
    expect(parsed).toEqual({ t: "screen-share", state: null });
  });

  it("guest screen-share-start / stop", () => {
    const start = parseGuestMessage({
      t: "screen-share-start",
      session: { sessionId: "s1", trackName: "screen", trackNameAudio: "", label: "屏幕", hasAudio: false },
    });
    expect(start?.t).toBe("screen-share-start");
    expect(parseGuestMessage({ t: "screen-share-stop" })).toEqual({ t: "screen-share-stop" });
    // 缺 sessionId 的申报整条丢弃
    expect(
      parseGuestMessage({ t: "screen-share-start", session: { trackName: "screen" } }),
    ).toBeNull();
  });

  it("welcome 可携带进行中的共享（旧房主不带也不报错）", () => {
    const base = {
      t: "welcome",
      code: "1234",
      hostId: "5b-h-1234",
      proof: "p",
      you: "5b-g-x",
      roster: [],
    };
    expect(parseHostMessage(base)?.t).toBe("welcome");
    const withShare = parseHostMessage({
      ...base,
      screenShare: { active: true, sharerId: "a", sessionId: "s", trackName: "screen", startedAt: 1 },
    });
    expect(withShare?.t).toBe("welcome");
  });
});

describe("tvSlotFor 围观位", () => {
  it("确定性：同一输入永远同一输出", () => {
    const ids = ["pig-a", "pig-b", "pig-c"];
    for (let i = 0; i < 5; i += 1) {
      expect(tvSlotFor("pig-b", ids)).toEqual(tvSlotFor("pig-b", ids));
    }
  });

  it("与成员排序顺序无关（按排序后的 id 分配）", () => {
    const a = tvSlotFor("pig-b", ["pig-a", "pig-b", "pig-c"]);
    const b = tvSlotFor("pig-b", ["pig-c", "pig-b", "pig-a"]);
    expect(a).toEqual(b);
  });

  it("不同成员拿到不同槽位（前排不重叠）", () => {
    const ids = ["pig-a", "pig-b", "pig-c", "pig-d"];
    const slots = ids.map((id) => tvSlotFor(id, ids));
    const frontXs = slots.slice(0, 4).map((slot) => `${slot.x}@${slot.lane}`);
    expect(new Set(frontXs).size).toBe(4);
  });

  it("超出前排人数落到后排且仍然确定", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `pig-${i}`);
    const ninth = tvSlotFor("pig-8", [...ids, "pig-8"]);
    expect(ninth.x).toBeGreaterThan(0);
    expect(ninth.lane).toBeGreaterThanOrEqual(0);
    expect(ninth.lane).toBeLessThanOrEqual(1);
    // 两翼布局：幕布在正上方，左翼面右（faceLeft=false）、右翼面左（faceLeft=true）
    for (const id of ids) {
      const slot = tvSlotFor(id, ids);
      expect(slot.faceLeft).toBe(slot.x > 0.5);
    }
  });

  it("出发延迟有错落但不失控", () => {
    const ids = Array.from({ length: 6 }, (_, i) => `pig-${i}`);
    for (const id of ids) {
      const delay = tvSlotFor(id, ids).delayMs;
      expect(delay).toBeGreaterThanOrEqual(200);
      expect(delay).toBeLessThan(200 + 6 * 160 + 260);
    }
    expect(TV_APPROACH_MS).toBeGreaterThan(2000);
  });
});
