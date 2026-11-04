/**
 * 梗王对局 · 规则引擎（纯 TS，不碰 DOM）
 *
 * 设计约束：
 * - 房主权威：正式版里房主跑这份引擎，访客只发「意图」；本地演示版两边都在本机跑。
 * - 一切随机只发生在发牌，且由调用方决定是否共享种子（正式版用 seed 同步）。
 * - 引擎不读 window / document，方便单测与后续搬到 Worker。
 */
import {
  CARD_DB, DECKS, HERO_POWERS,
  type Minion, type Player, type Side, type Target, type TargetKind,
} from "./duel-cards";

export const MAX_HP = 30;
export const HAND_MAX = 8;
export const BOARD_MAX = 5;
export const MANA_MAX = 10;

export interface LogLine { text: string; cls?: "dmg" | "sys" | "heal" }

/** 访客发给房主的动作意图。target 的 side 一律是**引擎视角**（0=房主）。 */
export type DuelAction =
  | { kind: "play"; handIdx: number; target?: Target }
  | { kind: "attack"; uid: number; target: Target }
  | { kind: "power" }
  | { kind: "end" };

/**
 * 快照结构版本。**改了 DuelSnapshot 的字段结构就必须 +1**：
 * restore 遇到版本不符会拒收（宁可让访客看到「版本不一致」，
 * 也不能拿旧结构硬套新引擎渲染出鬼状态）。
 */
export const DUEL_SCHEMA_VERSION = 1;

/** 引擎的可序列化全量状态：房主每次变化拍一份发给访客。 */
export interface DuelSnapshot {
  schemaVersion: number;
  players: [Player, Player];
  cur: Side;
  over: boolean;
  busy: boolean;
  pending: DuelGame["pending"];
  logs: LogLine[];
  uidSeq: number;
  bonus: number;
  mySide: Side;
  hostName: string;
  opponentName: string;
}

const shuffle = <T,>(arr: T[]): T[] => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

function makePlayer(idx: Side): Player {
  return {
    idx, hp: MAX_HP, maxHp: MAX_HP, mana: 0, maxMana: 0,
    deck: shuffle(DECKS[idx].slice()), hand: [], board: [],
    fatigue: 0, heroPowerUsed: false, spellBonus: 0, manaPenalty: 0,
  };
}

export class DuelGame {
  players: [Player, Player] = [makePlayer(0), makePlayer(1)];
  cur: Side = 0;
  over = false;
  busy = false;
  pending: { type: "card"; idx: number } | { type: "attack"; uid: number } | null = null;
  logs: LogLine[] = [];
  uidSeq = 1;
  bonus = 0;
  /** 对手名字（来自成员卡） */
  opponentName: string;
  /**
   * 房主名字。日志里写**绝对名字**而不是「你」：快照在房主端生成，
   * 访客看到的「你」如果指房主自己就错位了。
   */
  hostName = "房主";
  /**
   * 本端视角：房主 0、访客 1。
   * 房主跑引擎执行动作；访客的引擎实例只是快照容器，用它渲染、判断
   * canPlay / isTargetable（全部自动按视角翻转），动作一律通过 DuelAction 发回房主。
   */
  mySide: Side = 0;
  onChange: () => void = () => {};

  constructor(opponentName = "对手") {
    this.opponentName = opponentName;
  }

  /** 绝对名字：side 0 = 房主，side 1 = 访客。 */
  nameOf(side: Side): string {
    return side === 0 ? this.hostName : this.opponentName;
  }

  /* ---------------- 快照 ---------------- */
  snapshot(): DuelSnapshot {
    return JSON.parse(
      JSON.stringify({
        schemaVersion: DUEL_SCHEMA_VERSION,
        players: this.players,
        cur: this.cur,
        over: this.over,
        busy: this.busy,
        pending: null,
        logs: this.logs,
        uidSeq: this.uidSeq,
        bonus: this.bonus,
        mySide: this.mySide,
        hostName: this.hostName,
        opponentName: this.opponentName,
      }),
    );
  }

  restore(snap: DuelSnapshot): void {
    if (snap.schemaVersion !== DUEL_SCHEMA_VERSION) {
      throw new Error(`duel snapshot schema ${snap.schemaVersion} != ${DUEL_SCHEMA_VERSION}`);
    }
    this.players = snap.players;
    this.cur = snap.cur;
    this.over = snap.over;
    this.busy = snap.busy;
    this.pending = null; // 选中的牌是本端 UI 的临时状态，不随快照走
    this.logs = snap.logs;
    this.uidSeq = snap.uidSeq;
    this.bonus = snap.bonus;
    this.mySide = snap.mySide;
    this.hostName = snap.hostName;
    this.opponentName = snap.opponentName;
    this.onChange();
  }

