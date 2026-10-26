import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { preloadRnnoise } from "./engine";
import { shouldShowOnboarding } from "./onboarding";
import { isJoinInFlight, makeRoomCode, randomIndex } from "./protocol";
import { ensureRoomKey, normalizeFixedRoomCode } from "./my-room";
import { useVoice } from "./use-voice";
import { ConfirmView, LandingView, SessionSummaryCard } from "./components/pages";
import { RoomView } from "./components/RoomView";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { OnboardingDialog } from "./components/OnboardingDialog";
import { WhatsNewDialog } from "./components/WhatsNewDialog";
import { shouldShowWhatsNew } from "./whats-new";
import { SettingsView } from "./components/SettingsView";
import { AccountDialog, FriendsDrawer } from "./components/AccountPanels";
import { FriendRequestToast } from "./components/FriendRequestToast";
import { buildInviteText } from "./invite-text";
import { LocalAccountAdapter, seedDemoAccounts } from "./account/local-adapter";
import { WorkerAccountAdapter } from "./account/worker-adapter";
import { useAccount } from "./account/use-account";
import { ACCOUNT_ERROR_TEXT, type AccountProfile, type RoomInvite } from "./account/types";
import { Banner } from "./components/ui";
import { gameCodeFromUrl } from "../game/game-links";
/*
 * 开黑圈整体懒加载（含 useGame 与 1088 行的 game-mesh）：不进首屏包，
 * 只有点击入口或带 ?g= 打开时才下载。首屏 JS 从 568KB 降到预计 400KB 级。
 */
const GameEntry = lazy(() => import("../game/GameEntry").then((m) => ({ default: m.GameEntry })));

