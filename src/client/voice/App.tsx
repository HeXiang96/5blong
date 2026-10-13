import { useEffect } from "react";

import { useVoice } from "./use-voice";
import { ConfirmView, LandingView } from "./components/pages";
import { RoomView } from "./components/RoomView";
import { SettingsView } from "./components/SettingsView";
import { Banner } from "./components/ui";

export function App() {
  const voice = useVoice();

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

  if (voice.view === "settings") {
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

  if (voice.view === "room") {
    return (
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
      />
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