  /* ---------------- 基础 ---------------- */
  start() {
    this.players.forEach((p) => this.draw(p, 3));
    this.beginTurn();
  }
  me() { return this.players[this.mySide]; }
  opp(p: Player) { return this.players[(1 - p.idx) as Side]; }
  log(text: string, cls?: LogLine["cls"]) {
    this.logs.unshift({ text, cls });
    if (this.logs.length > 6) this.logs.pop();
    this.onChange();
  }
  findMinion(uid: number): Minion | null {
    for (const p of this.players) {
      const m = p.board.find((x) => x.uid === uid);
      if (m) return m;
    }
    return null;
  }
  findMinionWithSide(uid: number): { m: Minion; side: Side } | null {
    for (const p of this.players) {
      const m = p.board.find((x) => x.uid === uid);
      if (m) return { m, side: p.idx };
    }
    return null;
  }
  minion(t?: Target): Minion | null {
    if (!t || t.type !== "minion") return null;
    return this.findMinion(t.uid);
  }

  /* ---------------- 资源 ---------------- */
  draw(p: Player, n: number) {
    for (let k = 0; k < n; k++) {
      if (!p.deck.length) {
        p.fatigue += 1;
        this.heroDamage(p.idx, p.fatigue);
        this.log(`${this.nameOf(p.idx)} 牌库已空，疲劳 ${p.fatigue} 点`, "dmg");
        continue;
      }
      const id = p.deck.pop()!;
      if (p.hand.length >= HAND_MAX) continue;
      p.hand.push(id);
    }
  }

  summon(p: Player, id: string): boolean {
    const c = CARD_DB[id];
    if (p.board.length >= BOARD_MAX) return false;
    const m: Minion = {
      uid: this.uidSeq++, id, name: c.name, icon: c.icon || "🃏",
      atk: c.atk ?? 0, baseAtk: c.atk ?? 0, hp: c.hp ?? 1, maxHp: c.hp ?? 1,
      taunt: !!c.taunt, owner: p.idx, canAttack: false, frozen: false,
    };
    p.board.push(m);
    this.log(`${this.nameOf(p.idx)} 上场：${c.name}`, "sys");
    if (c.battlecry) c.battlecry(this, p, m);
    return true;
  }

  /* ---------------- 伤害 ---------------- */
  dealDamage(target: Target | undefined, n: number, _src: Player | null): boolean {
    if (!target) return false;
    let dmg = n + (this.bonus || 0);
    if (target.type === "hero") {
      this.heroDamage(target.side, dmg);
      return false;
    }
    const m = this.findMinion(target.uid);
    if (!m) return false;
    m.hp -= dmg;
    this.log(`${m.name} 受到 ${dmg} 点伤害`, "dmg");
    const killed = m.hp <= 0;
    this.cleanup();
    return killed;
  }
  heroDamage(side: Side, n: number) {
    const p = this.players[side];
    p.hp -= n;
    this.log(`${this.nameOf(side)} 掉了 ${n} 点血`, "dmg");
    this.checkEnd();
  }
  heal(p: Player, n: number) {
    const before = p.hp;
    p.hp = Math.min(p.maxHp, p.hp + n);
    this.log(`${this.nameOf(p.idx)} 回复 ${p.hp - before} 点生命`, "sys");
  }
  cleanup() {
    for (const p of this.players) {
      p.board = p.board.filter((m) => {
        if (m.hp <= 0) { this.log(`${m.name} 倒下了`, "sys"); return false; }
        return true;
      });
    }
  }
  checkEnd() {
    if (this.over) return;
    if (this.players.some((p) => p.hp <= 0)) {
      this.over = true;
      this.busy = true;
    }
  }
  randomHit(p: Player, n: number) {
    const e = this.opp(p);
    if (e.board.length) {
      const m = e.board[Math.floor(Math.random() * e.board.length)];
      this.dealDamage({ type: "minion", uid: m.uid }, n, p);
    } else {
      this.dealDamage({ type: "hero", side: e.idx }, n, p);
    }
  }

  /* ---------------- 出牌 ---------------- */
  /**
   * 现在是不是「我」的回合。
   *
   * ⚠️ 这里必须比 `mySide`，不能写死 `cur === 0`：
   * 房主机跑引擎时 mySide=0，写死 0 看起来没问题；但访客端 restore 快照后
   * 把 mySide 翻成 1，`cur === 0` 就永远为 false —— 两边同时显示"对方出牌中"，
   * 谁也点不动（2026-11-04 双窗口实测）。
   */
  isMyTurn() { return !this.over && !this.busy && this.cur === this.mySide; }

  canPlay(i: number, p: Player = this.me()): boolean {
    const c = CARD_DB[p.hand[i]];
    if (!c) return false;
    if (c.cost > p.mana) return false;
    if (c.kind === "minion" && p.board.length >= BOARD_MAX) return false;
    return true;
  }

  hasValidTarget(kind: TargetKind | undefined): boolean {
    if (!kind || kind === "none") return true;
    const p = this.me();
    const foe = this.opp(p);
    if (kind === "enemy") return true;
    if (kind === "enemyMinion") return foe.board.length > 0;
    if (kind === "friendlyMinion") return p.board.length > 0;
    if (kind === "anyMinion") return p.board.length + foe.board.length > 0;
    return true;
  }

