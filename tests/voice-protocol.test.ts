import { describe, expect, it } from "vitest";

import {
  CODE_ALPHABET,
  CODE_HINT,
  HOST_ID_PREFIX,
  MAX_MEMBERS,
  ROOM_CODE_LEN,
  buildInviteUrl,
  decideAdmission,
  guestPeerId,
  hostPeerId,
  hostProofMessage,
  isRoomCode,
  makeRoomCode,
  normalizeCode,
  parseGuestMessage,
  parseHostMessage,
  parseInviteHash,
  parseJoinInput,
  randomIndex,
  randomToken,
  rejectText,
  signGuestProof,
  signHostProof,
  toBase64Url,
  fromBase64Url,
  verifyHostProof,
  type Invite,
} from "../src/client/voice/protocol.ts";

const KEY = "test-room-key-0123456789";
const CODE = "1234";
const OTHER_CODE = "5678";

describe("room code", () => {
  it("generates codes inside the alphabet and of the declared length", () => {
    for (let i = 0; i < 200; i++) {
      const code = makeRoomCode(randomIndex);
      expect(code).toHaveLength(ROOM_CODE_LEN);
      for (const char of code) expect(CODE_ALPHABET).toContain(char);
      expect(isRoomCode(code)).toBe(true);
    }
  });

  it("reaches the whole alphabet, not just a prefix of it", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      for (const char of makeRoomCode(randomIndex)) seen.add(char);
    }
    expect(seen.size).toBe(CODE_ALPHABET.length);
  });

  it("normalizes what people actually type", () => {
    expect(normalizeCode(" 1234 ")).toBe(CODE);
    expect(normalizeCode("12-3 4")).toBe(CODE);
    expect(normalizeCode("1234")).toBe(CODE);
  });

  it("rejects codes outside the alphabet or of the wrong length", () => {
    expect(isRoomCode("123")).toBe(false); // too short
    expect(isRoomCode("12345")).toBe(false); // too long
    expect(isRoomCode("123A")).toBe(false); // letters are excluded from the alphabet
    expect(isRoomCode("12 34")).toBe(false); // spaces are not part of a code
    expect(isRoomCode("12-34")).toBe(false); // separators are not part of a code
  });

  it("builds peer ids that satisfy the PeerJS id grammar", () => {
    // PeerJS 的校验：^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$
    // `-`/`_` 只能当单个分隔符，两边必须是非空字母数字段——这正是
    // base64url token 会踩的坑（曾导致房主 peer 建不起来、访客永远进不去）。
    const grammar = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;
    // 多样本：单次抽样正是当初漏掉这个 bug 的原因。
    for (let i = 0; i < 2000; i++) {
      const token = randomToken(12);
      expect(token, `token=${token}`).toMatch(/^[A-Za-z0-9]+$/);
      expect(token.startsWith("-") || token.startsWith("_")).toBe(false);
      expect(grammar.test(hostPeerId(token)), `host=${token}`).toBe(true);
      expect(grammar.test(guestPeerId(token)), `guest=${token}`).toBe(true);
    }
  });

  it("keeps tokens long enough to be unguessable", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const token = randomToken(16);
      // 去掉 -/_ 后最短仍有 16 个字母数字字符，约 95 bit 熵。
      expect(token.length).toBeGreaterThanOrEqual(16);
      expect(token).toMatch(/^[A-Za-z0-9]+$/);
      seen.add(token);
    }
    expect(seen.size).toBe(500); // 无重复
  });

  it("produces a valid room key and host id for every generated room", () => {
    const grammar = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;
    for (let i = 0; i < 500; i++) {
      const host = hostPeerId(randomToken(12));
      const key = randomToken(24);
      expect(grammar.test(host)).toBe(true);
      expect(key).toMatch(/^[A-Za-z0-9]+$/);
      expect(host.length).toBeLessThanOrEqual(64); // PeerJS 的 ID 上限
      expect(buildInviteUrl({ code: makeRoomCode(randomIndex), hostId: host, roomKey: key })).toContain(
        `h=${host}`,
      );
    }
  });

  it("never derives the host id from the code", () => {
    const host = hostPeerId(randomToken(12));
    expect(host).not.toContain(CODE);
    expect(host.slice(HOST_ID_PREFIX.length)).not.toBe(CODE);
  });
});

