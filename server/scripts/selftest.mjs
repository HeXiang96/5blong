#!/usr/bin/env node
/**
 * 端到端冒烟测试：对着**已经跑起来的**服务打真实 HTTP 请求。
 *
 * 覆盖顺序刻意按"一个真人从注册到被邀请进房"的路径走：
 *   注册 → 我的资料 → 加好友 → 对方同意 → 快照 → 在线心跳
 *   → 发邀请 → 拉邀请 → 改密码 → 用新密码登录 → 旧会话失效 → TURN 凭据
 *
 * 用法：
 *   node scripts/selftest.mjs                     # 默认 http://127.0.0.1:8788
 *   BASE=http://127.0.0.1:8788 node scripts/selftest.mjs
 *
 * 注意：它会**真的写数据**（两个测试账号 + 好友关系）。
 * 所以只在开发/验收库上跑，别对着生产库跑。
 */

const BASE = process.env.BASE ?? "http://127.0.0.1:8788";
const suffix = Date.now().toString(36).slice(-5);

let passed = 0;
let failed = 0;

function ok(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ""}`);
  }
}

async function call(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") ?? "" };
}

async function main() {
  const remote = !/\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE);
  console.log(`目标：${BASE}${remote ? "（公网）" : "（本机）"}\n`);

  // ---- 0. 健康检查 ----
  console.log("【健康检查】");
  const health = await call("/healthz");
  if (remote) {
    /*
     * /healthz 在 nginx 里是 `allow 127.0.0.1; deny all;` —— 公网访问返回 403 是**正确行为**，
     * 不是故障。之前把这里算成失败，白白多出两条红字，会误导人以为部署有问题。
     */
    if (health.status === 403) {
      console.log("  · /healthz 对公网关闭（nginx 只放行本机），403 属正常，跳过");
    } else {
      ok("公网竟然能访问 /healthz（应被 nginx 拦住）", false, `状态 ${health.status}`);
    }
  } else {
    ok("GET /healthz 返回 200", health.status === 200, `实际 ${health.status}`);
    ok("healthz 带 ok=true", health.data?.ok === true);
    console.log(`    账号数 ${health.data?.accounts} · TURN ${health.data?.turnConfigured ? "已配置" : "未配置"}`);
  }

  // ---- 1. 注册 ----
  console.log("\n【注册】");
  const aliceName = `alice${suffix}`;
  const regA = await call("/api/account/register", {
    method: "POST",
    body: { username: aliceName, password: "test1234", name: "小甲" },
  });
  ok("注册成功", regA.status === 200, JSON.stringify(regA.data).slice(0, 120));
  const alice = regA.data?.account;
  ok("返回 8 位数字 ID", /^\d{8}$/.test(String(alice?.id ?? "")), String(alice?.id));
  ok("返回 token", typeof regA.data?.token === "string" && regA.data.token.length >= 64);
  ok("下发了 cookie", /5blong_sess=/.test(regA.setCookie), regA.setCookie.slice(0, 40));

  // 用户名唯一（大小写不敏感）
  const dupe = await call("/api/account/register", {
    method: "POST",
    body: { username: aliceName.toUpperCase(), password: "test1234" },
  });
  ok("用户名大小写不敏感地判重", dupe.status === 409 && dupe.data?.error === "username-taken", `实际 ${dupe.status} ${dupe.data?.error}`);

  // 弱密码
  const weak = await call("/api/account/register", {
    method: "POST",
    body: { username: `weak${suffix}`, password: "aaaaaaaa" },
  });
  ok("弱密码被拒", weak.status === 400 && weak.data?.error === "password-weak");

  const bobName = `bob${suffix}`;
  const regB = await call("/api/account/register", {
    method: "POST",
    body: { username: bobName, password: "test5678", name: "小乙" },
  });
  const bob = regB.data?.account;
  ok("第二个账号注册成功", regB.status === 200);

  // ---- 2. 我的资料 ----
  console.log("\n【我的资料】");
  const me = await call("/api/account/me", { token: regA.data.token });
  ok("GET /me 拿到自己", me.data?.account?.id === alice.id);

  const renamed = await call("/api/account/me", {
    method: "PATCH",
    token: regA.data.token,
    body: { name: "小甲改名" },
  });
  ok("PATCH /me 改昵称", renamed.data?.account?.name === "小甲改名", renamed.data?.account?.name);

  /*
   * 房号要**每轮随机**：写死的话第二次跑就会被上一轮的账号占着，
   * 「首次认领」直接返回 room-taken —— 看着像产品 bug，其实是测试脚本自己的问题。
   * 6 位、留出 +1/+2 的余量，保证不会溢出到 7 位。
   */
  const roomSeed = 100_000 + Math.floor(Math.random() * 700_000);
  const room1Code = String(roomSeed);
  const room2Code = String(roomSeed + 1);
  const room3Code = String(roomSeed + 2);

  const room1 = await call("/api/account/me", {
    method: "PATCH",
    token: regA.data.token,
    body: { roomCode: room1Code },
  });
  ok("首次认领房号", room1.data?.account?.roomCode === room1Code, JSON.stringify(room1.data).slice(0, 80));
  ok("首次领号未锁定", room1.data?.account?.roomCodeLocked === false);
  const room2 = await call("/api/account/me", {
    method: "PATCH",
    token: regA.data.token,
    body: { roomCode: room2Code },
  });
  ok("第二次改号后锁定", room2.data?.account?.roomCodeLocked === true, JSON.stringify(room2.data).slice(0, 80));
  const room3 = await call("/api/account/me", {
    method: "PATCH",
    token: regA.data.token,
    body: { roomCode: room3Code },
  });
  ok("锁定后再改被拒", room3.status === 409 && room3.data?.error === "room-locked", `实际 ${room3.status} ${room3.data?.error}`);

  // 房号查重（公开接口）
  const claim = await call(`/api/account/room-claim?code=${room2Code}`);
  ok("room-claim 认出已占用", claim.data?.taken === true);

  // ---- 3. 好友 ----
  console.log("\n【好友】");
  const add = await call("/api/account/friends", {
    method: "POST",
    token: regA.data.token,
    body: { id: bob.id, note: "我是小甲" },
  });
  ok("发出好友申请", add.status === 200 && add.data?.pending === true, JSON.stringify(add.data).slice(0, 100));

  const snapB = await call("/api/account/friends", { token: regB.data.token });
  ok("对方看到待处理申请", (snapB.data?.incoming ?? []).some((item) => item.account.id === alice.id));
  ok("申请附言被带过去", (snapB.data?.incoming ?? [])[0]?.note === "我是小甲");

  const accept = await call("/api/account/friends/accept", {
    method: "POST",
    token: regB.data.token,
    body: { id: alice.id },
  });
  ok("同意好友申请", accept.status === 200 && accept.data?.account?.id === alice.id);

  const snapA = await call("/api/account/friends", { token: regA.data.token });
  ok("发起方好友列表里出现对方", (snapA.data?.friends ?? []).some((item) => item.account.id === bob.id));
  ok("待处理已清空", (snapA.data?.outgoing ?? []).length === 0);

  // 备注名
  const alias = await call(`/api/account/friends/${bob.id}`, {
    method: "PATCH",
    token: regA.data.token,
    body: { alias: "老乙" },
  });
  ok("设置备注名", alias.data?.alias === "老乙");
  const snapA2 = await call("/api/account/friends", { token: regA.data.token });
  ok("快照里带回备注名", (snapA2.data?.friends ?? [])[0]?.alias === "老乙");

  // ---- 4. 在线心跳 + 邀请 ----
  console.log("\n【在线 / 邀请】");
  const presence = await call("/api/account/presence", {
    method: "POST",
    token: regB.data.token,
    body: { roomCode: "123456" },
  });
  ok("上报在线心跳", presence.data?.ok === true);
  const snapA3 = await call("/api/account/friends", { token: regA.data.token });
  const bobPresence = (snapA3.data?.friends ?? [])[0]?.presence;
  ok("好友显示在线", bobPresence?.state === "online", JSON.stringify(bobPresence));
  ok("带回所在房号", bobPresence?.roomCode === "123456", bobPresence?.roomCode);

  const invite = await call("/api/account/invites", {
    method: "POST",
    token: regB.data.token,
    body: { id: alice.id, code: "123456", roomKey: "abcdefghijklmnopqrstuvwxyz012345" },
  });
  ok("好友可以发邀请", invite.status === 200, JSON.stringify(invite.data));

  const invitesA = await call("/api/account/invites", { token: regA.data.token });
  const firstInvite = (invitesA.data?.invites ?? [])[0];
  ok("被邀请方看到邀请", firstInvite?.from?.id === bob.id);
  ok("邀请带房号", firstInvite?.code === "123456");
  ok("邀请带房间钥匙", typeof firstInvite?.roomKey === "string");

  const dismiss = await call(`/api/account/invites/${bob.id}`, {
    method: "DELETE",
    token: regA.data.token,
  });
  ok("可以忽略邀请", dismiss.data?.ok === true);
  const invitesA2 = await call("/api/account/invites", { token: regA.data.token });
  ok("忽略后列表为空", (invitesA2.data?.invites ?? []).length === 0);

  // ---- 5. 改密码 ----
  console.log("\n【改密码】");
  const wrongOld = await call("/api/account/password", {
    method: "POST",
    token: regA.data.token,
    body: { current: "wrongpass", next: "newpass123" },
  });
  ok("旧密码错被拒", wrongOld.status === 401 && wrongOld.data?.error === "bad-credentials");
  const same = await call("/api/account/password", {
    method: "POST",
    token: regA.data.token,
    body: { current: "test1234", next: "test1234" },
  });
  ok("新旧相同被拒", same.status === 400 && same.data?.error === "same-password", `${same.status} ${same.data?.error}`);
  const changed = await call("/api/account/password", {
    method: "POST",
    token: regA.data.token,
    body: { current: "test1234", next: "newpass123" },
  });
  ok("改密码成功", changed.status === 200, JSON.stringify(changed.data));

  const loginNew = await call("/api/account/login", {
    method: "POST",
    body: { username: aliceName, password: "newpass123" },
  });
  ok("新密码能登录", loginNew.status === 200, JSON.stringify(loginNew.data).slice(0, 80));
  const loginOld = await call("/api/account/login", {
    method: "POST",
    body: { username: aliceName, password: "test1234" },
  });
  ok("旧密码登不上", loginOld.status === 401);

  // ---- 6. 登出 ----
  console.log("\n【登出】");
  const out = await call("/api/account/logout", { method: "POST", token: loginNew.data?.token });
  ok("登出成功", out.data?.ok === true);
  const afterOut = await call("/api/account/me", { token: loginNew.data?.token });
  ok("登出后 /me 为空", afterOut.data?.account === null, JSON.stringify(afterOut.data));

  // ---- 7. TURN 凭据 ----
  console.log("\n【TURN 凭据】");
  const ice = await call("/ice");
  if (ice.status === 200) {
    const servers = ice.data?.iceServers ?? [];
    ok("GET /ice 返回 iceServers", servers.length > 0);
    ok("包含 TURN 服务器", JSON.stringify(servers).includes("turn:"), JSON.stringify(servers).slice(0, 120));
  } else if (ice.status === 501) {
    console.log("  · 跳过：服务端还没配 TURN key（客户端会自动退回纯 STUN，属于正常降级）");
  } else {
    ok("GET /ice 状态异常", false, `${ice.status} ${JSON.stringify(ice.data)}`);
  }

  // ---- 汇总 ----
  console.log(`\n${"─".repeat(46)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.log("\n❌ 有失败项，先别上线");
    process.exit(1);
  }
  console.log("\n✅ 全部通过");
}

main().catch((error) => {
  console.error("\n冒烟测试异常中断：", error.message);
  console.error(`检查服务是否在 ${BASE} 上跑着`);
  process.exit(1);
});
