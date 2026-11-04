import { describe, expect, it } from "vitest";
import { DuelGame } from "../src/client/duel/duel-engine";

/**
 * 梗王对局的规则单测。
 * 只测「有明确预期、踩过坑」的规则，不做全量穷举：
 * 1) 我是你们加起来的两倍 —— 曾把条件写成"只看自己随从"，导致对面两只怪也只打 2 点；
 * 2) 嘲讽 —— 有嘲讽随从时不能直接打脸；
 * 3) 疲劳 —— 牌库空了每抽一次递增掉血；
 * 4) 法力 —— 费用不够出不了牌。
 */

function fresh(): DuelGame {
  const g = new DuelGame("测试员");
  g.players[0].maxMana = 10;
  g.players[0].mana = 10;
  g.players[1].maxMana = 10;
  g.players[1].mana = 10;
  return g;
}

describe("梗王对局 · 规则", () => {
  it("我是你们加起来的两倍：场上合计 ≥2 个随从时打 5 点", () => {
    const g = fresh();
    g.players[0].hand = ["d4"];
    g.summon(g.players[1], "r13"); // 对面 2 个随从
    g.summon(g.players[1], "r12");
    const before = g.players[1].hp;
    g.playCard(0, { type: "hero", side: 1 });
    expect(before - g.players[1].hp).toBe(5);
  });

  it("我是你们加起来的两倍：场上只有 1 个随从时打 2 点", () => {
    const g = fresh();
    g.players[0].hand = ["d4"];
    g.summon(g.players[1], "r13");
    const before = g.players[1].hp;
    g.playCard(0, { type: "hero", side: 1 });
    expect(before - g.players[1].hp).toBe(2);
  });

  it("有嘲讽随从时不能直接攻击英雄", () => {
    const g = fresh();
    g.summon(g.players[1], "r13"); // 龟龟，嘲讽
    g.summon(g.players[0], "d12"); // KMD 3/2
    const mine = g.players[0].board[0];
    mine.canAttack = true;
    const before = g.players[1].hp;
    const ok = g.attack(mine.uid, { type: "hero", side: 1 });
    expect(ok).toBe(false);
    expect(g.players[1].hp).toBe(before);
  });

  it("牌库抽空后进入疲劳，每次多掉 1 点", () => {
    const g = fresh();
    const me = g.players[0];
    me.deck = [];
    const before = me.hp;
    g.draw(me, 1); // 疲劳 1
    g.draw(me, 1); // 疲劳 2
    expect(before - me.hp).toBe(3);
  });

  it("法力不足时出不了牌", () => {
    const g = fresh();
    g.players[0].hand = ["d9"]; // 6 费
    g.players[0].mana = 3;
    expect(g.playCard(0, { type: "hero", side: 1 })).toBe(false);
    expect(g.players[0].hand.length).toBe(1);
  });
});
