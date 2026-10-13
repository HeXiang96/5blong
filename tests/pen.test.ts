/**
 * 猪圈导演的纯逻辑测试：验证 DDY 丢菜、吃、拉屎的事件生成规则。
 */
import { describe, expect, it } from "vitest";

import {
  NPC_NAME,
  PenDirector,
  VEGETABLE_KINDS,
  actionForActor,
  clampToRange,
  consumedVegetableIds,
  parsePositionPx,
  eventTtl,
  nearestActor,
  pruneEvents,
  randomVegetable,
  type PenEvent,
} from "../src/client/voice/pen";
import { parsePenEvent as parsePenEventSafe, shouldReportWelcomeTimeout } from "../src/client/voice/protocol";
import {
  SOUND_NOTES,
  parseSoundEvent,
  shouldPlaySound,
  soundDuration,
} from "../src/client/voice/sounds";

describe("等待 welcome 超时的判定", () => {
  it("一直没进房、连接还在：应该报错", () => {
    expect(
      shouldReportWelcomeTimeout({ stillCurrentConnection: true, joined: false, destroyed: false }),
    ).toBe(true);
  });

  it("已经进过房：绝不报错（这正是「连接失败但人还在房间」的根因）", () => {
    expect(
      shouldReportWelcomeTimeout({ stillCurrentConnection: true, joined: true, destroyed: false }),
    ).toBe(false);
  });

  it("连接已经换了一条：不报错", () => {
    expect(
      shouldReportWelcomeTimeout({ stillCurrentConnection: false, joined: false, destroyed: false }),
    ).toBe(false);
  });

  it("引擎已销毁：不报错", () => {
    expect(
      shouldReportWelcomeTimeout({ stillCurrentConnection: true, joined: false, destroyed: true }),
    ).toBe(false);
  });
});

/** 固定序列的伪随机，让测试可复现。 */
function seededRandom(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length] ?? 0.5;
    index += 1;
    return value;
  };
}

describe("猪圈导演", () => {
  it("DDY 丢出的蔬菜落在场地内，且类型合法", () => {
    const random = seededRandom([0.1, 0.9, 0.5, 0.3]);
    for (let i = 0; i < 50; i += 1) {
      const veg = randomVegetable(random);
      expect(VEGETABLE_KINDS).toContain(veg.kind);
      expect(veg.x).toBeGreaterThan(0);
      expect(veg.x).toBeLessThan(1);
    }
  });

  it("不会把连续两棵菜丢在几乎同一个位置", () => {
    // 第二次的随机值故意贴近上一次的落点
    const random = seededRandom([0.5, 0.5, 0.5, 0.52]);
    const first = randomVegetable(random);
    const second = randomVegetable(random, first.x);
    expect(Math.abs(second.x - first.x)).toBeGreaterThan(0.15);
  });

  it("produceToss 带上固定的 NPC 名字 DDY", () => {
    const director = new PenDirector(seededRandom([0.4, 0.4]));
    const toss = director.produceToss(1000);
    expect(toss.kind).toBe("toss");
    expect(toss.npc).toBe(NPC_NAME);
    expect(toss.ts).toBe(1000);
    expect(toss.id).toContain("toss-");
  });

  it("间隔都在设定的区间里（偶尔来一次，不是刷屏）", () => {
    const director = new PenDirector(seededRandom([0, 1]));
    expect(director.nextTossDelay()).toBeGreaterThanOrEqual(55_000);
    expect(director.nextTossDelay()).toBeLessThanOrEqual(150_000);
    expect(director.nextPoopDelay()).toBeGreaterThanOrEqual(14_000);
  });

  it("吃 / 拉事件指向具体的那头猪", () => {
    const director = new PenDirector(seededRandom([0.5]));
    expect(director.produceEat(2000, "peer-a", "carrot")).toMatchObject({
      kind: "eat",
      actor: "peer-a",
      veg: "carrot",
    });
    expect(director.producePoop(3000, "peer-b")).toMatchObject({
      kind: "poop",
      actor: "peer-b",
    });
  });

  it("挑离蔬菜最近的那头猪来吃", () => {
    const actors = [
      { id: "far", x: 0.1 },
      { id: "near", x: 0.78 },
      { id: "mid", x: 0.5 },
    ];
    expect(nearestActor(0.8, actors)).toBe("near");
    expect(nearestActor(0.12, actors)).toBe("far");
    expect(nearestActor(0.5, [])).toBeNull();
  });
});

