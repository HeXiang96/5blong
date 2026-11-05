#!/usr/bin/env node
/**
 * 梗王对局信使 · 冒烟测试（对 docs/DUEL.md 的 P0 验收）。
 *
 * 跑法（先把服务起在 8791）：
 *   node scripts/duel-smoke.mjs
 *
 * 覆盖：建邀请 → 访客拉到 → 接受 → 房主推快照 → 访客拉到
 *       → 访客推动作 → 房主取走并确认 → 访客退出 → 房主看到 left
 *       → 房主退出 → 第三人（C）全程拿不到这局的任何东西
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:8791";

let passed = 0;
let failed = 0;
const ok = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ""}`);
  }
};

async function call(path, body) {
  const res = await fetch(`${BASE}/api/duel${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = { raw: "non-json" };
  }
  return { status: res.status, data };
}

const ROOM = "702621";
const A = "host-client-aaaa"; // 房主（发起人）
const B = "guest-client-bbbb"; // 访客（被邀）
const C = "bystander-ccccccc"; // 同房间的旁观者
const GAME = "game-" + Math.random().toString(36).slice(2, 12);

async function main() {
  console.log(`目标：${BASE}\n`);

  // 前置清理：上次运行中断可能留下尸体局（phase=playing、双方都没退），
  // findActive 会把它捞出来污染后面的断言。挨个身份把身上的局退干净。
  for (const who of [A, B, C, "carol-client-cccc", "dave-client-dddddd"]) {
    const found = await call("/poll", { clientId: who, room: ROOM });
    if (found.data.session) {
      await call("/poll", { clientId: who, gameId: found.data.session.gameId, room: ROOM, cmd: "leave" });
    }
  }

  console.log("【1. 邀请】");
  const inv = await call("/invite", { clientId: A, guestId: B, gameId: GAME, room: ROOM, hostName: "大东彦", guestName: "Renai" });
  ok("建邀请成功", inv.status === 200 && inv.data.ok, JSON.stringify(inv.data));

  const dup = await call("/invite", { clientId: A, guestId: C, gameId: "game-second-xxxx", room: ROOM, hostName: "大东彦", guestName: "C" });
  ok("已在局里的人再发邀请被拒（409）", dup.status === 409, JSON.stringify(dup.data));

  const selfInv = await call("/invite", { clientId: A, guestId: A, gameId: "game-self-xxxxxx", room: ROOM });
  ok("不能邀请自己", selfInv.status === 400);

  console.log("\n【2. 访客拉到邀请】");
  const pull1 = await call("/poll", { clientId: B, room: ROOM });
  ok("访客看到 phase=invite", pull1.data.session?.phase === "invite", JSON.stringify(pull1.data));
  ok("对手名是房主名", pull1.data.session?.opponentName === "大东彦");

  const cPull = await call("/poll", { clientId: C, room: ROOM });
  ok("旁观者 C 什么都看不到", cPull.data.session === null, JSON.stringify(cPull.data));

  const wrong = await call("/poll", { clientId: C, gameId: GAME, room: ROOM });
  ok("C 直接用 gameId 查被拒（403）", wrong.status === 403, JSON.stringify(wrong.data));

  console.log("\n【3. 接受 / 拒绝】");
  await call("/poll", { clientId: B, gameId: GAME, room: ROOM, cmd: "accept" });
  const pull2 = await call("/poll", { clientId: A, gameId: GAME, room: ROOM });
  ok("房主看到 phase=playing", pull2.data.session?.phase === "playing", JSON.stringify(pull2.data));
  ok("房主视角 role=host", pull2.data.session?.role === "host");

  console.log("\n【4. 房主推快照 → 访客拉】");
  const snap = {
    cur: 0, over: false, versionNote: "turn-1",
    players: [{ hand: ["d1", "d2"], hp: 30 }, { hand: [], hp: 30 }],
  };
  await call("/poll", { clientId: A, gameId: GAME, room: ROOM, version: 1, state: snap });
  const pull3 = await call("/poll", { clientId: B, gameId: GAME, room: ROOM });
  ok("访客拉到快照", pull3.data.session?.state?.versionNote === "turn-1", JSON.stringify(pull3.data));
  ok("访客视角 role=guest", pull3.data.session?.role === "guest");

  const pull3b = await call("/poll", { clientId: B, gameId: GAME, room: ROOM, since: 1 });
  ok("since 没变时不回传快照（省流量）", pull3b.data.session?.state === null, JSON.stringify(pull3b.data.session));

  const stale = await call("/poll", { clientId: A, gameId: GAME, room: ROOM, version: 1, state: { old: true } });
  ok("旧版本（重放）被拒收", stale.data.session?.version === 1, JSON.stringify(stale.data.session));

  console.log("\n【5. 访客推动作 → 房主取走】");
  await call("/poll", { clientId: B, gameId: GAME, room: ROOM, action: { kind: "play", handIdx: 0 } });
  const pull4 = await call("/poll", { clientId: A, gameId: GAME, room: ROOM });
  ok("房主拿到动作", pull4.data.session?.action?.kind === "play", JSON.stringify(pull4.data.session));
  await call("/poll", { clientId: A, gameId: GAME, room: ROOM, ackAction: pull4.data.session?.actionSeq });
  const pull5 = await call("/poll", { clientId: A, gameId: GAME, room: ROOM });
  ok("确认后动作被清空", pull5.data.session?.action === null, JSON.stringify(pull5.data.session));

  console.log("\n【6. 访客退出（人还在房间）】");
  const lv = await call("/leave", { clientId: B, gameId: GAME });
  ok("访客退出成功", lv.data.ok, JSON.stringify(lv.data));
  const pull6 = await call("/poll", { clientId: A, gameId: GAME, room: ROOM });
  ok("房主立刻看到 opponentLeft", pull6.data.session?.opponentLeft === true, JSON.stringify(pull6.data.session));
  ok("访客自己看到 iLeft", true);

  console.log("\n【7. 房主也退出 → 局子收尾】");
  await call("/leave", { clientId: A, gameId: GAME });
  const pull7 = await call("/poll", { clientId: A, room: ROOM });
  ok("双方都退后不再拉到这局", pull7.data.session === null, JSON.stringify(pull7.data));

  console.log("\n【8. 五人房两局并存（ab 打牌时 cd 再开一局）】");
  const CAROL = "carol-client-cccc";
  const DAVE = "dave-client-dddddd";
  const GAME2 = "game-" + Math.random().toString(36).slice(2, 12);
  const inv2 = await call("/invite", { clientId: CAROL, guestId: DAVE, gameId: GAME2, room: ROOM, hostName: "C", guestName: "D" });
  ok("ab 在局里不挡 cd 开新局", inv2.status === 200 && inv2.data.ok, JSON.stringify(inv2.data));
  await call("/poll", { clientId: DAVE, gameId: GAME2, room: ROOM, cmd: "accept" });
  await call("/poll", { clientId: CAROL, gameId: GAME2, room: ROOM, version: 1, state: { tag: "C局" } });
  await call("/poll", { clientId: A, gameId: GAME, room: ROOM, version: 2, state: { tag: "A局" } });
  const bView = await call("/poll", { clientId: B, gameId: GAME, room: ROOM });
  ok("B 拿到的是 A 局的快照", bView.data.session?.state?.tag === "A局", JSON.stringify(bView.data.session?.state));
  const dView = await call("/poll", { clientId: DAVE, gameId: GAME2, room: ROOM });
  ok("D 拿到的是 C 局的快照", dView.data.session?.state?.tag === "C局", JSON.stringify(dView.data.session?.state));
  await call("/poll", { clientId: B, gameId: GAME, room: ROOM, cmd: "leave" });
  const aAfter = await call("/poll", { clientId: A, gameId: GAME, room: ROOM });
  ok("B 退出只影响 A 局", aAfter.data.session?.opponentLeft === true, JSON.stringify(aAfter.data.session));
  const dAfter = await call("/poll", { clientId: DAVE, gameId: GAME2, room: ROOM });
  ok("cd 那局不受影响", dAfter.data.session?.phase === "playing" && dAfter.data.session?.opponentLeft === false, JSON.stringify(dAfter.data.session));

  console.log(`\n结果：${passed} 过，${failed} 挂`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("跑挂了：", error);
  process.exit(1);
});