describe("invite link", () => {
  const invite: Invite = { code: CODE, hostId: hostPeerId("token-abc"), roomKey: KEY };

  it("round-trips through the url fragment", () => {
    const url = buildInviteUrl(invite);
    expect(url.startsWith("https://5blong.pages.dev/#")).toBe(true);
    // The secret must live after '#' so it never reaches a server.
    expect(url.indexOf("#")).toBeLessThan(url.indexOf(KEY));

    const parsed = parseInviteHash(new URL(url).hash);
    expect(parsed).toEqual(invite);
  });

  it("rejects a fragment missing the key or the host id", () => {
    expect(parseInviteHash(`#c=${CODE}&h=5b-h-x`)).toBeNull();
    expect(parseInviteHash(`#c=${CODE}&k=${KEY}`)).toBeNull();
    expect(parseInviteHash(`#h=5b-h-x&k=${KEY}`)).toBeNull();
    expect(parseInviteHash("")).toBeNull();
  });

  /*
   * 回归：邀请链接必须**永远**指向公开网址，不能跟着当前页面的地址走。
   *
   * 桌面端的页面地址是 Electron 内部的 app://bundle/index.html。
   * 之前复制邀请是手拼 `${location.origin}${location.pathname}#...`，
   * 在桌面端复制出来的是 `app://bundle/index.html#c=...`，
   * 这个链接只有本机能打开，发给别人完全没用（实测就是这样）。
   */
  it("永远指向公开网址，不受当前页面地址影响", () => {
    const url = buildInviteUrl(invite);
    expect(url.startsWith("https://5blong.pages.dev/#")).toBe(true);
    // 绝不能出现 Electron 的内部协议或本地路径
    expect(url).not.toContain("app://");
    expect(url).not.toContain("bundle");
    expect(url).not.toContain("index.html");
    expect(url).not.toContain("file://");
  });

  it("房间码在链接里可读，密钥只在 # 之后", () => {
    const url = buildInviteUrl(invite);
    expect(url).toContain(`c=${CODE}`);
    const hashAt = url.indexOf("#");
    expect(hashAt).toBeGreaterThan(0);
    // 密钥必须完全落在 fragment 内，避免进入服务器日志
    expect(url.slice(0, hashAt)).not.toContain(KEY);
  });
});

describe("join input", () => {
  it("accepts a bare code", () => {
    expect(parseJoinInput("1234")).toEqual({ code: CODE, hostId: "", roomKey: "" });
    expect(parseJoinInput(" 1234 ")).toEqual({ code: CODE, hostId: "", roomKey: "" });
  });

  it("accepts a full invite link", () => {
    const url = buildInviteUrl({ code: CODE, hostId: "5b-h-abc", roomKey: KEY });
    expect(parseJoinInput(url)).toEqual({
      code: CODE,
      hostId: "5b-h-abc",
      roomKey: KEY,
    });
  });

  it("accepts a legacy #r=<host>&c=<code> link without a key", () => {
    const target = parseJoinInput("https://5blong.pages.dev/#r=5b1234&c=1234");
    expect(target).toEqual({ code: CODE, hostId: "5b1234", roomKey: "" });
  });

  it("rejects junk without throwing", () => {
    for (const bad of ["", "   ", "hello", "123", "12345", "#", "https://x/#c=AB"]) {
      expect(parseJoinInput(bad)).toBeNull();
    }
  });

  it("keeps the hint text in sync with the real code length", () => {
    expect(CODE_HINT).toContain(String(ROOM_CODE_LEN));
  });
});

describe("handshake proofs", () => {
  it("verifies a matching proof and rejects a tampered one", async () => {
    const nonce = randomToken(16);
    const proof = await signHostProof(KEY, nonce);
    await expect(verifyHostProof(KEY, nonce, proof)).resolves.toBe(true);
    await expect(verifyHostProof(KEY, nonce, proof + "x")).resolves.toBe(false);
    await expect(verifyHostProof(KEY, randomToken(16), proof)).resolves.toBe(false);
    await expect(verifyHostProof("wrong-key", nonce, proof)).resolves.toBe(false);
  });

  it("binds the guest proof to the peer id and the code", async () => {
    const nonce = randomToken(16);
    const peerId = guestPeerId(randomToken(12));
    const proof = await signGuestProof(KEY, nonce, peerId, CODE);

    const same = await signGuestProof(KEY, nonce, peerId, CODE);
    expect(same).toBe(proof);
    // A relayed proof must not be reusable by another peer or another room.
    expect(await signGuestProof(KEY, nonce, guestPeerId("other"), CODE)).not.toBe(proof);
    expect(await signGuestProof(KEY, nonce, peerId, OTHER_CODE)).not.toBe(proof);
    expect(await signGuestProof("other-key", nonce, peerId, CODE)).not.toBe(proof);
  });

  it("keeps the host proof free of the code so it cannot be replayed elsewhere", () => {
    const nonce = "fixed-nonce";
    expect(hostProofMessage(nonce)).not.toContain(CODE);
    expect(hostProofMessage(nonce)).toBe(hostProofMessage(nonce));
  });
});

