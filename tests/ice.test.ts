/**
 * ICE 配置模块单测（src/client/voice/ice.ts）。
 *
 * 这块逻辑值钱的地方全在"失败路径"上，所以用例重心也在这里：
 * - 拿不到 TURN 时必须**退回纯 STUN 且不抛错**（宁可这次打洞失败，也不能让进房卡住）
 * - 服务端返回结构非法时拒用（防止把垃圾塞进 RTCPeerConnection 配置）
 * - 缓存与并发去重（每次进房都打一次 Cloudflare API 是浪费，也更容易被限流）
 *
 * 背景：原先写死的 OpenRelay TURN 已关停（域名指向 192.0.2.1 黑洞地址），
 * 导致"同机能进、跨网进不去"——所以"有没有可用的 TURN"直接决定能不能进房，
 * 这些用例就是钉住这条链路不许再退化。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** 服务端返回的 TURN 条目（形状照抄 Cloudflare generate-ice-servers 的响应）。 */
const TURN_ENTRY = {
  urls: [
    "turn:turn.cloudflare.com:3478?transport=udp",
    "turns:turn.cloudflare.com:443?transport=tcp",
  ],
  username: "u".repeat(64),
  credential: "c".repeat(64),
};

/** 服务端返回的 STUN 条目。 */
const STUN_ENTRY = { urls: ["stun:stun.cloudflare.com:3478"] };

/**
 * 每个用例重新加载模块：ice.ts 有模块级缓存，不重载会互相污染。
 */
async function freshModule() {
  vi.resetModules();
  return import("../src/client/voice/ice");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 把 iceServers 里所有 url 摊平，方便断言。 */
function urlsOf(servers: { urls: string | string[] }[]): string[] {
  return servers.flatMap((entry) =>
    typeof entry.urls === "string" ? [entry.urls] : entry.urls,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("兜底状态（尚未拉到凭据）", () => {
  it("只给 STUN，一条 TURN 都没有", async () => {
    const ice = await freshModule();
    const urls = urlsOf(ice.iceServers() as { urls: string[] }[]);

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("stun:"))).toBe(true);
    expect(ice.iceHasTurn()).toBe(false);
  });

  it("兜底 STUN 里保留国内可达的节点（Google STUN 在大陆基本不可用）", async () => {
    const ice = await freshModule();
    const urls = urlsOf(ice.iceServers() as { urls: string[] }[]);

    expect(urls).toContain("stun:stun.miwifi.com:3478");
    expect(urls).toContain("stun:stun.chat.bilibili.com:3478");
  });
});

describe("刷新成功", () => {
  it("把服务端返回的 TURN 合并进来，且不动静态兜底 STUN", async () => {
    const ice = await freshModule();
    const fetchMock = vi.fn(async () => jsonResponse({ iceServers: [STUN_ENTRY, TURN_ENTRY] }));
    vi.stubGlobal("fetch", fetchMock);

    await ice.refreshIceServers();

    const urls = urlsOf(ice.iceServers() as { urls: string[] }[]);
    expect(urls.some((u) => u.startsWith("turn:"))).toBe(true);
    expect(urls.some((u) => u.startsWith("turns:"))).toBe(true);
    // 本地兜底不被服务端返回顶掉：服务端挂了也要还有 STUN 可用
    expect(urls).toContain("stun:stun.miwifi.com:3478");
    expect(ice.iceHasTurn()).toBe(true);
  });

  it("请求打到 /ice（线上由 /sfu 同源的 Worker 提供）", async () => {
    const ice = await freshModule();
    // 显式声明入参，才能断言调用实参（否则 mock.calls 的元组类型是空的）
    const fetchMock = vi.fn(async (_input: string) => jsonResponse({ iceServers: [TURN_ENTRY] }));
    vi.stubGlobal("fetch", fetchMock);

    await ice.refreshIceServers();

    expect(fetchMock.mock.calls[0][0]).toBe("/ice");
  });

  it("凭据被缓存：第二次刷新不再发请求", async () => {
    const ice = await freshModule();
    const fetchMock = vi.fn(async () => jsonResponse({ iceServers: [TURN_ENTRY] }));
    vi.stubGlobal("fetch", fetchMock);

    await ice.refreshIceServers();
    await ice.refreshIceServers();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("并发刷新共用同一次请求（不把 Cloudflare API 打爆）", async () => {
    const ice = await freshModule();
    const fetchMock = vi.fn(async () => jsonResponse({ iceServers: [TURN_ENTRY] }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([ice.refreshIceServers(), ice.refreshIceServers(), ice.refreshIceServers()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("失败路径：一律退回纯 STUN 且不抛错", () => {
  it.each([500, 501, 502, 404])("HTTP %i → 保持纯 STUN", async (status) => {
    const ice = await freshModule();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "nope" }, status)));

    await expect(ice.refreshIceServers()).resolves.toBeUndefined();

    expect(ice.iceHasTurn()).toBe(false);
    const urls = urlsOf(ice.iceServers() as { urls: string[] }[]);
    expect(urls.every((u) => u.startsWith("stun:"))).toBe(true);
  });

  it("网络不可达（fetch 直接拒绝）→ 保持纯 STUN", async () => {
    const ice = await freshModule();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(ice.refreshIceServers()).resolves.toBeUndefined();

    expect(ice.iceHasTurn()).toBe(false);
  });

  it("响应不是 JSON → 保持纯 STUN", async () => {
    const ice = await freshModule();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>网关错误</html>", { status: 200 })));

    await expect(ice.refreshIceServers()).resolves.toBeUndefined();

    expect(ice.iceHasTurn()).toBe(false);
  });

  it.each([
    ["缺少 iceServers 字段", {}],
    ["iceServers 是空数组", { iceServers: [] }],
    ["iceServers 不是数组", { iceServers: "nope" }],
    ["条目缺 urls", { iceServers: [{ username: "u", credential: "c" }] }],
    ["urls 为空数组", { iceServers: [{ urls: [] }] }],
    ["urls 元素不是字符串", { iceServers: [{ urls: [123] }] }],
  ])("结构非法（%s）→ 拒用，保持纯 STUN", async (_label, payload) => {
    const ice = await freshModule();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(payload)));

    await ice.refreshIceServers();

    expect(ice.iceHasTurn()).toBe(false);
  });
});

describe("ensureIceServers（进房路径专用：绝不阻塞）", () => {
  it("拉取挂起时按超时返回，不让进房干等", async () => {
    const ice = await freshModule();
    // 永不 settle：模拟网络黑洞（比 reject 更恶劣的情况）
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const started = Date.now();
    await ice.ensureIceServers(50);

    expect(Date.now() - started).toBeLessThan(600);
    expect(ice.iceHasTurn()).toBe(false);
  });

  it("凭据已缓存时立即返回", async () => {
    const ice = await freshModule();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ iceServers: [TURN_ENTRY] })));
    await ice.refreshIceServers();

    const started = Date.now();
    await ice.ensureIceServers(2000);

    expect(Date.now() - started).toBeLessThan(80);
    expect(ice.iceHasTurn()).toBe(true);
  });

  it("超时返回后，后台那次拉取仍会在完成后生效（下一次拨号就能用上）", async () => {
    const ice = await freshModule();
    let release: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })),
    );

    await ice.ensureIceServers(20);
    expect(ice.iceHasTurn()).toBe(false);

    release(jsonResponse({ iceServers: [TURN_ENTRY] }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ice.iceHasTurn()).toBe(true);
  });
});
