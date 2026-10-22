/**
 * 开黑圈入口层（懒加载）：`App.tsx` 通过 `React.lazy` 引入，只有真正要用时才加载
 * `use-game` + `game-mesh` + `GameRoomView`（约 2300 行，首屏包因此显著瘦身）。
 *
 * 职责边界：本组件自持开黑圈的全部状态（useGame、建房/加入弹窗、忙碌标记），
 * App 只负责两件事：
 *   1. 传入 `prompt`（null | "create" | "join"）告诉它该弹哪个窗；
 *   2. 接收 `onActiveChange`，在进房后卸载首页——否则首页猪圈那几十个
 *      常驻动画会在开黑的两三个小时里一直在背后烧 CPU。
 */
import { useEffect, useState } from "react";

import { GameCreateDialog, GameJoinDialog, GameRoomView, GameSummaryCard } from "./GameRoomView";
import { gameCodeFromUrl, gameInviteUrl } from "./game-links";
import { useGame } from "./use-game";

type Prompt = "create" | "join" | null;

export function GameEntry({
  prompt,
  onPromptConsumed,
  onActiveChange,
}: {
  prompt: Prompt;
  /** 弹窗关闭或成功进房后调用，让 App 清掉 prompt。 */
  onPromptConsumed: () => void;
  /** 房间/结算界面是否接管整屏；App 据此卸载首页。 */
  onActiveChange: (active: boolean) => void;
}) {
  const game = useGame();
  const [busy, setBusy] = useState(false);
  const [joinCode, setJoinCode] = useState<string | null>(() => gameCodeFromUrl());

  // 进房成功 → 关弹窗（失败留在弹窗里看错误原因）
  useEffect(() => {
    if (game.room) onPromptConsumed();
  }, [game.room, onPromptConsumed]);

  // 整屏接管：房间视图、结算卡片都算（结算在离开后展示，盖在首页之上）
  const active = !!game.room || !!game.summary;
  useEffect(() => {
    onActiveChange(active);
  }, [active, onActiveChange]);

  // 组件卸载（极少数情况）时归还屏幕
  useEffect(() => () => onActiveChange(false), [onActiveChange]);

  useEffect(() => {
    if (game.room) void game.refreshDevices();
  }, [game.room, game.refreshDevices]);

  if (game.summary) {
    return <GameSummaryCard summary={game.summary} onClose={game.clearSummary} />;
  }

  if (game.room) {
    return (
      <GameRoomView
        room={game.room}
        members={game.members}
        scores={game.scores}
        unlocked={game.unlocked}
        muted={game.muted}
        isHost={game.isHost}
        myTeam={game.myTeam}
        error={game.error}
        onDismissError={game.clearError}
        onToggleMute={game.toggleMuted}
        onClaim={game.setMyTeam}
        onAssign={game.hostAssign}
        onKick={game.kick}
        onScore={game.score}
        onResetScores={game.resetScores}
        onToggleCap={game.toggleTeamCap}
        onCopyInvite={() => {
          if (game.room) void navigator.clipboard?.writeText(gameInviteUrl(game.room.code));
        }}
        onLeave={game.closeRoom}
        micBoost={game.micBoost}
        onSetMicBoost={game.setMicBoost}
        nsOn={game.nsOn}
        onToggleNs={game.toggleNs}
        peerVolumes={game.peerVolumes}
        onSetPeerVolume={game.setPeerVolume}
        devices={game.devices}
        micDevice={game.micDevice}
        onSetMicDevice={game.setMicDevice}
        outputDevice={game.outputDevice}
        onSetOutputDevice={game.setOutputDevice}
        speaking={game.speaking}
      />
    );
  }

  /*
   * 被踢 / 房主关房：不进房、也没弹窗时，原来直接 return null —— 界面凭空消失，
   * 玩家不知道自己是被踢了还是房主关了（评审 P1）。给一张明确的结束卡。
   * 只在没有弹窗（!prompt）时接管，避免把建房/加入弹窗里的错误也顶掉。
   */
  if (!prompt && !game.room && (game.kicked || game.error)) {
    return (
      <div className="vx-modal-backdrop">
        <div className="vx-modal" role="alertdialog" aria-label="开黑圈已结束">
          <h3>{game.kicked ? "你已被移出开黑圈" : "开黑圈已结束"}</h3>
          <p className="vx-modal-note">
            {game.kicked
              ? "房主把你移出了这一局。可以让队友重新邀请你进来。"
              : (game.error ?? "房主关闭了开黑圈。")}
          </p>
          <div className="vx-modal-actions">
            <button
              type="button"
              className="vx-btn vx-btn-primary"
              onClick={() => {
                game.dismissKicked();
                game.clearError();
                onPromptConsumed();
              }}
            >
              知道了
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!prompt) return null;

  if (prompt === "create") {
    return (
      <GameCreateDialog
        busy={busy}
        error={game.error}
        onCancel={onPromptConsumed}
        onCreate={(opts) => {
          setBusy(true);
          // 失败时弹窗保持打开显示错误；成功（game.room 就绪）由上面的 effect 关闭
          void game.createRoom(opts).finally(() => setBusy(false));
        }}
      />
    );
  }

  return (
    <GameJoinDialog
      code={joinCode}
      busy={busy}
      error={game.error}
      onCancel={() => {
        setJoinCode(null);
        const url = new URL(window.location.href);
        url.searchParams.delete("g");
        window.history.replaceState(null, "", url.toString());
        onPromptConsumed();
      }}
      onJoin={(opts) => {
        setBusy(true);
        void game.joinRoom({ code: opts.code, gameId: opts.gameId, muted: opts.muted }).finally(() => setBusy(false));
      }}
    />
  );
}