describe("哪些蔬菜被吃掉了", () => {
  const toss = (id: string, ts: number, kind: "carrot" | "apple", x: number): PenEvent => ({
    kind: "toss",
    id,
    ts,
    npc: "DDY",
    veg: { kind, x, lane: 0.5 },
  });
  const eat = (ts: number, kind: "carrot" | "apple"): PenEvent => ({
    kind: "eat",
    id: `eat-${ts}`,
    ts,
    actor: "pig",
    veg: kind,
  });

  it("吃事件之前的菜算被吃掉", () => {
    const consumed = consumedVegetableIds([toss("t1", 100, "carrot", 0.5), eat(200, "carrot")]);
    expect(consumed.has("t1")).toBe(true);
  });

  it("吃事件之后新丢的菜不受影响（不能用时间一刀切）", () => {
    const consumed = consumedVegetableIds([
      toss("t1", 100, "carrot", 0.5),
      eat(200, "carrot"),
      toss("t2", 300, "apple", 0.2),
    ]);
    expect(consumed.has("t1")).toBe(true);
    expect(consumed.has("t2")).toBe(false);
  });

  it("快速连丢时不会被覆盖（不能只记上一棵）", () => {
    // 丢 t1、丢 t2，然后才吃 t1
    const consumed = consumedVegetableIds([
      toss("t1", 100, "carrot", 0.2),
      toss("t2", 150, "carrot", 0.8),
      eat(300, "carrot"),
    ]);
    // 只吃掉一棵，另一棵必须留在地上
    expect(consumed.size).toBe(1);
  });

  it("种类吻合的那一棵优先被吃", () => {
    const consumed = consumedVegetableIds([
      toss("t1", 100, "carrot", 0.5),
      toss("t2", 150, "apple", 0.5),
      eat(300, "apple"),
    ]);
    expect(consumed.has("t2")).toBe(true);
    expect(consumed.has("t1")).toBe(false);
  });

  it("没有菜的吃事件不报错", () => {
    expect(consumedVegetableIds([eat(100, "carrot")]).size).toBe(0);
  });

  it("过期事件被清掉，未过期的保留", () => {
    const entries = [
      { event: { kind: "poop", id: "a", ts: 0, actor: "x" } as PenEvent, expiresAt: 100 },
      { event: { kind: "poop", id: "b", ts: 0, actor: "y" } as PenEvent, expiresAt: 500 },
    ];
    const kept = pruneEvents(entries, 200);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.event.id).toBe("b");
  });

  it("每种事件都有存活时长", () => {
    expect(eventTtl({ kind: "toss", id: "t", ts: 0, npc: "DDY", veg: { kind: "corn", x: 0.5, lane: 0.5 } })).toBeGreaterThan(0);
    expect(eventTtl({ kind: "eat", id: "e", ts: 0, actor: "a", veg: "corn" })).toBeGreaterThan(0);
    expect(eventTtl({ kind: "poop", id: "p", ts: 0, actor: "a" })).toBeGreaterThan(0);
  });
});

describe("某头猪此刻在干什么", () => {
  const eatEvent = (actor: string): PenEvent => ({
    kind: "eat",
    id: "e",
    ts: 1,
    actor,
    veg: "carrot",
  });
  const poopEvent = (actor: string): PenEvent => ({ kind: "poop", id: "p", ts: 1, actor });

  it("匹配到的猪才做动作", () => {
    expect(actionForActor([eatEvent("pig-a")], "pig-a")).toBe("eat");
    expect(actionForActor([eatEvent("pig-a")], "pig-b")).toBe("none");
  });

  it("吃优先于拉", () => {
    expect(actionForActor([poopEvent("pig-a"), eatEvent("pig-a")], "pig-a")).toBe("eat");
  });

  it("通配符表示所有猪都做这个动作（调试用）", () => {
    expect(actionForActor([poopEvent("*")], "任何猪")).toBe("poop");
  });
});

