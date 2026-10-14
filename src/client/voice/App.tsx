import { useEffect } from "react";

import { preloadRnnoise } from "./engine";
import { useVoice } from "./use-voice";
import { ConfirmView, LandingView } from "./components/pages";
import { RoomView } from "./components/RoomView";
import { SettingsView } from "./components/SettingsView";
import { Banner } from "./components/ui";

export function App() {
  const voice = useVoice();

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
      <SettingsView
        identity={voice.identity}
        settings={voice.settings}
        onSave={voice.saveAll}
        onClose={voice.closeSettings}
        onNotice={(kind, text) => voice.setNotice({ kind, text })}
      />
    );
  }

  if (voice.view === "confirm" && voice.pending) {
    return (
      <ConfirmView
        code={voice.pending.code}
        hostId={voice.pending.hostId || voice.pending.code}
        identity={voice.identity}
        joining={voice.status === "preparing" || voice.status === "connecting"}
        error={voice.joinError}
        onJoin={(muted) => void voice.joinRoom(voice.pending!, muted)}
        onCancel={voice.cancelJoin}
        onSettings={voice.openSettings}
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
        screenShare={voice.screenShare}
        shareStream={voice.shareStream}
        onStartShare={(quality) => void voice.startScreenShare(quality)}
        onStopShare={voice.stopScreenShare}
        shareQuality={voice.shareQuality}
        onSetShareQuality={voice.setShareQuality}
        shareTransport={voice.shareTransport}
        onSetShareTransport={voice.setShareTransport}
      />
      {settingsOverRoom ? (
        <div className="vx-overlay-layer">
          <SettingsView
            identity={voice.identity}
            settings={voice.settings}
            onSave={voice.saveAll}
            onClose={voice.closeSettings}
            onNotice={(kind, text) => voice.setNotice({ kind, text })}
          />
        </div>
      ) : null}
      </>
    );
  }

  return (
    <>
      {voice.notice ? (
        <div className="vx-toast-layer">
          <Banner kind={voice.notice.kind} onClose={() => voice.setNotice(null)}>
            {voice.notice.text}
          </Banner>
        </div>
      ) : null}
      <LandingView
        identity={voice.identity}
        onIdentityChange={voice.setIdentity}
        onCreate={() => void voice.createRoom()}
        onJoin={voice.submitJoinInput}
        onSettings={voice.openSettings}
        onCopyId={() => {
          void voice.copyText(voice.identity.personId, "个人 ID 已复制");
        }}
      />
      {voice.ended ? (
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
  );
}
