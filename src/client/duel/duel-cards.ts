/**
 * 梗王对局 · 卡牌数据
 *
 * 数值口径与独立演示版一致：1 费≈2 伤 / 2 费≈3 伤 / 4 费≈5 伤 /
 * 5 费 AoE≈3 伤 / 6 费≈8 伤终结；两套牌各 14 张，按同一预算配平：
 *   大东彦 = 高爆发、随从少；Renai = 续航、解场、抽牌。
 *
 * 全部为 [PLACEHOLDER]，等实战数据再调（见 docs/DUEL-IN-ROOM-PLAN.md）。
 */

export type TypeKey = "pig" | "aim" | "power" | "drama" | "hot" | "show" | "gun";
export type RarityKey = "n" | "r" | "sr" | "ssr" | "ur";
export type TargetKind = "none" | "enemy" | "enemyMinion" | "friendlyMinion" | "anyMinion" | "any";
export type Side = 0 | 1;

export interface Player {
  idx: Side;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  deck: string[];
  hand: string[];
  board: Minion[];
  fatigue: number;
  heroPowerUsed: boolean;
  spellBonus: number;
  manaPenalty: number;
}

export interface Minion {
  uid: number;
  id: string;
  name: string;
  icon: string;
  atk: number;
  baseAtk: number;
  hp: number;
  maxHp: number;
  taunt: boolean;
  owner: Side;
  canAttack: boolean;
  frozen: boolean;
}

export type Target = { type: "hero"; side: Side } | { type: "minion"; uid: number };

export interface DuelCard {
  name: string;
  cost: number;
  kind: "spell" | "minion";
  t: TypeKey;
  r: RarityKey;
  target?: TargetKind;
  txt: string;
  /** 一句梗味出处，悬停详情里用 */
  f?: string;
  /** 直接伤害（AI 算斩杀用） */
  dmg?: number;
  atk?: number;
  hp?: number;
  taunt?: boolean;
  icon?: string;
  cast?: (g: any, p: Player, t?: Target) => void;
  battlecry?: (g: any, p: Player, m: Minion) => void;
}

export const TYPE_TXT: Record<TypeKey, string> = {
  pig: "猪系", aim: "瞄准系", power: "权限系", drama: "宫斗系", hot: "暴论系", show: "整活系", gun: "枪男系",
};
export const RARITY_TXT: Record<RarityKey, string> = { n: "N", r: "R", sr: "SR", ssr: "SSR", ur: "UR" };
export const RARITY_COLOR: Record<RarityKey, string> = {
  n: "#a08d72", r: "#4a9fd0", sr: "#8f6ad8", ssr: "#c99a12", ur: "#cf4d63",
};
export const TYPE_COLOR: Record<TypeKey, string> = {
  pig: "#ef7fa6", aim: "#5aa6e8", power: "#9a7ce8", drama: "#5ec98a", hot: "#ee9a4d", show: "#e0b83c", gun: "#45c3d0",
};

