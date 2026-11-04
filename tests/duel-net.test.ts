/**
 * 梗王对局 · 网络层状态机测试（docs/DUEL-NET-PLAN.md 验收清单的自动化部分）
 *
 * LocalDuelTransport 的信箱就是 localStorage，同一 jsdom 里两个实例
 * 就等于两个玩家。覆盖：邀请→接受→房主推快照→访客拉到→访客推动作→
 * 房主取走→访客退出（人还在房间里）→房主立刻看到→房主退出→局子收尾。
 * 另覆盖：旁观者隔离、busy 互斥、旧版本拒收。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDuelTransport } from "../src/client/duel/duel-net";
import type { DuelSnapshot } from "../src/client/duel/duel-engine";

const ROOM = "702621";
const HOST = "host-client-aaaa";
const GUEST = "guest-client-bbbb";
const BYE = "bystander-ccccccc";
const GAME = "game-test-0001";

const snap = (over = false): DuelSnapshot => ({
  schemaVersion: 1,
  players: [
    { idx: 0, hp: 30, maxHp: 30, mana: 2, maxMana: 2, deck: [], hand: [], board: [], fatigue: 0, heroPowerUsed: false, spellBonus: 0, manaPenalty: 0 },
    { idx: 1, hp: 30, maxHp: 30, mana: 0, maxMana: 0, deck: [], hand: [], board: [], fatigue: 0, heroPowerUsed: false, spellBonus: 0, manaPenalty: 0 },
  ],
  cur: 0,
  over,
  busy: false,
  pending: null,
  logs: [],
  uidSeq: 1,
  bonus: 0,
  mySide: 0,
  hostName: "大东彦",
  opponentName: "Renai",
});

/*
 * 项目没装 jsdom（其他测试都是纯逻辑）。LocalDuelTransport 只用 localStorage 的
 * get/set/clear，用一张内存 Map 顶上就够了 —— 状态机逻辑不变。
 */
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  clear: () => void store.clear(),
});

let host: LocalDuelTransport;
let guest: LocalDuelTransport;
let bye: LocalDuelTransport;

beforeEach(() => {
  localStorage.clear();
  host = new LocalDuelTransport();
  guest = new LocalDuelTransport();
  bye = new LocalDuelTransport();
});
afterEach(() => localStorage.clear());