export function App() {
  /*
   * 账号是**可选增强层**：不登录一切照旧。
   * - 线上：WorkerAccountAdapter（Pages Worker 的 /api/account，数据在 D1）；
   * - 本地 vite dev：没有 Worker，用 LocalAccountAdapter 演示（两个窗口 = 两台设备）；
   * - `?local-account=1` 可在线上强制用本地适配器（调试用，不影响别人）。
   */
  const [accountAdapter] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const forceLocal = import.meta.env.DEV || params.has("local-account");
    if (!forceLocal) return new WorkerAccountAdapter();
    const adapter = new LocalAccountAdapter();
    // 预览入口：?account=demo 时种两个演示账号，一个人也能点完加好友闭环
    // 注意：URL 是 ?account=demo，键是 account、值是 demo —— 不能写成 params.has("account=demo")
    if (params.get("account") === "demo" && !sessionStorage.getItem("5blong.demoSeeded")) {
      // 只种一次并刷新一次，避免死循环
      sessionStorage.setItem("5blong.demoSeeded", "1");
      void seedDemoAccounts().then(() => window.location.reload());
    }
    return adapter;
  });
  const account = useAccount(accountAdapter);
  const [accountOpen, setAccountOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  /*
   * 房间内收到好友请求：排一条轻提示，能就地同意（不用退出房间去好友面板）。
   * seen 记录已经提示过的账号，避免每次刷新重复弹。
   */
  const [incomingQueue, setIncomingQueue] = useState<string[]>([]);
  const seenRequests = useRef<Set<string>>(new Set());

  const voice = useVoice();

  /*
   * 固定房号「我的房间 235417」**只属于登录账号**（业主 2026-10-26 口径）：
   * - 房号存在账号档案里（accountAdapter.updateProfile({ roomCode })），换设备登录
   *   同一个账号还是这个号；
   * - 房间钥匙存在本机、按账号分开（my-room.ts）——它只给邀请链接签证明；
   * - 未登录 → 开的是随机房号的一次性房间，首页也不会出现「我的房间」。
   */
  const myRoomCode = account.me?.roomCode ?? null;

  /**
   * 好友发来的房间邀请。
   *
   * 业主口径（2026-10-26）：**不能只靠弹窗**——没看见、在忙、关了电脑就耽误了。
   * 所以邀请存在后端（room_invites），这里每 8 秒拉一次，好友抽屉里留档，
   * 顶栏「好友」图标上的红点把「请求 + 邀请」一起算进去。
   */
  const [invites, setInvites] = useState<RoomInvite[]>([]);
  useEffect(() => {
    if (!account.me) {
      setInvites([]);
      return;
    }
    let alive = true;
    const load = () => {
      void accountAdapter.invites().then((list) => {
        if (alive) setInvites(list);
      });
    };
    load();
    const timer = window.setInterval(load, 8_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [account.me?.id, accountAdapter]);

  /*
   * 在线心跳：登录后每 30 秒报一次（在房间里带上房号）。
   * 没有这一步，好友面板里所有人永远是"离线"——「谁在线 / 在 235417 房」全靠它。
   */
  useEffect(() => {
    if (!account.me) return;
    const room = voice.invite?.code;
    accountAdapter.heartbeat(room);
    const timer = window.setInterval(() => accountAdapter.heartbeat(room), 30_000);
    return () => window.clearInterval(timer);
  }, [account.me?.id, voice.invite?.code, accountAdapter]);

  /** 加入邀请：先消掉这条记录，再走正常的进房流程（私密房会就地要临时密码）。 */
  const joinInvite = useCallback(
    (invite: RoomInvite) => {
      setInvites((list) => list.filter((item) => item.from.id !== invite.from.id));
      void accountAdapter.dismissInvite(invite.from.id);
      setFriendsOpen(false);
      voice.submitJoinInput(invite.code);
    },
    [accountAdapter, voice],
  );

  const dismissInvite = useCallback(
    (invite: RoomInvite) => {
      setInvites((list) => list.filter((item) => item.from.id !== invite.from.id));
      void accountAdapter.dismissInvite(invite.from.id);
    },
    [accountAdapter],
  );

  /**
   * 邀请好友进我这间房：
   * 先走推送（对方好友面板里会留一条记录，离线也不丢）；推送不了才退回复制文案。
   * 私密房还要额外把临时密码告诉他——密码不进库，只能房主自己发。
   */
  const inviteFriend = useCallback(
    async (target: AccountProfile) => {
      const code = voice.invite?.code;
      if (!code) return false;
      const result = await accountAdapter.sendInvite(target.id, code);
      if (!result.error) {
        const pass = voice.privateRoom ? voice.guestPass : "";
        voice.setNotice({
          kind: "info",
          text: pass
            ? `已邀请 ${target.name}；这是私密房，记得把临时密码 ${pass} 也发给他`
            : `已邀请 ${target.name}，他在好友面板的「邀请」里能看到`,
        });
        return true;
      }
      // 推送不通（还不是好友 / 后端未上线）→ 退回"复制文案"，别让按钮点了没反应
      return voice.copyText(
        buildInviteText(code, {
          count: voice.members.length,
          topic: voice.topic,
          pass: voice.privateRoom && voice.guestPass ? voice.guestPass : undefined,
        }),
        "已复制邀请，直接发给他",
      );
    },
    [accountAdapter, voice],
  );

  /** 主操作：有账号就开自己那间，没登录就随手开一间。 */
  const startRoom = useCallback(async () => {
    const me = account.me;
    if (!me) {
      await voice.createRoom();
      return;
    }
    let code = me.roomCode ?? "";
    if (!code) {
      // 第一次开房才分配房号：不登录不占号，登录了也只占一个。
      const fresh = makeRoomCode(randomIndex);
      const result = await accountAdapter.updateProfile({ roomCode: fresh });
      if (result.account) {
        code = fresh;
        void account.refresh();
      } else {
        // 极少见（本机存储写不进去）：这次先开随机房，下次再试
        voice.setNotice({ kind: "error", text: "房号没能存进账号，这次先开一间临时的" });
      }
    }
    // 自己账号的固定房号 = 私密房：只认邀请链接或临时密码（业主 2026-10-26 口径）
    await voice.createRoom(code ? { code, roomKey: ensureRoomKey(me.id), private: true } : undefined);
  }, [account, accountAdapter, voice]);

  /** 手填固定房号（6 位）。被别的账号占了就返回 false，让首页就地报错。 */
  const claimRoomCode = useCallback(
    async (raw: string) => {
      const me = account.me;
      if (!me) return false;
      const code = normalizeFixedRoomCode(raw);
      if (!code) return false;
      const result = await accountAdapter.updateProfile({ roomCode: code });
      if (result.error) {
        // 别只回 false：被占用和已锁定要让人分清（前者还能换，后者没机会了）
        voice.setNotice({ kind: "error", text: ACCOUNT_ERROR_TEXT[result.error] });
        return false;
      }
      void account.refresh();
      voice.setNotice({ kind: "info", text: `固定房号已改成 ${code}` });
      return true;
    },
    [account, accountAdapter, voice],
  );


  // 账号 ID 只用于「加好友」：登录/退出时同步给引擎，不参与任何进房校验
  useEffect(() => {
    voice.setAccountId(account.me?.id ?? null);
  }, [account.me?.id, voice.setAccountId]);

  // 发现"新的"好友请求 → 入队（同一个账号只提示一次）
  useEffect(() => {
    const fresh = account.snapshot.incoming
      .map((request) => request.account.id)
      .filter((id) => !seenRequests.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seenRequests.current.add(id);
    setIncomingQueue((queue) => [...queue, ...fresh]);
  }, [account.snapshot.incoming]);

  /*
   * 登录后昵称/头像跟随账号（2026-10-26 反馈："房间里的名字和外面不同步"）。
   * 账号是权威，房间只是展示——所以登录时把本地身份对齐到账号，
   * 而不是反过来。未登录时仍然用本地昵称，行为不变。
   */
  useEffect(() => {
    const me = account.me;
    if (!me) return;
    if (voice.identity.name === me.name && voice.identity.avatar === me.avatar) return;
    voice.setIdentity({ ...voice.identity, name: me.name, avatar: me.avatar });
  }, [account.me, voice.identity, voice.setIdentity]);
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
        selfAccountId={account.me?.id ?? null}
        onOpenAccount={() => setAccountOpen(true)}
        friendRequestCount={account.snapshot.incoming.length + invites.length}
        onOpenFriends={() => setFriendsOpen(true)}
        friendAccountIds={new Set(account.snapshot.friends.map((entry) => entry.account.id))}
        onAddFriend={(accountId) =>
          accountAdapter.addFriend(accountId).then((result) => {
            void account.refresh();
            return !result.error;
          })
        }
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
          // 把真实结果交回给界面：只有复制成功才打勾（评审 #6）
          if (!voice.invite) return Promise.resolve(false);
          return voice.copyText(voice.invite.code, `房间码 ${voice.invite.code} 已复制`);
        }}
        onCopyInvite={voice.copyInvite}
        privateRoom={voice.privateRoom}
        guestPass={voice.guestPass}
        onRenewGuestPass={voice.renewGuestPass}
        onCloseGuestPass={voice.closeGuestPass}
        onCopyPassInvite={voice.copyPassInvite}
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
        onWatchScreen={voice.setScreenWatch}
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

      {/*
        房间里同样要挂账号/好友面板（2026-10-26 修"点了好友没反应"）：
        房间这条分支是**提前 return** 的，之前这些面板只写在首页分支里，
        所以房间里的按钮点了什么也不会发生。
      */}
      {incomingQueue.length > 0
        ? (() => {
            const request = account.snapshot.incoming.find(
              (item) => item.account.id === incomingQueue[0],
            );
            if (!request) return null;
            return (
              <FriendRequestToast
                request={request}
                onAccept={() => {
                  const id = request.account.id;
                  setIncomingQueue((queue) => queue.filter((item) => item !== id));
                  void accountAdapter.acceptFriend(id).then(() => account.refresh());
                }}
                onDismiss={() => setIncomingQueue((queue) => queue.slice(1))}
              />
            );
          })()
        : null}
      <AccountDialog
        open={accountOpen}
        adapter={accountAdapter}
        account={account.me}
        onClose={() => setAccountOpen(false)}
        onChanged={() => void account.refresh()}
        onOpenFriends={() => {
          setAccountOpen(false);
          setFriendsOpen(true);
        }}
      />
      <FriendsDrawer
        open={friendsOpen}
        adapter={accountAdapter}
        snapshot={account.snapshot}
        onClose={() => setFriendsOpen(false)}
        onChanged={() => void account.refresh()}
        roomCode={voice.invite?.code ?? null}
        canInvite={voice.members.some((member) => member.local && member.isHost)}
        onInvite={inviteFriend}
        invites={invites}
        onJoinInvite={joinInvite}
        onDismissInvite={dismissInvite}
      />
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
            // 主按钮：临时房（主流）；「我的房间」走 onStartMyRoom
            onCreate={() => void voice.createRoom()}
            onStartMyRoom={() => void startRoom()}
            onJoin={voice.submitJoinInput}
            onSettings={voice.openSettings}
            sceneTheme={voice.sceneTheme}
            onSetSceneTheme={voice.setRoomSceneTheme}
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
            myRoom={
              myRoomCode
                ? { code: myRoomCode, locked: account.me?.roomCodeLocked === true }
                : null
            }
            onClaimMyRoom={claimRoomCode}
            needsPass={voice.needsPass}
            account={account.me}
            friendRequests={account.snapshot.incoming.length + invites.length}
            onOpenAccount={() => setAccountOpen(true)}
            onOpenFriends={() => setFriendsOpen(true)}
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
      {/*
        房间内的好友请求提示：一条轻卡片，8 秒自动收起；
        点「同意」就地完成，不用退出房间。只在房间里出现，首页不打扰。
      */}
      {incomingQueue.length > 0
        ? (() => {
            const request = account.snapshot.incoming.find(
              (item) => item.account.id === incomingQueue[0],
            );
            if (!request) return null;
            return (
              <FriendRequestToast
                request={request}
                onAccept={() => {
                  const id = request.account.id;
                  setIncomingQueue((queue) => queue.filter((item) => item !== id));
                  void accountAdapter.acceptFriend(id).then(() => account.refresh());
                }}
                onDismiss={() => setIncomingQueue((queue) => queue.slice(1))}
              />
            );
          })()
        : null}

      {gameLayer}

      {/* 账号 / 好友：与房间逻辑完全解耦，关闭即回到原来的界面 */}
      <AccountDialog
        open={accountOpen}
        adapter={accountAdapter}
        account={account.me}
        onClose={() => setAccountOpen(false)}
        onChanged={() => void account.refresh()}
        onOpenFriends={() => {
          setAccountOpen(false);
          setFriendsOpen(true);
        }}
      />
      <FriendsDrawer
        open={friendsOpen}
        adapter={accountAdapter}
        snapshot={account.snapshot}
        onClose={() => setFriendsOpen(false)}
        onChanged={() => void account.refresh()}
        roomCode={voice.invite?.code ?? null}
        canInvite={voice.members.some((member) => member.local && member.isHost)}
        onInvite={inviteFriend}
        invites={invites}
        onJoinInvite={joinInvite}
        onDismissInvite={dismissInvite}
      />
    </>
  );
}
