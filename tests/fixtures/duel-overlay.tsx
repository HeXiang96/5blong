/** 本地目检：把真实的对局覆盖层单独挂出来（不连信令、不建房）。
 *  用途：改卡面 / 抠间距 / 验收对齐时，一眼看到实际渲染结果。
 *  入口：/tests/fixtures/duel-overlay.html
 *  说明：DEV 环境下 useDuel 走 LocalDuelTransport；这里不给真实会话，
 *  传一份静态 host 会话只验渲染，不验交互。 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { DuelOverlay } from "../../src/client/duel/DuelOverlay";
import { useDuel } from "../../src/client/duel/duel-net";
import "../../src/client/duel/duel.css";

function Harness() {
  const [open, setOpen] = useState(true);
  const duel = useDuel("000000", "我");
  const session = duel.session ?? {
    gameId: "fixture",
    room: "000000",
    role: "host" as const,
    phase: "playing" as const,
    version: 0,
    state: null,
    action: null,
    actionSeq: 0,
    opponentName: "测试员3",
    opponentLeft: false,
    iLeft: false,
    opponentIdleMs: 0,
  };
  return open ? (
    <DuelOverlay
      session={session}
      myName="我"
      bridge={duel}
      onExit={() => setOpen(false)}
    />
  ) : (
    <div style={{ display: "grid", placeItems: "center", height: "100vh", font: "14px/1.6 sans-serif", color: "#4b3a28" }}>
      对局已退出。<button type="button" onClick={() => setOpen(true)}>再来一局</button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