  /**
   * pending 允许调用方传入：访客的「选中」是本地 UI 状态，不写进引擎实例
   * （引擎对访客只是快照容器）。房主不传，用引擎自己的。
   */
  isTargetable(t: Target, pending: DuelGame["pending"] = this.pending): boolean {
    if (!pending || !this.isMyTurn()) return false;
    const p = this.me();
    if (pending.type === "card") {
      const c = CARD_DB[p.hand[pending.idx]];
      if (!c || !c.target || c.target === "none") return false;
      if (t.type === "hero") return t.side !== p.idx && (c.target === "enemy" || c.target === "any");
      const info = this.findMinionWithSide(t.uid);
      if (!info) return false;
      const mine = info.side === p.idx;
      if (c.target === "enemyMinion") return !mine;
      if (c.target === "friendlyMinion") return mine;
      if (c.target === "anyMinion") return true;
      if (c.target === "enemy") return !mine;
      return false;
    }
    if (pending.type === "attack") {
      const a = this.findMinion(pending.uid);
      if (!a) return false;
      if (t.type === "hero") return t.side !== a.owner;
      const info = this.findMinionWithSide(t.uid);
      return !!info && info.side !== a.owner;
    }
    return false;
  }

  playCard(i: number, target?: Target, p: Player = this.me()): boolean {
    const id = p.hand[i];
    const c = CARD_DB[id];
    if (!c || c.cost > p.mana) return false;
    if (c.kind === "minion" && p.board.length >= BOARD_MAX) return false;

    p.mana -= c.cost;
    p.hand.splice(i, 1);

    if (c.kind === "minion") {
      this.summon(p, id);
    } else {
      this.bonus = p.spellBonus;
      p.spellBonus = 0;
      this.log(`${this.nameOf(p.idx)} 打出「${c.name}」`, "sys");
      c.cast?.(this, p, target);
      this.bonus = 0;
    }
    this.cleanup();
    this.onChange();
    return true;
  }

  attack(uid: number, target: Target): boolean {
    const found = this.findMinionWithSide(uid);
    if (!found) return false;
    const a = found.m;
    if (!a.canAttack || a.atk <= 0) return false;
    const foe = this.players[(1 - a.owner) as Side];

    if (target.type === "hero") {
      if (target.side === a.owner) return false;
      if (foe.board.some((m) => m.taunt)) return false;
      a.canAttack = false;
      this.log(`${a.name} 冲脸 ${a.atk} 点`, "dmg");
      this.heroDamage(target.side, a.atk);
    } else {
      const t = this.findMinion(target.uid);
      if (!t) return false;
      const info = this.findMinionWithSide(target.uid)!;
      if (info.side === a.owner) return false;
      if (foe.board.some((m) => m.taunt) && !t.taunt) return false;
      a.canAttack = false;
      t.hp -= a.atk;
      a.hp -= t.atk;
      this.log(`${a.name} 撞向 ${t.name}：互殴 ${a.atk}/${t.atk}`, "dmg");
    }
    this.cleanup();
    this.onChange();
    return true;
  }

  useHeroPower(p: Player = this.me()): boolean {
    const hp = HERO_POWERS[p.idx];
    if (p.heroPowerUsed || p.mana < hp.cost || this.over) return false;
    p.mana -= hp.cost;
    p.heroPowerUsed = true;
    this.bonus = 0;
    this.log(`${this.nameOf(p.idx)} 使用英雄技能「${hp.name}」`, "sys");
    hp.exec?.(this, p);
    this.onChange();
    return true;
  }

  /* ---------------- 回合 ---------------- */
  beginTurn() {
    if (this.over) return;
    const p = this.players[this.cur];
    this.pending = null;
    p.maxMana = Math.min(MANA_MAX, p.maxMana + 1);
    const m = p.maxMana - p.manaPenalty;
    p.manaPenalty = 0;
    p.mana = Math.max(0, m);
    p.heroPowerUsed = false;
    p.spellBonus = 0;
    p.board.forEach((mn) => {
      if (mn.frozen) { mn.frozen = false; mn.canAttack = false; }
      else mn.canAttack = true;
    });
    this.draw(p, 1);
    this.log(`—— ${this.nameOf(this.cur)} 的回合 ——`, "sys");
    this.onChange();
  }

  endTurn() {
    if (this.over || this.busy) return;
    this.pending = null;
    this.cur = (1 - this.cur) as Side;
    this.beginTurn();
  }

  /* ---------------- 房主执行访客意图 ---------------- */

  /**
   * 房主执行访客发来的动作。
   * 访客 UI 用的是 restore 后的引擎实例（mySide=1），它给的 target 里 side
   * 已经是引擎视角，直接执行即可，不需要换算。
   */
  applyAction(a: DuelAction): boolean {
    const p = this.players[1];
    switch (a.kind) {
      case "play":
        return this.cur === 1 && this.playCard(a.handIdx, a.target, p);
      case "attack":
        return this.cur === 1 && this.attack(a.uid, a.target);
      case "power":
        return this.cur === 1 && this.useHeroPower(p);
      case "end":
        if (this.cur !== 1 || this.over || this.busy) return false;
        this.endTurn();
        return true;
      default:
        return false;
    }
  }
}
