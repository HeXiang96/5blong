/**
 * 账号 API（worker/_worker.pages.js 的 /api/account/*）集成测试。
 *
 * 为什么要这么测：这块代码直接跑在线上 Pages Worker 里、前面没有任何自动化，
 * 而它管着注册登录、固定房号唯一性、好友双向、邀请留档——出错就是数据错乱。
 * 这里用 node:sqlite 搭一个最小的 D1 替身（prepare/bind/first/all/run/batch），
 * 把真实的 handler 从头跑一遍。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../worker/_worker.pages.js";

const SCHEMA = readFileSync("worker/accounts-schema.sql", "utf8");

/** D1 的最小替身：只实现 handler 真正用到的那几个方法。 */
class FakeD1 {
  private sqlite: any;
  constructor(sqlite: any) {
    this.sqlite = sqlite;
  }
  prepare(sql: string) {
    const sqlite = this.sqlite;
    const make = (params: any[]): any => ({
      bind: (...next: any[]) => make(next),
      async first() {
        return sqlite.prepare(sql).get(...params) ?? null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...params) };
      },
      async run() {
        sqlite.prepare(sql).run(...params);
        return { success: true };
      },
    });
    return make([]);
  }
  async batch(statements: any[]) {
    for (const statement of statements) await statement.run();
    return [];
  }
}

function makeEnv() {
  const sqlite: any = new DatabaseSync(":memory:");
  for (const statement of SCHEMA.split(";").map((part) => part.trim()).filter(Boolean)) {
    const sql = statement.replace(/^\s*--.*$/gm, "").trim();
    if (!sql) continue;
    try {
      sqlite.exec(sql);
    } catch (error: any) {
      // 建表里带的 ALTER 在内存库上是重复列（新库已包含），忽略
      if (!/duplicate column/i.test(String(error?.message ?? ""))) throw error;
    }
  }
  return { env: { DB: new FakeD1(sqlite) } };
}

let env: any;

beforeEach(() => {
  ({ env } = makeEnv());
});

const BASE = "https://5blong.pages.dev/api/account";

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

function call(path: string, { method = "GET", body, token }: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
  );
}

async function json(response: any) {
  return { status: response.status, data: await response.json() };
}

async function register(username: string, password = "piglet2026") {
  const { status, data } = await json(
    await call("/register", { method: "POST", body: { username, password } }),
  );
  expect(status).toBe(200);
  return { token: data.token, account: data.account };
}

describe("注册 / 登录", () => {
  it("注册成功：8 位账号 ID、没有房号、下发会话令牌", async () => {
    const { account, token } = await register("pigone");
    expect(account.id).toMatch(/^\d{8}$/);
    expect(account.roomCode).toBeUndefined();
    expect(account.roomCodeLocked).toBe(false);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("用户名大小写不敏感地唯一；弱密码被拒", async () => {
    await register("pigone");
    const dup = await json(await call("/register", { method: "POST", body: { username: "PigOne", password: "piglet2026" } }));
    expect(dup.status).toBe(409);
    expect(dup.data.error).toBe("username-taken");

    const weak = await json(await call("/register", { method: "POST", body: { username: "pigtwo", password: "11111111" } }));
    expect(weak.data.error).toBe("password-weak");
  });

  it("密码错给 bad-credentials；密码对能拿到自己的档案", async () => {
    await register("pigone", "piglet2026");
    const bad = await json(await call("/login", { method: "POST", body: { username: "pigone", password: "wrongpass1" } }));
    expect(bad.status).toBe(401);

    const ok = await json(
      await call("/login", { method: "POST", body: { username: "pigone", password: "piglet2026" } }),
    );
    expect(ok.status).toBe(200);
    const me = await json(await call("/me", { token: ok.data.token }));
    expect(me.data.account.username).toBe("pigone");
  });
});

describe("固定房号：绑账号、唯一、只能改一次", () => {
  it("首次领号 → 改一次 → 锁死；别人抢同一个号被拒", async () => {
    const a = await register("pigone");
    const first = await json(
      await call("/me", { method: "PATCH", body: { roomCode: "235417" }, token: a.token }),
    );
    expect(first.data.account.roomCode).toBe("235417");
    expect(first.data.account.roomCodeLocked).toBe(false);

    const changed = await json(
      await call("/me", { method: "PATCH", body: { roomCode: "520131" }, token: a.token }),
    );
    expect(changed.data.account.roomCode).toBe("520131");
    expect(changed.data.account.roomCodeLocked).toBe(true);

    const again = await json(
      await call("/me", { method: "PATCH", body: { roomCode: "111222" }, token: a.token }),
    );
    expect(again.status).toBe(409);
    expect(again.data.error).toBe("room-locked");

    const b = await register("pigtwo");
    const stolen = await json(
      await call("/me", { method: "PATCH", body: { roomCode: "520131" }, token: b.token }),
    );
    expect(stolen.status).toBe(409);
    expect(stolen.data.error).toBe("room-taken");
  });
});

describe("好友与邀请", () => {
  it("请求 → 同意 → 双向好友；邀请只给好友，对方能看到并处理掉", async () => {
    const a = await register("pigone");
    const b = await register("pigtwo");

    const add = await json(await call("/friends", { method: "POST", body: { id: b.account.id }, token: a.token }));
    expect(add.status).toBe(200);

    const bList = await json(await call("/friends", { token: b.token }));
    expect(bList.data.incoming.map((item: any) => item.account.id)).toEqual([a.account.id]);

    const accept = await json(
      await call("/friends/accept", { method: "POST", body: { id: a.account.id }, token: b.token }),
    );
    expect(accept.status).toBe(200);

    const aFriends = await json(await call("/friends", { token: a.token }));
    expect(aFriends.data.friends.map((item: any) => item.account.id)).toEqual([b.account.id]);

    // 邀请：房号 + 留档
    const invite = await json(
      await call("/invites", { method: "POST", body: { id: b.account.id, code: "235417" }, token: a.token }),
    );
    expect(invite.status).toBe(200);
    const bInvites = await json(await call("/invites", { token: b.token }));
    expect(bInvites.data.invites).toHaveLength(1);
    expect(bInvites.data.invites[0].code).toBe("235417");
    expect(bInvites.data.invites[0].from.id).toBe(a.account.id);

    await call(`/invites/${a.account.id}`, { method: "DELETE", token: b.token });
    const after = await json(await call("/invites", { token: b.token }));
    expect(after.data.invites).toHaveLength(0);
  });

  it("非好友发邀请被拒（不给陌生人留骚扰通道）", async () => {
    const a = await register("pigone");
    const b = await register("pigtwo");
    const rejected = await json(
      await call("/invites", { method: "POST", body: { id: b.account.id, code: "235417" }, token: a.token }),
    );
    expect(rejected.status).toBe(403);
  });
});

describe("在线心跳", () => {
  it("心跳写进 presence，好友能看到在线与所在房间", async () => {
    const a = await register("pigone");
    const b = await register("pigtwo");
    await call("/friends", { method: "POST", body: { id: b.account.id }, token: a.token });
    await call("/friends/accept", { method: "POST", body: { id: a.account.id }, token: b.token });

    await call("/presence", { method: "POST", body: { roomCode: "235417" }, token: a.token });
    const list = await json(await call("/friends", { token: b.token }));
    const entry = list.data.friends.find((item: any) => item.account.id === a.account.id);
    expect(entry.presence.state).toBe("online");
    expect(entry.presence.roomCode).toBe("235417");
  });
});
