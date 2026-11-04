/**
 * 梗王对局 · 房间内覆盖层（host / guest 双角色）
 *
 * 数据流（docs/DUEL-NET-PLAN.md 方案 A）：
 *   host：本机跑引擎，每次变化 snapshot → bridge.registerState（轮询上传）；
 *         收到访客动作 → g.applyAction。
 *   guest：不执行引擎；收快照 → g.restore（只用于渲染与判断）；
 *          点击 → 本地 pending → bridge.pushAction 发回房主。
 *
 * 视角：引擎实例的 mySide 决定「哪边是我的」，渲染全部走它，
 * 因此同一套 JSX 不用关心自己是房主还是访客。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DuelGame, MANA_MAX, type DuelAction } from "./duel-engine";
import {
  CARD_DB, HERO_POWERS, RARITY_COLOR, RARITY_TXT, TYPE_COLOR, TYPE_TXT,
  type Minion, type Player, type Side, type Target,
} from "./duel-cards";
import type { DuelBridge, DuelSessionView } from "./duel-net";
import "./duel.css";

interface Props {
  session: DuelSessionView;
  myName: string;
  myAvatar?: string;
  foeAvatar?: string;
  bridge: DuelBridge;
  onExit: () => void;
}

interface Zone { left: number; top: number; width: number; height: number }

const bold = (text: string) => text.replace(/(\d+)/g, "<b>$1</b>");
const STEP_BY_COUNT: Record<number, number> = { 5: 90, 6: 78, 7: 66 };

type Pending = { type: "card"; idx: number } | { type: "attack"; uid: number };

export function DuelOverlay({ session, myName, myAvatar, foeAvatar, bridge, onExit }: Props) {
  const isHost = session.role === "host";
  const gameRef = useRef<DuelGame | null>(null);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [zones, setZones] = useState<{ me: Zone | null; foe: Zone | null }>({ me: null, foe: null });
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  /** 选中的牌/随从（guest 不写引擎 pending，两边统一用本地状态） */
  const [pending, setPending] = useState<Pending | null>(null);
  const [staleSchema, setStaleSchema] = useState(false);
  const appliedVersion = useRef(-1);

  if (!gameRef.current) {
    gameRef.current = new DuelGame(session.opponentName);
    gameRef.current.hostName = myName;
  }
  const g = gameRef.current;

  /* ---------- host：跑引擎；guest：收快照 ---------- */
  useEffect(() => {
    if (!isHost) return;
    g.onChange = () => {
      rerender();
      bridge.registerState(g.snapshot());
    };
    g.start(); // start 内部触发 onChange → 第一份快照立刻上路
    return () => {
      g.onChange = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost]);

  useEffect(() => {
    if (isHost) return;
    if (session.state && session.version !== appliedVersion.current) {
      appliedVersion.current = session.version;
      try {
        g.restore(session.state);
        g.mySide = 1; // 快照里是房主的 0，访客本地翻转视角
        rerender();
      } catch {
        // 快照结构和本端引擎版本不一致（一边没更新就进了房）：不渲染鬼状态
        setStaleSchema(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, session.version]);

  /* host：访客动作 → 引擎执行 */
  useEffect(() => {
    if (!isHost) return;
    bridge.setActionHandler((a: DuelAction) => {
      g.applyAction(a);
    });
    return () => bridge.setActionHandler(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, g, bridge]);

  /* ---------- 把「英雄热区」贴到房间里真实的猪身上 ---------- */
  const measureZones = useCallback(() => {
    const slots = Array.from(document.querySelectorAll<HTMLElement>(".vx-pig-slot"));
    if (!slots.length) {
      setZones({ me: null, foe: null });
      return;
    }
    const read = (el: HTMLElement): Zone => {
      const r = el.getBoundingClientRect();
      return { left: r.left - 8, top: r.top - 10, width: r.width + 16, height: r.height + 20 };
    };
    const label = (el: HTMLElement) => el.querySelector(".vx-pig-hit")?.getAttribute("aria-label") ?? "";
    const mine = slots.find((el) => label(el).includes("（我）") || label(el).includes("你")) ?? slots[0];
    const foeEl = slots.find((el) => el !== mine && label(el).includes(session.opponentName)) ?? slots[slots.length - 1];
    const foeZone: Zone = slots.length >= 2
      ? read(foeEl)
      : { left: window.innerWidth - 150, top: window.innerHeight - 300, width: 112, height: 140 };
    setZones({ me: read(mine), foe: foeZone });
  }, [session.opponentName]);

  useEffect(() => {
    measureZones();
    const t = window.setTimeout(measureZones, 600);
    window.addEventListener("resize", measureZones);
    return () => { window.clearTimeout(t); window.removeEventListener("resize", measureZones); };
  }, [measureZones]);

  /* ---------- 交互（动作去向由角色决定） ---------- */
  const pv = g.mySide;
  const waiting = !isHost && !session.state; // guest 第一份快照没到

  const onCardClick = (i: number) => {
    if (!g.isMyTurn()) return;
    const card = CARD_DB[g.me().hand[i]];
    if (!card) return;
    if (card.cost > g.me().mana) return;
    if (pending?.type === "card" && pending.idx === i) { setPending(null); rerender(); return; }
    if (!card.target || card.target === "none") {
      setPending(null);
      if (isHost) g.playCard(i);
      else bridge.pushAction({ kind: "play", handIdx: i });
      rerender();
      return;
    }
    if (!g.hasValidTarget(card.target)) { setPending(null); rerender(); return; }
    setPending({ type: "card", idx: i });
    rerender();
  };

  const onTarget = (t: Target) => {
    if (!pending || !g.isTargetable(t, pending)) return;
    if (pending.type === "card") {
      const i = pending.idx;
      setPending(null);
      if (isHost) g.playCard(i, t);
      else bridge.pushAction({ kind: "play", handIdx: i, target: t });
    } else {
      const uid = pending.uid;
      setPending(null);
      if (isHost) g.attack(uid, t);
      else bridge.pushAction({ kind: "attack", uid, target: t });
    }
    rerender();
  };

  const onMinionClick = (uid: number) => {
    if (!g.isMyTurn()) return;
    const info = g.findMinionWithSide(uid);
    if (!info) return;
    if (pending) { onTarget({ type: "minion", uid }); return; }
    if (info.side !== pv) return;
    if (!info.m.canAttack) return;
    setPending({ type: "attack", uid });
    rerender();
  };

  /* ---------- 渲染辅助（全部按 pv 视角） ---------- */
  const me = g.players[pv];
  const foe = g.players[(1 - pv) as Side];
  const isMine = g.isMyTurn();
  const foeName = session.opponentName;

  const manaPips = useMemo(() => Array.from({ length: MANA_MAX }, (_, i) => i), []);

  const plate = (p: Player, mine: boolean) => (
    <div className={`duel-plate${mine ? "" : " foe"}`}>
      <div className="duel-avatar">
        {(mine ? myAvatar : foeAvatar)
          ? <img src={(mine ? myAvatar : foeAvatar)} alt="" draggable={false} />
          : <span className="duel-avatar-fallback">{(mine ? myName : foeName).slice(0, 1)}</span>}
      </div>
      <div className="duel-pinfo">
        <div className="duel-pname">{mine ? "我" : foeName}</div>
        <div className="duel-hprow">
          <div className="duel-hpbar"><i style={{ width: `${Math.max(0, (p.hp / p.maxHp) * 100)}%` }} /></div>
          <b className={`duel-hpnum${p.hp <= 10 ? " low" : ""}`}>{Math.max(0, p.hp)}</b>
        </div>
        <div className="duel-mana">
          {manaPips.map((i) => (
            <i key={i} className={`duel-pip${i < p.mana ? " on" : i < p.maxMana ? "" : " locked"}`} />
          ))}
        </div>
        <div className="duel-psub">牌库 {p.deck.length} · 手牌 {p.hand.length}</div>
      </div>
    </div>
  );

  const minionCard = (m: Minion, mine: boolean) => {
    const c = CARD_DB[m.id];
    const ready = mine && m.canAttack && isMine;
    const cls = ["duel-mini"];
    if (m.taunt) cls.push("taunt");
    if (m.frozen) cls.push("frozen");
    if (ready) cls.push("ready");
    if (pending?.type === "attack" && pending.uid === m.uid) cls.push("selected");
    if (g.isTargetable({ type: "minion", uid: m.uid }, pending)) cls.push("target");
    return (
      <button
        key={m.uid}
        type="button"
        className={cls.join(" ")}
        style={{ ["--rar" as string]: RARITY_COLOR[c?.r ?? "n"] }}
        onClick={() => onMinionClick(m.uid)}
      >
        <span className="duel-mini-name">{m.name}</span>
        <span className="duel-mini-icon">{m.icon}</span>
        <span className="duel-mini-atk">{m.atk}</span>
        <span className="duel-mini-hp">{m.hp}</span>
      </button>
    );
  };

  const lane = (board: Minion[], mine: boolean) => (
    <div className={`duel-lane ${mine ? "mine" : "foe"}`}>
      {board.length === 0 ? (
        <span className="duel-lane-empty">{mine ? "你的随从会站在这里" : "对方场上没人"}</span>
      ) : (
        board.map((m) => (
          <div key={m.uid} className="duel-slot filled">{minionCard(m, mine)}</div>
        ))
      )}
    </div>
  );

  const n = me.hand.length;
  const step = n <= 4 ? 106 : STEP_BY_COUNT[n] ?? 58;

  const heroZone = (side: Side) => {
    const z = side === pv ? zones.me : zones.foe;
    const targetable = g.isTargetable({ type: "hero", side }, pending);
    if (!z) return null;
    return (
      <button
        type="button"
        aria-label={side === pv ? "我" : foeName}
        className={`duel-hero-zone${targetable ? " target" : ""}`}
        style={{ left: z.left, top: z.top, width: z.width, height: z.height }}
        onClick={() => { if (pending) onTarget({ type: "hero", side }); }}
      />
    );
  };

  const hpDef = HERO_POWERS[pv];
  const hpReady = isMine && !me.heroPowerUsed && me.mana >= hpDef.cost;
  const hpDesc = me.heroPowerUsed
    ? "本回合已用过"
    : me.mana < hpDef.cost ? `${hpDef.txt} · 法力不足` : `${hpDef.txt} · 每回合 1 次`;

  const usePower = () => {
    if (!hpReady) return;
    setPending(null);
    if (isHost) g.useHeroPower();
    else bridge.pushAction({ kind: "power" });
    rerender();
  };

  const endTurn = () => {
    if (!isMine) return;
    setPending(null);
    if (isHost) g.endTurn();
    else bridge.pushAction({ kind: "end" });
    rerender();
  };

  return createPortal(
    <div className="duel-root">
      <div className="duel-dim" />

      <header className="duel-hud">
        {plate(me, true)}
        <div className="duel-turnbox">
          <div className={`duel-turn-pill${g.over ? "" : isMine ? " mine" : " foe"}`}>
            {g.over ? "对局结束" : isMine ? "你的回合" : `${foeName} 出牌中…`}
          </div>
          <div className="duel-turn-sub">
            {g.over ? "点右下角回到房间" : `第 ${Math.max(me.maxMana, foe.maxMana, 1)} 回合 · 法力 ${g.players[g.cur].mana}/${g.players[g.cur].maxMana}`}
          </div>
        </div>
        {plate(foe, false)}
      </header>

      {heroZone(pv)}
      {heroZone((1 - pv) as Side)}

      <section className="duel-field">
        {lane(foe.board, false)}
        <div className="duel-divider" />
        {lane(me.board, true)}
      </section>

      <div className="duel-log">
        {g.logs.slice(0, 4).map((l, i) => (
          <div key={i} className={l.cls ?? ""}>{l.text}</div>
        ))}
      </div>

      <div className="duel-hand" onMouseLeave={() => setHover(null)}>
        {me.hand.map((id, i) => {
          const c = CARD_DB[id];
          const selected = pending?.type === "card" && pending.idx === i;
          const affordable = c.cost <= me.mana && isMine;
          return (
            <button
              key={`${id}-${i}`}
              type="button"
              className={[
                "duel-card",
                affordable ? "" : "unaffordable",
                selected ? "selected" : "",
              ].join(" ")}
              style={{
                ["--rar" as string]: RARITY_COLOR[c.r],
                ["--type" as string]: TYPE_COLOR[c.t],
                width: 100,
                marginLeft: i === 0 ? 0 : step - 106,
                zIndex: selected ? 61 : i + 1,
              }}
              onClick={() => onCardClick(i)}
              onMouseEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setHover({ id, x: r.left + r.width / 2, y: r.top });
              }}
            >
              <span className="duel-cost">{c.cost}</span>
              <span className="duel-cname">{c.name}</span>
              <span className="duel-ctxt" dangerouslySetInnerHTML={{ __html: bold(c.txt) }} />
              <span className="duel-cfoot">
                {c.kind === "minion" ? (
                  <>
                    <span className="duel-stat atk">{c.atk}</span>
                    <span className="duel-crar">{RARITY_TXT[c.r]}</span>
                    <span className="duel-stat hp">{c.hp}</span>
                  </>
                ) : (
                  <>
                    <span>{TYPE_TXT[c.t]}</span>
                    <span className="duel-crar">{RARITY_TXT[c.r]}</span>
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <footer className="duel-bar">
        <button type="button" className="duel-btn ghost" onClick={onExit}>退出对局</button>
        <div className="duel-hint">
          {pending?.type === "card"
            ? "点红色框住的目标（对方的猪可以点）"
            : pending?.type === "attack"
              ? "选攻击目标"
              : isMine ? "点手牌 → 点目标 · 点自己随从 → 点对方发起攻击" : "等对手操作…"}
        </div>
        <button
          type="button"
          className={`duel-btn power${hpReady ? " on" : ""}`}
          disabled={!hpReady}
          onClick={usePower}
          title={`英雄技能「${hpDef.name}」：消耗 ${hpDef.cost} 点法力，${hpDef.txt}；每回合限一次`}
        >
          <span className="duel-gem">{hpDef.cost}</span>
          <span className="duel-power-body">
            <span className="duel-power-name">{hpDef.name}</span>
            <span className="duel-power-desc">{hpDesc}</span>
          </span>
        </button>
        <button type="button" className="duel-btn primary" disabled={!isMine} onClick={endTurn}>
          结束回合
        </button>
      </footer>

      {hover ? (
        <div className="duel-tip" style={{ left: Math.max(12, Math.min(window.innerWidth - 236, hover.x - 112)), top: Math.max(12, hover.y - 170) }}>
          <div className="duel-tip-name">{CARD_DB[hover.id].name}</div>
          <div className="duel-tip-meta">
            <span>{CARD_DB[hover.id].kind === "minion" ? `${CARD_DB[hover.id].atk} 攻 / ${CARD_DB[hover.id].hp} 血` : "技能"}</span>
            <span>{TYPE_TXT[CARD_DB[hover.id].t]}</span>
            <span>{RARITY_TXT[CARD_DB[hover.id].r]}</span>
            <span>{CARD_DB[hover.id].cost} 费</span>
          </div>
          <div className="duel-tip-eff" dangerouslySetInnerHTML={{ __html: bold(CARD_DB[hover.id].txt) }} />
          {CARD_DB[hover.id].f ? <div className="duel-tip-fl">「{CARD_DB[hover.id].f}」</div> : null}
        </div>
      ) : null}

      {staleSchema ? (
        <div className="duel-result">
          <div className="duel-result-title lose">版本不一致</div>
          <div className="duel-result-sub">你们俩的游戏版本不一样，其中一个人更新后就能继续了。</div>
          <button type="button" className="duel-btn primary" onClick={onExit}>回到语音房</button>
        </div>
      ) : null}

      {waiting && !staleSchema ? <div className="duel-waiting">正在同步牌局…</div> : null}

      {g.over || session.opponentLeft ? (
        <div className="duel-result">
          <div className={`duel-result-title${foe.hp <= 0 ? " win" : " lose"}`}>
            {session.opponentLeft ? "对局结束" : foe.hp <= 0 ? "胜 利" : "败 北"}
          </div>
          <div className="duel-result-sub">
            {session.opponentLeft
              ? `${foeName} 退出了对局`
              : foe.hp <= 0 ? "哈哈，那无敌了！" : "开不出枪阿！！再试一局。"}
          </div>
          <button type="button" className="duel-btn primary" onClick={onExit}>回到语音房</button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