export const CARD_DB: Record<string, DuelCard> = {
  /* ---------------- 大东彦 ---------------- */
  d1: { name: "打不中下包的！", cost: 1, kind: "spell", t: "aim", r: "r", target: "enemy", dmg: 2,
    txt: "造成 2 点伤害。", f: "马枪是技术，甩锅是艺术。",
    cast: (g, p, t) => g.dealDamage(t, 2, p) },
  d2: { name: "是子弹飘了", cost: 2, kind: "spell", t: "aim", r: "ssr", target: "enemy", dmg: 3,
    txt: "造成 3 点伤害。", f: "兄弟我真瞄得很准，是子弹的问题。",
    cast: (g, p, t) => g.dealDamage(t, 3, p) },
  d3: { name: "瞄准教父", cost: 1, kind: "spell", t: "aim", r: "ur", target: "friendlyMinion",
    txt: "使一个友方随从<br>获得 +2 攻击力。", f: "暂停不教战术，只教换准心。",
    cast: (g, _p, t) => { const m = g.minion(t); if (m) m.atk += 2 } },
  d4: { name: "我是你们加起来的两倍", cost: 3, kind: "spell", t: "aim", r: "ssr", target: "enemy", dmg: 2,
    txt: "造成 2 点伤害。<br>场上共有 2 个随从时改为 5 点。", f: "说完这句，KMD 已经在笑了。",
    cast: (g, p, t) => {
      const total = p.board.length + g.opp(p).board.length;
      g.dealDamage(t, total >= 2 ? 5 : 2, p);
    } },
  d5: { name: "权限上分", cost: 3, kind: "spell", t: "power", r: "ssr", target: "enemyMinion",
    txt: "封号：一个敌方随从<br>下回合不能攻击。", f: "只要有外挂，这把就不该结算。",
    cast: (g, _p, t) => { const m = g.minion(t); if (m) m.frozen = true } },
  d6: { name: "愤怒喵！愤怒喵！", cost: 3, kind: "spell", t: "pig", r: "ur", target: "enemy", dmg: 3,
    txt: "造成 3 点伤害。<br>下张技能牌 +2 伤害。", f: "猪瘟启动，队友开始戴耳机。",
    cast: (g, p, t) => { g.dealDamage(t, 3, p); p.spellBonus += 2 } },
  d7: { name: "十字准心五杀地狱归来", cost: 4, kind: "spell", t: "aim", r: "r", target: "enemy", dmg: 5,
    txt: "造成 5 点伤害。<br>击杀随从则抽 1 张。", f: "状态不好？换准心就完事。",
    cast: (g, p, t) => { if (g.dealDamage(t, 5, p)) g.draw(p, 1) } },
  d8: { name: "猪瘟红温狂叫一整局", cost: 5, kind: "spell", t: "pig", r: "ssr", target: "none",
    txt: "对所有敌方随从<br>造成 3 点伤害。", f: "七分钟一次，一次看个爽。",
    cast: (g, p) => { g.opp(p).board.slice().forEach((m: Minion) => g.dealDamage({ type: "minion", uid: m.uid }, 3, p)) } },
  d9: { name: "连杀笨奶21条命", cost: 6, kind: "spell", t: "pig", r: "ssr", target: "enemy", dmg: 8,
    txt: "造成 8 点伤害。", f: "渔力全开，最后彦哥喊了爹。",
    cast: (g, p, t) => g.dealDamage(t, 8, p) },
  d10: { name: "哈哈，那无敌了", cost: 2, kind: "spell", t: "show", r: "ur", target: "none",
    txt: "恢复 5 点生命。", f: "万能回复：可攻可守可摆烂。",
    cast: (g, p) => g.heal(p, 5) },
  d11: { name: "奶妈yuko", cost: 2, kind: "minion", t: "show", r: "sr", atk: 1, hp: 4, taunt: true, icon: "🥛",
    txt: "嘲讽（1/4）", f: "yu 大姐发一把，不给就喊妈妈。" },
  d12: { name: "KMD", cost: 3, kind: "minion", t: "gun", r: "sr", atk: 3, hp: 2, icon: "🎧",
    txt: "战吼：造成 1 点伤害。", f: "养猪 man，负责带飞和预言。",
    battlecry: (g, p) => g.randomHit(p, 1) },
  d13: { name: "伊森", cost: 4, kind: "minion", t: "drama", r: "sr", atk: 2, hp: 6, taunt: true, icon: "🛡",
    txt: "嘲讽（2/6）", f: "宫斗杯更衣室唯一正常人。" },
  d14: { name: "康康", cost: 5, kind: "minion", t: "gun", r: "ur", atk: 4, hp: 4, icon: "🎯",
    txt: "战吼：造成 2 点伤害。", f: "没人忍得住边吃晚饭边看他直播。",
    battlecry: (g, p) => g.randomHit(p, 2) },

  /* ---------------- Renai ---------------- */
  r1: { name: "你在干嘛！跟个锁似得！", cost: 2, kind: "spell", t: "gun", r: "ssr", target: "enemy", dmg: 3,
    txt: "造成 3 点伤害。", f: "枪男最高级别的赞美，就一个字：锁。",
    cast: (g, p, t) => g.dealDamage(t, 3, p) },
  r2: { name: "单排杀太多被封号", cost: 5, kind: "spell", t: "gun", r: "r", target: "enemy", dmg: 7,
    txt: "造成 7 点伤害。<br>自己受到 2 点伤害。", f: "太强，也是一种错。",
    cast: (g, p, t) => { g.dealDamage(t, 7, p); g.dealDamage({ type: "hero", side: p.idx }, 2, null) } },
  r3: { name: "我想举手都得叫主人", cost: 3, kind: "spell", t: "power", r: "ssr", target: "enemyMinion",
    txt: "沉默一个随从，<br>然后抽一张牌。", f: "权限对照组，懂的都懂。",
    cast: (g, p, t) => { const m = g.minion(t); if (m) { m.taunt = false; m.atk = Math.min(m.atk, m.baseAtk) } g.draw(p, 1) } },
  r4: { name: "劝降感言 + 投降", cost: 4, kind: "spell", t: "gun", r: "sr", target: "none",
    txt: "对手下回合<br>法力水晶 -2。", f: "先发表感言，再点投降，斯凯一票否决。",
    cast: (g, p) => { g.opp(p).manaPenalty += 2 } },
  r5: { name: "你们送太多隐藏分低", cost: 3, kind: "spell", t: "drama", r: "sr", target: "none",
    txt: "敌方所有随从<br>攻击力 -1。", f: "道理都对，可惜对面是演员。",
    cast: (g, p) => { g.opp(p).board.forEach((m: Minion) => { m.atk = Math.max(0, m.atk - 1) }) } },
  r6: { name: "以前打职业8人一间房", cost: 3, kind: "spell", t: "hot", r: "r", target: "none",
    txt: "恢复 6 点生命。", f: "上铺的袜子掉我床上，真的很难受。",
    cast: (g, p) => g.heal(p, 6) },
  r7: { name: "奶神转会传闻", cost: 3, kind: "spell", t: "drama", r: "sr", target: "none",
    txt: "抽 2 张牌。", f: "下一站是哪儿？兄弟们先别问。",
    cast: (g, p) => g.draw(p, 2) },
  r8: { name: "22年互认为对方是傻呗", cost: 1, kind: "spell", t: "drama", r: "sr", target: "none",
    txt: "双方英雄<br>各受 3 点伤害。", f: "从对线到兄弟。",
    cast: (g, p) => { g.dealDamage({ type: "hero", side: g.opp(p).idx }, 3, p); g.dealDamage({ type: "hero", side: p.idx }, 3, null) } },
  r9: { name: "打完比赛快要玉玉", cost: 2, kind: "spell", t: "pig", r: "sr", target: "none",
    txt: "恢复 3 点生命，<br>抽 1 张牌。", f: "更衣室气氛组上线。",
    cast: (g, p) => { g.heal(p, 3); g.draw(p, 1) } },
  r10: { name: "忍辱负重拿下彦处", cost: 6, kind: "spell", t: "gun", r: "sr", target: "enemy", dmg: 6,
    txt: "造成 6 点伤害，<br>回复 3 点生命。", f: "先忍，后杀。",
    cast: (g, p, t) => { g.dealDamage(t, 6, p); g.heal(p, 3) } },
  r11: { name: "喊妈妈（对yuko）", cost: 1, kind: "spell", t: "show", r: "sr", target: "friendlyMinion",
    txt: "使一个友方随从<br>获得 +1/+2。", f: "为了把枪，脸可以不要。",
    cast: (g, _p, t) => { const m = g.minion(t); if (m) { m.atk += 1; m.hp += 2; m.maxHp += 2 } } },
  r12: { name: "勾檀", cost: 2, kind: "minion", t: "show", r: "sr", atk: 2, hp: 2, icon: "🍳",
    txt: "战吼：抽一张牌。", f: "1 辞 = 6 蛋，性价比之神。",
    battlecry: (g, p) => g.draw(p, 1) },
  r13: { name: "龟龟", cost: 3, kind: "minion", t: "drama", r: "sr", atk: 2, hp: 4, taunt: true, icon: "🐢",
    txt: "嘲讽（2/4）", f: "真选手，看不下去教练组整活。" },
  r14: { name: "babyblue", cost: 4, kind: "minion", t: "show", r: "ssr", atk: 3, hp: 5, icon: "🧊",
    txt: "—", f: "东彦哥哥？叫我爸爸。" },
};

export const DECKS: Record<Side, string[]> = {
  0: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10", "d11", "d12", "d13", "d14"],
  1: ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12", "r13", "r14"],
};

export const HERO_META = [
  { name: "我", icon: "🐷" },
  { name: "对手", icon: "🐷" },
];

export interface HeroPower {
  name: string;
  cost: number;
  txt: string;
  /** 效果跟人走：大东彦回血，Renai 点一手。写在数据里，引擎不认识具体技能。 */
  exec?: (
    g: {
      dealDamage(t: Target | undefined, n: number, src?: Player | null): boolean;
      heal(p: Player, n: number): void;
    },
    p: Player,
  ) => void;
}

export const HERO_POWERS: HeroPower[] = [
  { name: "那无敌了", cost: 2, txt: "回复 2 点生命", exec: (g, p) => g.heal(p, 2) },
  {
    name: "跟个锁似得",
    cost: 2,
    txt: "对敌方英雄 1 点伤害",
    exec: (g, p) => g.dealDamage({ type: "hero", side: (1 - p.idx) as 0 | 1 }, 1),
  },
];
