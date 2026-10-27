/**
 * 账号 API（worker/_worker.pages.js 的 /api/account/*）集成测试。
 *
 * 为什么要这么测：这块代码直接跑在线上 Pages Worker 里、前面没有任何自动化，
 * 而它管着注册登录、固定房号唯一性、好友双向、邀请留档——出错就是数据错乱。
 * 这里用 node:sqlite 搭一个最小的 D1 替身（prepare/bind/first/all/run/batch），
 * 把真实的 handler 从头跑一遍。
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../worker/_worker.pages.js";

const SCHEMA = readFileSync("worker/accounts-schema.sql", "utf8");

/** D1 的最小替身：只实现 handler 真正用到的那几个方法。 */
class FakeD1 {
  private sqlite: any;
  /** 直接摸库的入口（只给"看表里到底存了什么"这类断言用） */
  raw: any;
  constructor(sqlite: any) {
    this.sqlite = sqlite;
    this.raw = sqlite;
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

describe("密码哈希的硬约束", () => {
  it("PBKDF2 迭代次数不能超过 Workers 的 10 万上限", () => {
    // 超过上限时 Workers 直接抛错，整条注册接口 500（2026-10-26 线上事故）。
    // 这条断言就是防止有人"为了更安全"把数字往上调。
    const source = readFileSync("worker/_worker.pages.js", "utf8");
    const match = /const PBKDF2_ROUNDS = ([\d_]+)/.exec(source);
    expect(match, "找不到 PBKDF2_ROUNDS").toBeTruthy();
    const rounds = Number(String(match![1]).replace(/_/g, ""));
    expect(rounds).toBeLessThanOrEqual(100_000);
    expect(rounds).toBeGreaterThanOrEqual(50_000);
  });

  it("哈希串自带迭代次数（换强度不影响老密码）", async () => {
    const { account, token } = await register("pighash");
    expect(account.id).toMatch(/^\d{8}$/);
    const me = await json(await call("/me", { token }));
    expect(me.data.account.username).toBe("pighash");
    const stored = env.DB.raw.prepare("SELECT hash FROM accounts WHERE id = ?").get(account.id);
    expect(stored?.hash).toMatch(/^pbkdf2\$\d+\$[0-9a-f]{64}$/);
  });
});

describe("房号占用查询（开临时房前查重）", () => {
  it("未认领 = false；被认领 = true；非法码一律 false；不泄漏归属人", async () => {
    const me = await register("pigclaim");
    const before = await json(await call("/room-claim?code=100000"));
    expect(before.data).toEqual({ taken: false });

    await call("/me", { method: "PATCH", body: { roomCode: "100000" }, token: me.token });

    const after = await json(await call("/room-claim?code=100000"));
    expect(after.data).toEqual({ taken: true }); // 只有 taken，没有账号信息

    expect((await json(await call("/room-claim?code=12345"))).data).toEqual({ taken: false });
    expect((await json(await call("/room-claim"))).data).toEqual({ taken: false });
  });
});

describe("房号占位（认领号不能被临时房占用）", () => {
  const TOKEN_A = "token-aaaa-1111";
  const TOKEN_B = "token-bbbb-2222";

  it("同一时刻只有一个客户端能占住；释放后别人才能占", async () => {
    const first = await json(
      await call("/room-hold", { method: "POST", body: { code: "777001", token: TOKEN_A } }),
    );
    expect(first.status).toBe(200);

    const second = await json(
      await call("/room-hold", { method: "POST", body: { code: "777001", token: TOKEN_B } }),
    );
    expect(second.status).toBe(409);
    expect(second.data.error).toBe("busy");

    // 自己续期是允许的
    expect(
      (await json(await call("/room-hold", { method: "POST", body: { code: "777001", token: TOKEN_A } })))
        .status,
    ).toBe(200);

    await call(`/room-hold?token=${TOKEN_A}`, { method: "DELETE" });
    expect(
      (await json(await call("/room-hold", { method: "POST", body: { code: "777001", token: TOKEN_B } })))
        .status,
    ).toBe(200);
  });

  it("已被账号认领的号，谁也占不住", async () => {
    const me = await register("pighold");
    await call("/me", { method: "PATCH", body: { roomCode: "777002" }, token: me.token });
    const blocked = await json(
      await call("/room-hold", { method: "POST", body: { code: "777002", token: TOKEN_B } }),
    );
    expect(blocked.status).toBe(409);
    expect(blocked.data.error).toBe("taken");
  });

  it("反方向也成立：正被人开着（有占位）的号，不能认领", async () => {
    await call("/room-hold", { method: "POST", body: { code: "777003", token: TOKEN_A } });
    const me = await register("pigclaim2");
    const res = await json(
      await call("/me", { method: "PATCH", body: { roomCode: "777003" }, token: me.token }),
    );
    expect(res.status).toBe(409);
    expect(res.data.error).toBe("room-taken");
  });

  it("改号之后，旧号回池：别人能占、也能认领", async () => {
    const me = await register("pigchange");
    await call("/me", { method: "PATCH", body: { roomCode: "777004" }, token: me.token });
    // 领号后这个号谁也占不住
    expect(
      (await json(await call("/room-hold", { method: "POST", body: { code: "777004", token: TOKEN_A } })))
        .status,
    ).toBe(409);

    // 用掉唯一一次改号机会
    await call("/me", { method: "PATCH", body: { roomCode: "777005" }, token: me.token });

    // 旧号 777004 已经回到池子：别人可以认领
    const other = await register("pigother");
    const take = await json(
      await call("/me", { method: "PATCH", body: { roomCode: "777004" }, token: other.token }),
    );
    expect(take.status).toBe(200);
    expect(take.data.account.roomCode).toBe("777004");
  });
});

interface AdminOptions {
  method?: string;
  form?: Record<string, string>;
  staff?: string;
}

/** 管理员页面不在 /api 下，单独包一层。 */
function adminRequest(path: string, { method = "GET", form, staff }: AdminOptions = {}) {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  return worker.fetch(
    new Request(`https://5blong.pages.dev${path}`, {
      method,
      headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : {},
      ...(body ? { body } : {}),
      redirect: "manual",
    }),
    { ...env, FEEDBACK_TOKEN: staff ?? "owner-token-123" },
  );
}

describe("账号后台 /accounts-admin", () => {
  it("列表显示用户名/昵称/房号，且绝不出现密码哈希", async () => {
    const a = await register("adminlist");
    await call("/me", { method: "PATCH", body: { roomCode: "910001" }, token: a.token });

    const res = await adminRequest("/accounts-admin?staff=owner-token-123");
    const html = await res.text();
    if (res.status !== 200) {
      writeFileSync("outputs/admin-500.html", html);
      console.log("dumped outputs/admin-500.html");
    }
    expect(res.status).toBe(200);
    expect(html).toContain("adminlist");
    expect(html).toContain("910001");
    // 密码相关字段一个都不许出现
    expect(html).not.toContain("pbkdf2$");
    expect(html).not.toContain('name="password"');
    const stored = env.DB.raw.prepare("SELECT hash FROM accounts WHERE username = ?").get("adminlist");
    expect(html).not.toContain(String(stored.hash).slice(-24));
  });

  it("没令牌看不了", async () => {
    const res = await adminRequest("/accounts-admin");
    expect(res.status).toBe(401);
  });

  it("管理员能改已锁定的房号，也能清空回池，并留审计", async () => {
    const a = await register("adminroom");
    await call("/me", { method: "PATCH", body: { roomCode: "910002" }, token: a.token });
    await call("/me", { method: "PATCH", body: { roomCode: "910003" }, token: a.token }); // 用掉唯一一次

    const changed = await adminRequest("/accounts-admin?staff=owner-token-123", {
      method: "POST",
      form: { action: "set_room", id: a.account.id, code: "910009" },
    });
    expect(changed.status).toBe(303);
    // 重设计后的操作反馈：成功带 ok: 前缀，错误带 err: 前缀（渲染成分色的两栏）
    const location = changed.headers.get("location") ?? "";
    expect(location).toContain(encodeURIComponent("ok:已把"));

    // 「最近操作」时间线直接读审计表，刷新也不丢
    const page = await adminRequest("/accounts-admin?staff=owner-token-123");
    const html = await page.text();
    expect(html).toContain("最近操作");
    expect(html).toContain("910009");

    const me = await json(await call("/me", { token: a.token }));
    expect(me.data.account.roomCode).toBe("910009");
    expect(me.data.account.roomCodeLocked).toBe(true); // 管理员改完仍是锁定态

    const audit = env.DB.raw
      .prepare("SELECT action, detail FROM admin_audit WHERE target = ? ORDER BY id DESC")
      .all(a.account.id);
    expect(audit.map((row: any) => row.action)).toContain("room_set");

    await adminRequest("/accounts-admin?staff=owner-token-123", {
      method: "POST",
      form: { action: "set_room", id: a.account.id, clear: "1" },
    });
    expect((await json(await call("/me", { token: a.token }))).data.account.roomCode).toBeUndefined();
  });

  it("管理员能改数字 ID，好友与会话一起搬过去", async () => {
    const a = await register("adminid");
    const b = await register("adminid2");
    await call("/friends", { method: "POST", body: { id: b.account.id }, token: a.token });
    await call("/friends/accept", { method: "POST", body: { id: a.account.id }, token: b.token });

    const res = await adminRequest("/accounts-admin?staff=owner-token-123", {
      method: "POST",
      form: { action: "set_id", id: a.account.id, newid: "12345678" },
    });
    expect(res.status).toBe(303);

    // 新 ID 能直接用原 cookie 访问（sessions 已级联）
    const me = await json(await call("/me", { token: a.token }));
    expect(me.data.account.id).toBe("12345678");
    // B 那边看到的还是同一个好友，只是 ID 变了
    const bList = await json(await call("/friends", { token: b.token }));
    expect(bList.data.friends.map((item: any) => item.account.id)).toEqual(["12345678"]);
  });

  it("非 main 的员工令牌不能改数字 ID", async () => {
    const hash = await (async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("staff-token-456"));
      // 与 worker 的 sha256Hex 一致：取前 32 位十六进制
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32);
    })();
    env.DB.raw.exec(
      "CREATE TABLE IF NOT EXISTS staff_tokens (id TEXT PRIMARY KEY, name TEXT, scope TEXT, token_hash TEXT, created_at INTEGER, expires_at INTEGER, revoked INTEGER DEFAULT 0)",
    );
    env.DB.raw
      .prepare(
        "INSERT INTO staff_tokens (id, name, scope, token_hash, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)",
      )
      .run("s1", "运营", "game", hash, Date.now(), Date.now() + 86_400_000);

    const a = await register("adminstaff");
    const res = await adminRequest("/accounts-admin?staff=staff-token-456", {
      method: "POST",
      form: { action: "set_id", id: a.account.id, newid: "22223333" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location") ?? "").toContain(encodeURIComponent("err:"));
    const me = await json(await call("/me", { token: a.token }));
    expect(me.data.account.id).toBe(a.account.id); // 没被改
  });
});

describe("邀请一键直达 / 改 ID 后客户端同步", () => {
  it("私密房邀请带着房间钥匙，对方拿到的是完整邀请", async () => {
    const a = await register("inviter");
    const b = await register("invitee");
    await call("/friends", { method: "POST", body: { id: b.account.id }, token: a.token });
    await call("/friends/accept", { method: "POST", body: { id: a.account.id }, token: b.token });

    const key = "abcdefghijklmnopqrstuvwx";
    await call("/invites", {
      method: "POST",
      body: { id: b.account.id, code: "930001", roomKey: key },
      token: a.token,
    });
    const list = await json(await call("/invites", { token: b.token }));
    expect(list.data.invites[0].code).toBe("930001");
    expect(list.data.invites[0].roomKey).toBe(key);

    // 钥匙格式不对就不落库（不因为一个脏字段把邀请搞坏）
    await call("/invites", {
      method: "POST",
      body: { id: b.account.id, code: "930001", roomKey: "短" },
      token: a.token,
    });
    const after = await json(await call("/invites", { token: b.token }));
    expect(after.data.invites[0].roomKey).toBeUndefined();
  });

  it("改完数字 ID 会带出 previousId，客户端确认后清掉", async () => {
    const me = await register("idmover");
    await adminRequest("/accounts-admin?staff=owner-token-123", {
      method: "POST",
      form: { action: "set_id", id: me.account.id, newid: "31415926" },
    });

    const after = await json(await call("/me", { token: me.token }));
    expect(after.data.account.id).toBe("31415926");
    expect(after.data.account.previousId).toBe(me.account.id);

    await call("/me/ack-id-change", { method: "POST", token: me.token });
    const cleared = await json(await call("/me", { token: me.token }));
    expect(cleared.data.account.previousId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 好友体验补全（2026-10-27）
// ---------------------------------------------------------------------------
describe("好友体验补全", () => {
  /** 建两个账号（每个 it 都是新库，用户名可以复用）。 */
  async function pair() {
    const a = await register("piga");
    const b = await register("pigb");
    return { a, b };
  }

  /** 记录服务端推了几次、推了什么（推送是 service binding 到信令 Worker）。 */
  function spyPushes() {
    const pushes: { acct: string; kind: string }[] = [];
    env.SIGNAL = {
      fetch: async (_url: string, init: { body?: string }) => {
        pushes.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response("{}");
      },
    };
    return pushes;
  }

  async function befriend(a: any, b: any) {
    await call("/friends", { method: "POST", body: { id: b.account.id }, token: a.token });
    await call("/friends/accept", { method: "POST", body: { id: a.account.id }, token: b.token });
  }

  it("还没被同意时重复点「加好友」：不再重复推对方", async () => {
    const { a, b } = await pair();
    const pushes = spyPushes();

    await call("/friends", { method: "POST", body: { id: b.account.id }, token: a.token });
    const afterFirst = pushes.length;
    expect(afterFirst).toBeGreaterThan(0);

    await call("/friends", { method: "POST", body: { id: b.account.id }, token: a.token });
    await call("/friends", { method: "POST", body: { id: b.account.id }, token: a.token });
    // 后两次只是"确认已发送"，不该再敲对方
    expect(pushes.length).toBe(afterFirst);
  });

  it("被拒绝后 24 小时内不许再申请；拒绝记录不出现在对方的已发出里", async () => {
    const { a, b } = await pair();
    await call("/friends", { method: "POST", body: { id: b.account.id }, token: a.token });
    await call("/friends/reject", { method: "POST", body: { id: a.account.id }, token: b.token });

    const outgoing = await json(await call("/friends", { token: a.token }));
    expect(outgoing.data.outgoing).toHaveLength(0);

    const again = await json(
      await call("/friends", { method: "POST", body: { id: b.account.id }, token: a.token }),
    );
    expect(again.status).toBe(429);
    expect(again.data.error).toBe("cooldown");
  });

  it("删好友：被删的人加不回来，删人的人可以立刻加回来", async () => {
    const { a, b } = await pair();
    await befriend(a, b);
    await call(`/friends/${b.account.id}`, { method: "DELETE", token: a.token });

    const blocked = await json(
      await call("/friends", { method: "POST", body: { id: a.account.id }, token: b.token }),
    );
    expect(blocked.data.error).toBe("cooldown");

    const back = await json(
      await call("/friends", { method: "POST", body: { id: b.account.id }, token: a.token }),
    );
    expect(back.status).toBe(200);
    expect(back.data.error).toBeUndefined();
  });

  it("备注名只自己可见", async () => {
    const { a, b } = await pair();
    await befriend(a, b);
    await call(`/friends/${b.account.id}`, { method: "PATCH", body: { alias: "老王" }, token: a.token });

    const mine = await json(await call("/friends", { token: a.token }));
    expect(mine.data.friends[0].alias).toBe("老王");

    const his = await json(await call("/friends", { token: b.token }));
    expect(his.data.friends[0].alias).toBeUndefined();
  });

  it("加好友附言会带给对方，并截到 30 个字", async () => {
    const { a, b } = await pair();
    await call("/friends", {
      method: "POST",
      body: { id: b.account.id, note: "我是刚才那个" },
      token: a.token,
    });
    let list = await json(await call("/friends", { token: b.token }));
    expect(list.data.incoming[0].note).toBe("我是刚才那个");

    // 换一个人发一条超长附言
    const c = await register("pigc");
    await call("/friends", {
      method: "POST",
      body: { id: b.account.id, note: "很".repeat(50) },
      token: c.token,
    });
    list = await json(await call("/friends", { token: b.token }));
    const fromC = list.data.incoming.find((item: any) => item.account.id === c.account.id);
    expect(Array.from(fromC.note as string).length).toBe(30);
  });

  it("最近一起玩：只记真实存在的账号，过滤自己和编的号", async () => {
    const { a, b } = await pair();
    await call("/recent-plays", {
      method: "POST",
      body: { ids: [b.account.id, "99999999", a.account.id] },
      token: a.token,
    });
    const plays = await json(await call("/recent-plays", { token: a.token }));
    expect(plays.data.plays.map((item: any) => item.account.id)).toEqual([b.account.id]);
    // 别人看不到我的记录
    const his = await json(await call("/recent-plays", { token: b.token }));
    expect(his.data.plays).toHaveLength(0);
  });

  it("敲门：房主同意后，申请者拿到带钥匙的邀请", async () => {
    const { a, b } = await pair();
    await befriend(a, b);

    await call("/knocks", { method: "POST", body: { id: b.account.id }, token: a.token });
    const knocks = await json(await call("/knocks", { token: b.token }));
    expect(knocks.data.knocks).toHaveLength(1);
    expect(knocks.data.knocks[0].from.id).toBe(a.account.id);

    // 非好友门都敲不了
    const c = await register("pigc2");
    const stranger = await json(
      await call("/knocks", { method: "POST", body: { id: c.account.id }, token: a.token }),
    );
    expect(stranger.status).toBe(403);

    const key = "abcdefghijklmnopqrstuvwx";
    const accept = await json(
      await call("/knocks/accept", {
        method: "POST",
        body: { from: a.account.id, code: "930002", roomKey: key },
        token: b.token,
      }),
    );
    expect(accept.status).toBe(200);

    const invites = await json(await call("/invites", { token: a.token }));
    expect(invites.data.invites[0].code).toBe("930002");
    expect(invites.data.invites[0].roomKey).toBe(key);

    // 敲过就被消费掉，不会一直挂在房主的待处理里
    const after = await json(await call("/knocks", { token: b.token }));
    expect(after.data.knocks).toHaveLength(0);
  });

  it("邀请里带房主的在线状态（用来标出可能已失效的老邀请）", async () => {
    const { a, b } = await pair();
    await befriend(a, b);
    await call("/presence", { method: "POST", body: { roomCode: "930003" }, token: a.token });
    await call("/invites", {
      method: "POST",
      body: { id: b.account.id, code: "930003" },
      token: a.token,
    });
    const list = await json(await call("/invites", { token: b.token }));
    expect(list.data.invites[0].fromPresence.state).toBe("online");
    expect(list.data.invites[0].fromPresence.roomCode).toBe("930003");
  });

  it("好友快照不泄露对方的固定房号与旧 ID（只给公开档案）", async () => {
    const { a, b } = await pair();
    await call("/me", { method: "PATCH", body: { roomCode: "930004" }, token: a.token });
    await befriend(a, b);
    const list = await json(await call("/friends", { token: b.token }));
    const entry = list.data.friends[0];
    expect(entry.account.roomCode).toBeUndefined();
    expect(entry.account.roomCodeLocked).toBeUndefined();
    expect(entry.account.previousId).toBeUndefined();
    // 昵称/用户名/ID 仍然齐全（界面要靠它们显示与加好友）
    expect(entry.account.id).toBe(a.account.id);
    expect(entry.account.username).toBe("piga");
  });
});

describe("删好友的连带清理", () => {
  it("删掉好友后：邀请、敲门、「最近一起玩」都不再留着他的记录", async () => {
    const a = await register("pigdel1");
    const b = await register("pigdel2");
    await call("/friends", { method: "POST", body: { id: b.account.id }, token: a.token });
    await call("/friends/accept", { method: "POST", body: { id: a.account.id }, token: b.token });

    // 先造出三种"关系残留"
    await call("/invites", {
      method: "POST",
      body: { id: b.account.id, code: "930005" },
      token: a.token,
    });
    await call("/knocks", { method: "POST", body: { id: b.account.id }, token: a.token });
    await call("/recent-plays", {
      method: "POST",
      body: { ids: [b.account.id] },
      token: a.token,
    });
    expect((await json(await call("/invites", { token: b.token }))).data.invites).toHaveLength(1);

    await call(`/friends/${b.account.id}`, { method: "DELETE", token: a.token });

    // 列表层面：双方都看不到对方了
    expect((await json(await call("/friends", { token: b.token }))).data.friends).toHaveLength(0);
    // 残留记录也清了：否则对方还能凭旧邀请点进来、还能从「最近玩」再点一次加好友
    expect((await json(await call("/invites", { token: b.token }))).data.invites).toHaveLength(0);
    expect((await json(await call("/knocks", { token: b.token }))).data.knocks).toHaveLength(0);
    expect((await json(await call("/recent-plays", { token: a.token }))).data.plays).toHaveLength(0);
    expect((await json(await call("/recent-plays", { token: b.token }))).data.plays).toHaveLength(0);
  });
});
