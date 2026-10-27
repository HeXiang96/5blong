import { describe, expect, it } from "vitest";

import { gameInviteUrl, parseGameCode } from "../src/client/game/game-links";
import { ROOM_CODE_LEN, makeRoomCode } from "../src/client/voice/protocol";

/**
 * 开黑圈房码解析的回归测试。
 *
 * 背景：房码 2026-10-26 从 4 位扩到 6 位，语音房改了，开黑圈这里还是
 * `^[0-9]{4}$` —— 建房生成的 6 位码进不去，邀请链接也打不开。
 * 这组用例锁死"新码能进、老码还能进、别的都不算码"。
 */
describe("开黑圈房间码解析", () => {
  it("接受 6 位新码", () => {
    expect(parseGameCode("?g=829417")).toBe("829417");
  });

  it("老的 4 位码继续放行（老链接/老截图不该失效）", () => {
    expect(parseGameCode("?g=8294")).toBe("8294");
  });

  it("自己生成的码一定能被自己解析（长度改了也不会再对不上）", () => {
    const code = makeRoomCode(() => 3);
    expect(code).toHaveLength(ROOM_CODE_LEN);
    expect(parseGameCode(`?g=${code}`)).toBe(code);
  });

  it("长度不对、带字母、空值一律当没有", () => {
    expect(parseGameCode("?g=82941")).toBeNull(); // 5 位
    expect(parseGameCode("?g=8294170")).toBeNull(); // 7 位
    expect(parseGameCode("?g=82941a")).toBeNull();
    expect(parseGameCode("?g=")).toBeNull();
    expect(parseGameCode("?")).toBeNull();
    expect(parseGameCode("")).toBeNull();
  });

  it("去掉首尾空白（口头报码带空格也能进）", () => {
    expect(parseGameCode("?g=%20829417%20")).toBe("829417");
  });

  it("邀请链接里的码也能被同一条规则读回来", () => {
    const original = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      location: { hostname: "5blong.pages.dev", href: "https://5blong.pages.dev/" },
    };
    try {
      const url = gameInviteUrl(" 829417 ");
      expect(url).toContain("g=829417");
      expect(parseGameCode(new URL(url).search)).toBe("829417");
    } finally {
      (globalThis as { window?: unknown }).window = original;
    }
  });
});