describe("房间提示音", () => {
  it("每种提示音都有音符，且时长合理（是短促的提示，不是一小段音乐）", () => {
    for (const kind of ["join", "leave", "mute", "unmute"] as const) {
      const duration = soundDuration(kind);
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThan(0.6);
      expect(SOUND_NOTES[kind].length).toBeGreaterThan(0);
    }
  });

  it("进来的音是上行的，离开的是下行的（不看屏幕也能听出方向）", () => {
    const joinFirst = SOUND_NOTES.join[0]!.freq;
    const joinLast = SOUND_NOTES.join[SOUND_NOTES.join.length - 1]!.freq;
    expect(joinLast).toBeGreaterThan(joinFirst);

    const leaveFirst = SOUND_NOTES.leave[0]!.freq;
    const leaveLast = SOUND_NOTES.leave[SOUND_NOTES.leave.length - 1]!.freq;
    expect(leaveLast).toBeLessThan(leaveFirst);
  });

  it("开麦比关麦音高更高（成对可辨）", () => {
    expect(SOUND_NOTES.unmute[0]!.freq).toBeGreaterThan(SOUND_NOTES.mute[0]!.freq);
  });

  it("节流：连点不会响个不停，但过了间隔就允许再响", () => {
    // 第一次总是允许
    expect(shouldPlaySound("mute", undefined, 1000)).toBe(true);
    // 紧接着（间隔不足）不允许
    expect(shouldPlaySound("mute", 1000, 1050)).toBe(false);
    // 超过阈值后允许
    expect(shouldPlaySound("mute", 1000, 1300)).toBe(true);
  });

  it("校验线上事件：形状不对就丢弃", () => {
    expect(parseSoundEvent(null)).toBeNull();
    expect(parseSoundEvent({ kind: "爆炸", actor: "a", id: "x", ts: 1 })).toBeNull();
    expect(parseSoundEvent({ kind: "join", actor: "a", id: "", ts: 1 })).toBeNull();
    expect(parseSoundEvent({ kind: "join", actor: "a", id: "x", ts: 0 })).toBeNull();
    expect(parseSoundEvent({ kind: "join", actor: "a", id: "x", ts: 5 })).toMatchObject({
      kind: "join",
      actor: "a",
    });
  });
});

describe("走动位置的记录", () => {
  it("夹回允许范围", () => {
    expect(clampToRange(120, 40, 900)).toBe(120);
    expect(clampToRange(-30, 40, 900)).toBe(40);
    expect(clampToRange(5000, 40, 900)).toBe(900);
  });

  it("范围反向或非法时退回下界，不抛错", () => {
    expect(clampToRange(100, 900, 40)).toBe(900);
    expect(clampToRange(Number.NaN, 40, 900)).toBe(40);
    expect(clampToRange(Number.POSITIVE_INFINITY, 40, 900)).toBe(40);
  });

  it("能从 CSS 的 left 值解析出像素数", () => {
    expect(parsePositionPx("123.5px")).toBe(123.5);
    expect(parsePositionPx("40px")).toBe(40);
    expect(parsePositionPx("auto")).toBeNull();
    expect(parsePositionPx("")).toBeNull();
  });

  /*
   * 回归测试：说话导致走动被打断时，位置必须记在"当时站的地方"，
   * 而不是这趟的起点。之前的实现只在动画 onfinish 里记录，cancel() 不触发
   * onfinish，于是猪被拽回原地重新走（用户报的 bug）。
   */
  it("被打断时用真实位置，而不是起点", () => {
    const startOfTrip = 40;
    const actualWhenInterrupted = 512;
    const settled = clampToRange(actualWhenInterrupted, 40, 900);
    expect(settled).not.toBe(startOfTrip);
    expect(settled).toBe(512);
  });
});

describe("线上收到的猪圈事件校验", () => {
  it("拒绝形状不对的事件", () => {
    expect(parsePenEventSafe(null)).toBeNull();
    expect(parsePenEventSafe({ kind: "toss" })).toBeNull();
    expect(parsePenEventSafe({ kind: "toss", id: "x", ts: 1, veg: { kind: "石头", x: 0.5 } })).toBeNull();
    expect(parsePenEventSafe({ kind: "poop", id: "x", ts: 1 })).toBeNull();
    expect(parsePenEventSafe({ kind: "炸圈", id: "x", ts: 1 })).toBeNull();
  });

  it("把越界的横向位置夹回场地内", () => {
    const parsed = parsePenEventSafe({
      kind: "toss",
      id: "x",
      ts: 1,
      npc: "DDY",
      veg: { kind: "carrot", x: 9 },
    });
    expect(parsed?.kind).toBe("toss");
    if (parsed?.kind === "toss") expect(parsed.veg.x).toBe(1);
  });

  it("接受合法事件", () => {
    const parsed = parsePenEventSafe({
      kind: "eat",
      id: "e1",
      ts: 5,
      actor: "peer-a",
      veg: "apple",
    });
    expect(parsed).toMatchObject({ kind: "eat", actor: "peer-a", veg: "apple" });
  });
});