describe("base64url", () => {
  it("round-trips arbitrary bytes without padding characters", () => {
    for (const size of [1, 2, 3, 15, 16, 17, 64]) {
      const bytes = crypto.getRandomValues(new Uint8Array(size));
      const encoded = toBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(Array.from(fromBase64Url(encoded))).toEqual(Array.from(bytes));
    }
  });
});

describe("admission", () => {
  const base = {
    hostReady: true,
    closed: false,
    locked: false,
    codeMatches: true,
    proofValid: true,
    existing: false,
    memberCount: 1,
  };

  it("accepts a proven visitor", () => {
    expect(decideAdmission(base)).toEqual({ ok: true });
  });

  it("refuses anyone who cannot prove the key", () => {
    expect(decideAdmission({ ...base, proofValid: false })).toEqual({
      ok: false,
      reason: "bad-key",
    });
    expect(decideAdmission({ ...base, codeMatches: false })).toEqual({
      ok: false,
      reason: "bad-key",
    });
  });

  it("checks the proof before the capacity", () => {
    const verdict = decideAdmission({
      ...base,
      proofValid: false,
      memberCount: MAX_MEMBERS + 5,
    });
    expect(verdict).toEqual({ ok: false, reason: "bad-key" });
  });

  it("refuses when full, but lets an already-known member back in", () => {
    expect(
      decideAdmission({ ...base, memberCount: MAX_MEMBERS }),
    ).toEqual({ ok: false, reason: "full" });
    expect(
      decideAdmission({ ...base, memberCount: MAX_MEMBERS, existing: true }),
    ).toEqual({ ok: true });
    expect(
      decideAdmission({ ...base, memberCount: MAX_MEMBERS - 1 }),
    ).toEqual({ ok: true });
  });

  it("refuses new faces when locked, but lets existing members reconnect", () => {
    expect(decideAdmission({ ...base, locked: true })).toEqual({
      ok: false,
      reason: "locked",
    });
    expect(
      decideAdmission({ ...base, locked: true, existing: true }),
    ).toEqual({ ok: true });
  });

  it("refuses everything once the room is closed", () => {
    expect(decideAdmission({ ...base, closed: true })).toEqual({
      ok: false,
      reason: "closed",
    });
    expect(decideAdmission({ ...base, hostReady: false })).toEqual({
      ok: false,
      reason: "closed",
    });
  });

  it("caps repeated re-handshakes of the same id", () => {
    expect(
      decideAdmission({ ...base, existing: true, memberCount: MAX_MEMBERS * 2 }),
    ).toEqual({ ok: false, reason: "duplicate" });
  });

  it("has a message for every reason", () => {
    for (const reason of ["bad-key", "full", "closed", "locked", "duplicate", "version"] as const) {
      expect(rejectText(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("wire message parsing", () => {
  it("accepts a well-formed hello", () => {
    const parsed = parseGuestMessage({
      t: "hello",
      personId: "1234567890",
      sessionId: "ab12cd34",
      name: "狐狸23",
      avatar: "",
      color: "hsl(1 2% 3%)",
      hasMic: true,
      nonce: "n",
      proof: "p",
    });
    expect(parsed).toEqual({
      t: "hello",
      personId: "1234567890",
      sessionId: "ab12cd34",
      name: "狐狸23",
      avatar: "",
      color: "hsl(1 2% 3%)",
      hasMic: true,
      nonce: "n",
      proof: "p",
    });
  });

  it("accepts a hello without sessionId for backward compatibility", () => {
    // 旧客户端不带 sessionId；房主必须照常放行，只是消歧退回用 personId。
    const parsed = parseGuestMessage({
      t: "hello",
      personId: "1234567890",
      name: "狐狸23",
      avatar: "",
      color: "hsl(1 2% 3%)",
      hasMic: true,
      nonce: "n",
      proof: "p",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.t).toBe("hello");
    if (parsed?.t === "hello") {
      expect(parsed.sessionId).toBe("");
    }
  });

  it("drops a hello without proof material", () => {
    expect(parseGuestMessage({ t: "hello", name: "x" })).toBeNull();
    expect(parseGuestMessage({ t: "hello", nonce: "n" })).toBeNull();
  });

  it("coerces hostile scalars instead of trusting them", () => {
    const parsed = parseGuestMessage({
      t: "chat",
      text: "  hi  ",
      extra: { evil: true },
    });
    expect(parsed).toEqual({ t: "chat", text: "hi" });
    expect(parseGuestMessage({ t: "chat", text: "   " })).toBeNull();
    expect(parseGuestMessage({ t: "muted", muted: "yes" })).toEqual({
      t: "muted",
      muted: false,
    });
    // 闭听随静音一起上报：仅在为真时才带 deafened。
    expect(parseGuestMessage({ t: "muted", muted: true, deafened: true })).toEqual({
      t: "muted",
      muted: true,
      deafened: true,
    });
    expect(parseGuestMessage({ t: "muted", muted: true, deafened: false })).toEqual({
      t: "muted",
      muted: true,
    });
    expect(parseGuestMessage({ t: "ping", ts: Number.NaN })).toBeNull();
  });

  it("ignores unknown or malformed frames", () => {
    for (const bad of [null, undefined, 42, "hello", [], { t: "nope" }, { t: "roster" }]) {
      expect(parseGuestMessage(bad)).toBeNull();
    }
  });

  it("truncates oversized fields", () => {
    const parsed = parseGuestMessage({ t: "chat", text: "x".repeat(9000) });
    expect(parsed && "text" in parsed ? parsed.text.length : 0).toBe(2000);
  });

  it("parses a welcome and rejects one with a bad code", () => {
    const welcome = parseHostMessage({
      t: "welcome",
      code: CODE,
      hostId: "5b-h-abc",
      proof: "p",
      you: "5b-g-me",
      roster: [{ id: "5b-h-abc", name: "host", isHost: true }],
    });
    expect(welcome).not.toBeNull();
    expect(welcome && "roster" in welcome ? welcome.roster.length : 0).toBe(1);
    expect(
      parseHostMessage({ t: "welcome", code: "nope", hostId: "h", proof: "p", you: "y" }),
    ).toBeNull();
  });

  it("parses every reject reason and refuses invented ones", () => {
    for (const reason of ["bad-key", "full", "closed", "duplicate", "version"]) {
      expect(parseHostMessage({ t: "reject", reason })).toEqual({ t: "reject", reason });
    }
    expect(parseHostMessage({ t: "reject", reason: "whatever" })).toBeNull();
    expect(parseHostMessage({ t: "reject" })).toBeNull();
  });

  it("never lets a guest frame be read as a host frame", () => {
    expect(parseHostMessage({ t: "ping", ts: 1 })).toBeNull();
    expect(parseHostMessage({ t: "hello", nonce: "n", proof: "p" })).toBeNull();
    expect(parseGuestMessage({ t: "welcome", code: CODE })).toBeNull();
    expect(parseGuestMessage({ t: "roster", members: [] })).toBeNull();
    expect(parseGuestMessage({ t: "peer-leave", id: "x" })).toBeNull();
  });

  it("caps the roster a host can push at a guest", () => {
    const roster = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, name: "n" }));
    const welcome = parseHostMessage({
      t: "welcome",
      code: CODE,
      hostId: "h",
      proof: "p",
      you: "y",
      roster,
    });
    expect(welcome && "roster" in welcome ? welcome.roster.length : 0).toBe(MAX_MEMBERS);
  });

  it("parses a guest interact request", () => {
    expect(
      parseGuestMessage({ t: "interact", to: "p2", kind: "feed" }),
    ).toEqual({ t: "interact", to: "p2", kind: "feed" });
    expect(
      parseGuestMessage({ t: "interact", to: "p2", kind: "cheer" }),
    ).toEqual({ t: "interact", to: "p2", kind: "cheer" });
    expect(parseGuestMessage({ t: "interact", to: "p2", kind: "nope" })).toBeNull();
    expect(parseGuestMessage({ t: "interact", to: "", kind: "poke" })).toBeNull();
  });

  it("parses host management messages", () => {
    expect(parseHostMessage({ t: "kick", id: "p2" })).toEqual({ t: "kick", id: "p2" });
    expect(parseHostMessage({ t: "kick" })).toBeNull();
    expect(parseHostMessage({ t: "force-mute", id: "p2", muted: true })).toEqual({
      t: "force-mute",
      id: "p2",
      muted: true,
    });
    expect(parseHostMessage({ t: "lock", locked: true })).toEqual({
      t: "lock",
      locked: true,
    });
    expect(
      parseHostMessage({ t: "interact", event: { from: "a", to: "b", kind: "wave", ts: 1 } }),
    ).toEqual({ t: "interact", event: { from: "a", to: "b", kind: "wave", ts: 1 } });
    expect(
      parseHostMessage({ t: "interact", event: { from: "a", to: "b", kind: "bad", ts: 1 } }),
    ).toBeNull();
  });

  it("carries the locked flag through welcome", () => {
    const welcome = parseHostMessage({
      t: "welcome",
      code: CODE,
      hostId: "h",
      proof: "p",
      you: "y",
      roster: [],
      locked: true,
    });
    expect(welcome && "locked" in welcome ? welcome.locked : false).toBe(true);
  });
});