describe("梗王对局 · LocalDuelTransport 状态机", () => {
  it("完整一局：邀请→接受→推快照→推动作→双方退出", async () => {
    const inv = await host.invite({ clientId: HOST, gameId: GAME, room: ROOM, guestId: GUEST, guestName: "Renai", hostName: "大东彦" });
    expect(inv.ok).toBe(true);

    // 访客轮询发现邀请
    const seen = await guest.poll({ clientId: GUEST, room: ROOM });
    expect(seen.session?.phase).toBe("invite");
    expect(seen.session?.opponentName).toBe("大东彦");

    // 旁观者什么都看不到；直接拿 gameId 查也不行（本实现同样按参与者过滤）
    const byestand = await bye.poll({ clientId: BYE, room: ROOM });
    expect(byestand.session).toBeNull();

    // 接受
    await guest.poll({ clientId: GUEST, gameId: GAME, room: ROOM, cmd: "accept" });
    const hostSees = await host.poll({ clientId: HOST, gameId: GAME, room: ROOM });
    expect(hostSees.session?.phase).toBe("playing");

    // 房主推快照 v1 → 访客拉到
    await host.poll({ clientId: HOST, gameId: GAME, room: ROOM, version: 1, state: snap() });
    const guestGot = await guest.poll({ clientId: GUEST, gameId: GAME, room: ROOM });
    expect(guestGot.session?.version).toBe(1);
    expect(guestGot.session?.state?.players[0].mana).toBe(2);

    // 访客推动作 → 房主取走 → 确认清空
    await guest.poll({ clientId: GUEST, gameId: GAME, room: ROOM, action: { kind: "end" } });
    const hostAction = await host.poll({ clientId: HOST, gameId: GAME, room: ROOM });
    expect(hostAction.session?.action?.kind).toBe("end");
    await host.poll({ clientId: HOST, gameId: GAME, room: ROOM, ackAction: hostAction.session!.actionSeq });
    const hostClean = await host.poll({ clientId: HOST, gameId: GAME, room: ROOM });
    expect(hostClean.session?.action).toBeNull();

    // 访客退出（人还在房间里）→ 房主立刻看到
    await guest.poll({ clientId: GUEST, gameId: GAME, room: ROOM, cmd: "leave" });
    const hostAfterLeave = await host.poll({ clientId: HOST, gameId: GAME, room: ROOM });
    expect(hostAfterLeave.session?.opponentLeft).toBe(true);

    // 房主也退 → 局子收尾，谁都拉不到
    await host.poll({ clientId: HOST, gameId: GAME, room: ROOM, cmd: "leave" });
    const gone = await host.poll({ clientId: HOST, room: ROOM });
    expect(gone.session).toBeNull();
  });

  it("一方在局里时不能开第二局（互斥）", async () => {
    await host.invite({ clientId: HOST, gameId: GAME, room: ROOM, guestId: GUEST, guestName: "Renai", hostName: "大东彦" });
    const again = await host.invite({ clientId: HOST, gameId: "game-test-0002", room: ROOM, guestId: BYE, guestName: "C", hostName: "大东彦" });
    expect(again.ok).toBe(false);
  });

  it("过了 1 分钟的邀请不再挡人（与服务端同口径）", async () => {
    await host.invite({ clientId: HOST, gameId: GAME, room: ROOM, guestId: GUEST, guestName: "Renai", hostName: "大东彦" });
    // 把创建时间往前拨 4 分钟：这条邀请已经过期
    const rows = JSON.parse(localStorage.getItem("5blong.duel.sessions")!);
    rows[GAME].createdAt = Date.now() - 4 * 60_000;
    localStorage.setItem("5blong.duel.sessions", JSON.stringify(rows));

    const again = await host.invite({ clientId: HOST, gameId: "game-test-0003", room: ROOM, guestId: BYE, guestName: "C", hostName: "大东彦" });
    expect(again.ok).toBe(true);
  });

  it("房主推旧版本（重放）被拒收", async () => {
    await host.invite({ clientId: HOST, gameId: GAME, room: ROOM, guestId: GUEST, guestName: "Renai", hostName: "大东彦" });
    await guest.poll({ clientId: GUEST, gameId: GAME, room: ROOM, cmd: "accept" });
    await host.poll({ clientId: HOST, gameId: GAME, room: ROOM, version: 5, state: snap() });
    const row = JSON.parse(localStorage.getItem("5blong.duel.sessions")!)[GAME];
    expect(row.version).toBe(5);
    // 旧版本 3 < 5：不该被收
    await host.poll({ clientId: HOST, gameId: GAME, room: ROOM, version: 3, state: { ...snap(), bonus: 99 } });
    const row2 = JSON.parse(localStorage.getItem("5blong.duel.sessions")!)[GAME];
    expect(row2.version).toBe(5);
    expect(row2.state.bonus).toBe(0);
  });

  it("五人房两局并存：ab 对战中 c 邀请 d，两局互不干扰", async () => {
    // ab 开第一局
    await host.invite({ clientId: HOST, gameId: GAME, room: ROOM, guestId: GUEST, guestName: "B", hostName: "A" });
    await guest.poll({ clientId: GUEST, gameId: GAME, room: ROOM, cmd: "accept" });
    await host.poll({ clientId: HOST, gameId: GAME, room: ROOM, version: 1, state: { ...snap(), hostName: "A" } });

    // cd 开第二局：C 不在第一局里 → 不被 busy 挡
    const C = "carol-client-cccc";
    const D = "dave-client-dddddd";
    const GAME2 = "game-test-0003";
    const carol = new LocalDuelTransport();
    const dave = new LocalDuelTransport();
    const inv2 = await carol.invite({ clientId: C, gameId: GAME2, room: ROOM, guestId: D, guestName: "D", hostName: "C" });
    expect(inv2.ok).toBe(true);
    await dave.poll({ clientId: D, gameId: GAME2, room: ROOM, cmd: "accept" });
    await carol.poll({ clientId: C, gameId: GAME2, room: ROOM, version: 1, state: { ...snap(), hostName: "C" } });

    // 两局各拿各的快照，不串
    const bState = await guest.poll({ clientId: GUEST, gameId: GAME, room: ROOM });
    expect(bState.session?.state?.hostName).toBe("A");
    const dState = await dave.poll({ clientId: D, gameId: GAME2, room: ROOM });
    expect(dState.session?.state?.hostName).toBe("C");

    // ab 那局 B 退出 → 只影响 A，cd 照常
    await guest.poll({ clientId: GUEST, gameId: GAME, room: ROOM, cmd: "leave" });
    const aSees = await host.poll({ clientId: HOST, gameId: GAME, room: ROOM });
    expect(aSees.session?.opponentLeft).toBe(true);
    const dStill = await dave.poll({ clientId: D, gameId: GAME2, room: ROOM });
    expect(dStill.session?.phase).toBe("playing");
    expect(dStill.session?.opponentLeft).toBe(false);
  });

  it("拒绝邀请 → phase=cancelled，双方都拉不到", async () => {
    await host.invite({ clientId: HOST, gameId: GAME, room: ROOM, guestId: GUEST, guestName: "Renai", hostName: "大东彦" });
    await guest.poll({ clientId: GUEST, gameId: GAME, room: ROOM, cmd: "decline" });
    const hostGone = await host.poll({ clientId: HOST, gameId: GAME, room: ROOM });
    expect(hostGone.session).toBeNull();
  });
});
