/**
 * 线上适配器的"登录态保持"测试。
 *
 * 背景（2026-10-26 业主实测）：刷新两三下就有概率被退出登录。
 * 根因：核对登录态的 /me 请求**不看状态码**，只要拿不到 account 就清缓存与本地令牌；
 * 而刷新页面时浏览器会中断上一个 fetch，正好落进这个分支。
 *
 * 约定（本文件锁死）：
 *   - 401 才是真登出；
 *   - 网络失败 / 5xx / 被中断（status 0）→ 保留登录态；
 *   - 失败后下一次 hydrate 必须能重试（不能被一个失败的 promise 卡死）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN_KEY = "5blong.account.token";
const ME_KEY = "5blong.account.me";

function stubStorage(store: Map<string, string>) {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
}

const cachedAccount = {
  id: "12345678",
  username: "pigses",
  name: "独步吟客",
  avatar: "",
  avatarVersion: 0,
  createdAt: 1,
};

async function makeAdapter(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  // 每个用例都重新 import，避免模块级状态串场
  vi.resetModules();
  const store = new Map<string, string>();
  store.set(TOKEN_KEY, "token-abc");
  store.set(ME_KEY, JSON.stringify(cachedAccount));
  stubStorage(store);
  const { WorkerAccountAdapter } = await import("../src/client/voice/account/worker-adapter");
  const adapter = new WorkerAccountAdapter();
  await adapter.hydrate();
  return { adapter, store };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("刷新时不会莫名被登出", () => {
  it("网络失败（请求被中断 / status 0）→ 登录态保留", async () => {
    const { adapter, store } = await makeAdapter(() => Promise.reject(new TypeError("aborted")));
    expect(adapter.current()?.id).toBe(cachedAccount.id);
    expect(store.get(TOKEN_KEY)).toBe("token-abc");
    expect(store.has(ME_KEY)).toBe(true);
  });

  it("服务端 5xx → 也保留", async () => {
    const { adapter, store } = await makeAdapter(
      () => Promise.resolve(new Response("{}", { status: 503 })),
    );
    expect(adapter.current()?.id).toBe(cachedAccount.id);
    expect(store.get(TOKEN_KEY)).toBe("token-abc");
  });

  it("401 → 才是真登出，清令牌与缓存", async () => {
    const { adapter, store } = await makeAdapter(
      () => Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );
    expect(adapter.current()).toBeNull();
    expect(store.get(TOKEN_KEY)).toBeUndefined();
    expect(store.get(ME_KEY)).toBeUndefined();
  });

  it("先失败再成功：能重新核对回来（失败的 promise 不能卡住后续重试）", async () => {
    let attempt = 0;
    const { adapter } = await makeAdapter(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new TypeError("aborted"));
      return Promise.resolve(
        new Response(JSON.stringify({ account: { ...cachedAccount, name: "改过的昵称" } }), {
          status: 200,
        }),
      );
    });
    expect(adapter.current()?.name).toBe(cachedAccount.name); // 第一次被中断，仍用缓存
    await adapter.hydrate();
    expect(adapter.current()?.name).toBe("改过的昵称");
  });
});
