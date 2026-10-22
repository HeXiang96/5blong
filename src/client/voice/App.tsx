import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { preloadRnnoise } from "./engine";
import { shouldShowOnboarding } from "./onboarding";
import { isJoinInFlight } from "./protocol";
import { useVoice } from "./use-voice";
import { ConfirmView, LandingView, SessionSummaryCard } from "./components/pages";
import { RoomView } from "./components/RoomView";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { OnboardingDialog } from "./components/OnboardingDialog";
import { WhatsNewDialog } from "./components/WhatsNewDialog";
import { shouldShowWhatsNew } from "./whats-new";
import { SettingsView } from "./components/SettingsView";
import { Banner } from "./components/ui";
import { gameCodeFromUrl } from "../game/game-links";
/*
 * 开黑圈整体懒加载（含 useGame 与 1088 行的 game-mesh）：不进首屏包，
 * 只有点击入口或带 ?g= 打开时才下载。首屏 JS 从 568KB 降到预计 400KB 级。
 */
const GameEntry = lazy(() => import("../game/GameEntry").then((m) => ({ default: m.GameEntry })));

export function App() {
  const voice = useVoice();
  /*
   * 开黑圈是**独立子系统**：引擎、状态、界面都不复用语音房
   * （语音房的连接拓扑/共享/猪圈互动对开黑圈都不适用）。
   * 它整体住在懒加载的 <GameEntry/> 里，App 只保留三个轻量状态：
   * 是否挂载、该弹哪个窗、是否已接管整屏（接管时卸载首页，省掉猪圈动画的 CPU）。
   */
  const [gameMounted, setGameMounted] = useState<boolean>(() => !!gameCodeFromUrl());
  const [gamePrompt, setGamePrompt] = useState<"create" | "join" | null>(() =>
    gameCodeFromUrl() ? "join" : null,
  );
  const [gameActive, setGameActive] = useState(false);
  const openGame = useCallback((prompt: "create" | "join") => {
    setGameMounted(true);
    setGamePrompt(prompt);
  }, []);
  const closeGamePrompt = useCallback(() => setGamePrompt(null), []);

  /*
   * 打开页面就预热 AI 降噪（RNNoise）的 wasm/worklet 资源：
   * 不需要麦克风权限，进房开启智能降噪时秒生效。
   */
  useEffect(() => {
    preloadRnnoise();
  }, []);

  /*
   * 把标签页可见性同步到 <html data-vx-hidden>，供样式表停掉挂机时的循环动画。
   * 猪圈的常驻动画有近 40 个（infinite），开黑挂两三个小时时它们一直烧 CPU；
   * 切到后台或最小化时停掉，回来立刻恢复。
   */
  useEffect(() => {
    const sync = () => {
      document.documentElement.dataset["vxHidden"] = document.hidden ? "1" : "0";
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  /*
   * 从**房间里**打开设置：房间保持挂载、设置盖在上面。
   *
   * 曾经的实现是整页切走（early return），后果是房主一进设置，8 个
   * PigActor 全部卸载 → 位置快照清空 → 房主停止广播 → **全房间的猪
   * 瞬间冻结**；回来时整棵重建，还伴随一波挂载卡顿与位置跳变。
   * 现在设置页是覆盖层，猪圈在下面继续走、广播不断，回来无缝。
   */
  const settingsOverRoom = voice.view === "settings" && voice.settingsReturn === "room";

  /*
   * 意见反馈弹窗：三处入口共用一份 state——设置页、错误提示条（带错误原文）、
   * 以及桌面端托盘菜单（Rust 侧发 feedback:open 事件，见下方 effect）。
   */
  const [feedback, setFeedback] = useState<{ open: boolean; errorText?: string }>({ open: false });
  const openFeedback = useCallback((errorText?: string) => setFeedback({ open: true, errorText }), []);
  const closeFeedback = useCallback(() => setFeedback({ open: false }), []);

  /*
   * 首次打开的功能导览：**只在首页**、首帧之后再弹（等场景画出来，不抢首帧）。
   * 通过邀请链接直接进房的人不打扰——那时 view 不是 landing，等他回首页自然会看到。
   * `?tv=demo`（调试/全链路验证）跳过，免得挡着自动开播。
   */
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  useEffect(() => {
    if (voice.view !== "landing") return;
    if (typeof location !== "undefined" && /[?&]tv=demo/.test(location.search)) return;
    if (!shouldShowOnboarding()) return;
    const timer = window.setTimeout(() => setOnboardingOpen(true), 500);
    return () => window.clearTimeout(timer);
  }, [voice.view]);
  const closeOnboarding = useCallback(() => setOnboardingOpen(false), []);
  const closeWhatsNew = useCallback(() => setWhatsNewOpen(false), []);

  /*
   * 大更新公告：只在首页、且导览没弹的时候弹，避免两个弹窗叠一起。
   * 导览关掉之后会重新跑一遍（依赖 onboardingOpen）。
   */
  useEffect(() => {
    if (voice.view !== "landing") return;
    if (onboardingOpen) return;
    if (typeof location !== "undefined" && /[?&]tv=demo/.test(location.search)) return;
    if (!shouldShowWhatsNew()) return;
    const timer = window.setTimeout(() => setWhatsNewOpen(true), 700);
    return () => window.clearTimeout(timer);
  }, [voice.view, onboardingOpen]);
  useEffect(() => {
    const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isDesktop) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("feedback:open", () => setFeedback({ open: true })))
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {
        /* 事件桥不可用不影响设置页里的入口 */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /*
   * "正在进房"的统一定义（preparing / connecting / reconnecting），
   * 首页与确认页共用一份。reconnecting 必须算进来：那是超时后的自动整体重拨，
   * 以前不认它，确认页会在那 24 秒里把按钮变回"加入并开麦"，看着像没在连。
   */
  const joinInFlight = isJoinInFlight(voice.status);

  /*
   * 桌面端标题栏颜色跟随主题与时段（覆盖层/房间/首页都协调）：
   * 深色外观跟 --vx-bg，浅色外观跟各时段天空顶色。
   * 用 MutationObserver 监听 html 属性变化，主题/时段一变就同步。
   */
  useEffect(() => {
    const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isDesktop) return;
    const SKY_TOP: Record<string, string> = {
      morning: "#f9e9e3",
      day: "#f7e9d4",
      dusk: "#f8e3c8",
      night: "#171c2c",
    };
    const apply = () => {
      const theme = document.documentElement.dataset.theme;
      const daypart = document.documentElement.dataset.daypart ?? "day";
      const color =
        theme === "dark" ? "#14110d" : (SKY_TOP[daypart] ?? "#f7e9d4");
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("set_window_bg", { color }))
        .catch(() => {});
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-daypart"],
    });
    return () => observer.disconnect();
  }, []);

  if (voice.view === "settings" && !settingsOverRoom) {
    return (
      <>
        <SettingsView
          identity={voice.identity}
          settings={voice.settings}
          onSave={voice.saveAll}
          onClose={voice.closeSettings}
          onNotice={(kind, text) => voice.setNotice({ kind, text })}
          onOpenFeedback={openFeedback}
          onOpenOnboarding={() => setOnboardingOpen(true)}
          onExportDiagnostics={() => void voice.exportDiagnostics()}
        />
        <FeedbackDialog
          open={feedback.open}
          errorText={feedback.errorText}
          onCollectDiagnostics={voice.collectDiagnostics}
          onClose={closeFeedback}
        />
        <OnboardingDialog open={onboardingOpen} onClose={closeOnboarding} />
        <WhatsNewDialog open={whatsNewOpen} onClose={closeWhatsNew} />
      </>
    );
  }

  // ---------------------------------------------------------------- 开黑圈
  /*
   * 懒加载图层：挂载后常驻（进出房间不重建引擎）；gameActive（房间/结算接管整屏）
   * 时首页整体卸载，避免猪圈那几十个常驻动画在开黑的两三个小时里背后空转。
   */
  const gameLayer = gameMounted ? (
    <Suspense fallback={null}>
      <GameEntry prompt={gamePrompt} onPromptConsumed={closeGamePrompt} onActiveChange={setGameActive} />
    </Suspense>
  ) : null;

  if (voice.view === "confirm" && voice.pending) {
    return (
      <ConfirmView
        code={voice.pending.code}
        hostId={voice.pending.hostId || voice.pending.code}
        identity={voice.identity}
        joining={joinInFlight}
        error={voice.joinError}
        onJoin={(muted) => void voice.joinRoom(voice.pending!, muted)}
        onCancel={voice.cancelJoin}
        onSettings={voice.openSettings}
        settings={voice.settings}
      />
    );
  }

  if (voice.view === "room" || settingsOverRoom) {
    return (
      <>
      <RoomView
        status={voice.status}
        members={voice.members}
        speaking={voice.speaking}
        messages={voice.messages}
        invite={voice.invite}
        notice={voice.notice}
        audioBlocked={voice.audioBlocked}
        onResumeAudio={voice.resumeAudio}
        chatOpen={voice.chatOpen}
        unread={voice.unread}
        displayNames={voice.displayNames}
        isHost={voice.invite !== null}
        maxMembers={voice.maxMembers}
        onCopyCode={() => {
          if (voice.invite) {
            void voice.copyText(voice.invite.code, `房间码 ${voice.invite.code} 已复制`);
          }
        }}
        onCopyInvite={voice.copyInvite}
        onToggleMute={voice.toggleMute}
        onToggleChat={voice.toggleChat}
        onLeave={voice.leave}
        onSettings={voice.openSettings}
        onSend={voice.sendChat}
        onDismissNotice={() => voice.setNotice(null)}
        micVolume={voice.micVolume}
        onSetMicVolume={voice.setMicVolume}
        onSetPeerVolume={voice.setPeerVolume}
        onTogglePeerMuted={voice.togglePeerMuted}
        onGetPeerAudio={voice.getPeerAudio}
        processing={voice.processing}
        captureLive={voice.captureLive}
        penEvents={voice.penEvents}
        onReportPenActor={voice.reportPenActor}
        getPenPosition={voice.getPenPosition}
        onSetNoiseSuppression={voice.setNoiseSuppression}
        onSetProcessingFlag={voice.setProcessingFlag}
        mediaStates={voice.mediaStates}
        roomLocked={voice.roomLocked}
        deaf={voice.deaf}
        interactions={voice.interactions}
        feedCounts={voice.feedCounts}
        onToggleDeaf={voice.toggleDeaf}
        onKick={voice.kickMember}
        onForceMute={voice.forceMute}
        onToggleLock={voice.toggleRoomLock}
        onInteract={voice.interact}
        onRetryLink={voice.retryMemberLink}
        topic={voice.topic}
        onSetTopic={voice.setRoomTopic}
        sceneTheme={voice.sceneTheme}
        onSetSceneTheme={voice.setRoomSceneTheme}
        screenShare={voice.screenShare}
        shareStream={voice.shareStream}
        sharePc={voice.sharePc}
        onStartShare={(quality) => void voice.startScreenShare(quality)}
        onStopShare={voice.stopScreenShare}
        shareQuality={voice.shareQuality}
        onSetShareQuality={voice.setShareQuality}
        shareTransport={voice.shareTransport}
        onSetShareTransport={voice.setShareTransport}
        shareAudio={voice.shareAudio}
        onSetShareAudio={voice.setShareAudio}
        shareAppPid={voice.shareAppPid}
        onSetShareAppPid={voice.setShareAppPid}
        shareLatency={voice.shareLatency}
        onSetShareLatency={voice.setShareLatency}
        shareViewMode={voice.shareViewMode}
        onSetShareViewMode={voice.setShareViewMode}
        onOpenFeedback={openFeedback}
      />
      {settingsOverRoom ? (
        <div className="vx-overlay-layer">
          <SettingsView
            identity={voice.identity}
            settings={voice.settings}
            onSave={voice.saveAll}
            onClose={voice.closeSettings}
            onNotice={(kind, text) => voice.setNotice({ kind, text })}
            onOpenFeedback={openFeedback}
            onOpenOnboarding={() => setOnboardingOpen(true)}
          onExportDiagnostics={() => void voice.exportDiagnostics()}
          />
        </div>
      ) : null}
      <FeedbackDialog
          open={feedback.open}
          errorText={feedback.errorText}
          onCollectDiagnostics={voice.collectDiagnostics}
          onClose={closeFeedback}
        />
      <OnboardingDialog open={onboardingOpen} onClose={closeOnboarding} />
      <WhatsNewDialog open={whatsNewOpen} onClose={closeWhatsNew} />
      </>
    );
  }

  return (
    <>
      {/*
       * gameActive（开黑圈房间/结算接管整屏）时整块卸载：猪圈常驻动画不再空转。
       * 条件分支占一个固定子槽位，gameLayer 的挂载位置因此保持稳定——React 不会
       * 因为首页卸载而重建 GameEntry（否则游戏引擎会被销毁重连）。
       */}
      {gameActive ? null : (
        <>
          {voice.notice ? (
            <div className="vx-toast-layer">
              <Banner kind={voice.notice.kind} onClose={() => voice.setNotice(null)}>
                {voice.notice.text}
              </Banner>
            </div>
          ) : null}
          <FeedbackDialog
          open={feedback.open}
          errorText={feedback.errorText}
          onCollectDiagnostics={voice.collectDiagnostics}
          onClose={closeFeedback}
        />
          <OnboardingDialog open={onboardingOpen} onClose={closeOnboarding} />
      <WhatsNewDialog open={whatsNewOpen} onClose={closeWhatsNew} />
          <LandingView
            identity={voice.identity}
            onIdentityChange={voice.setIdentity}
            onCreate={() => void voice.createRoom()}
            onJoin={voice.submitJoinInput}
            onSettings={voice.openSettings}
            onCopyId={() => {
              void voice.copyText(voice.identity.personId, "个人 ID 已复制");
            }}
            joining={joinInFlight}
            retrying={voice.status === "reconnecting"}
            error={voice.joinError}
            onCancelJoin={voice.cancelJoin}
            onDismissError={() => voice.setJoinError(null)}
            lastRoom={voice.lastRoom}
            onResumeLastRoom={() => void voice.resumeLastRoom()}
            onCreateGame={() => openGame("create")}
            onJoinGame={() => openGame("join")}
          />
          {voice.lastSummary ? (
            <SessionSummaryCard summary={voice.lastSummary} onClose={voice.dismissEnded} />
          ) : voice.ended ? (
            <div className="vx-overlay">
              <div className="vx-overlay-card">
                <p>
                  {voice.ended.reason === "host-left"
                    ? "房主已离开，房间已结束"
                    : voice.ended.detail ?? "连接已结束"}
                </p>
              </div>
            </div>
          ) : null}
        </>
      )}
      {gameLayer}
    </>
  );
}
